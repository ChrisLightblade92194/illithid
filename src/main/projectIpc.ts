/**
 * IPC handlers of the Windows project import and delivery (spec 2026-10-06 project delivery §Preview, Apply and
 * restore guarantees, §Integration and UI boundaries). Requests are single objects with exactly their keys; the
 * renderer names backend-issued ids (census run and items, jobs) — never a source or destination path. Validation
 * happens before any filesystem access. Jobs live in memory for the session; a job's result stays pollable after a
 * cancellation, so partial work is shown as it is. Other platforms refuse every project channel without reading.
 */
import { randomUUID } from 'node:crypto'
import { discoverProjects } from '../engine/census/paths'
import { CensusError, type DiscoveryHandle } from '../engine/census/types'
import { acquireApplyLock } from '../engine/globalOperations'
import { importProjectItems } from '../engine/project/import'
import { applyProjectPlan, listProjectOperations } from '../engine/project/operations'
import { decideProjectPlan, discardProjectPlan, planProjectDelivery } from '../engine/project/plan'
import { planProjectRestore } from '../engine/project/restore'
import { forgetProjectDelivery } from '../engine/project/state'
import {
  ProjectError,
  type CensusImportAccess,
  type ProjectDecision,
  type ProjectJobView,
  type ProjectOperationRecord,
  type ProjectPlanView,
  type ProjectSelection
} from '../engine/project/types'
import {
  PROJECT_CHANNELS as PROJECT_CHANNEL_LIST,
  type GlobalResult,
  type PROJECT_CHANNELS
} from '../shared/api'

type ProjectChannel = (typeof PROJECT_CHANNELS)[number]
type ProjectHandlers = Record<ProjectChannel, (...args: unknown[]) => Promise<unknown>>

const invalid = (message: string): ProjectError => new ProjectError('invalid', message)

/** The single request object of a channel, with exactly these keys */
export function request(args: unknown[], keys: readonly string[]): Record<string, unknown> {
  const [o] = args
  if (args.length !== 1 || typeof o !== 'object' || o === null || Array.isArray(o))
    throw invalid('A single request object is expected.')
  const own = Object.keys(o)
  const wrong = [
    ...own.filter((k) => !keys.includes(k)),
    ...keys.filter((k) => !own.includes(k)).map((k) => `missing ${k}`)
  ]
  if (wrong.length) throw invalid(`Unexpected request keys: ${wrong.join(', ')}`)
  return o as Record<string, unknown>
}

export function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw invalid(`${what} must be a non-empty string.`)
  return v
}

/** A non-empty list of distinct non-empty strings */
export function idList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw invalid(`Select at least one ${what}.`)
  const out = v.map((x) => text(x, `${what} id`))
  if (new Set(out).size !== out.length) throw invalid(`A ${what} is selected twice.`)
  return out
}

export async function wrap<T>(fn: () => Promise<T>): Promise<GlobalResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (e instanceof ProjectError || e instanceof CensusError)
      return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: 'error', message: (e as Error)?.message ?? String(e) }
  }
}

interface Job {
  view: ProjectJobView
  controller: AbortController
}

type ImportJob = Extract<ProjectJobView, { kind: 'import' }>
type ApplyJob = Extract<ProjectJobView, { kind: 'apply' }>

const copy = (v: ProjectJobView): ProjectJobView => JSON.parse(JSON.stringify(v)) as ProjectJobView

export function projectHandlers(
  home: string,
  access: CensusImportAccess,
  platform: NodeJS.Platform = process.platform
): ProjectHandlers {
  if (platform !== 'win32') {
    const refuse = async (): Promise<GlobalResult<never>> => ({
      ok: false,
      code: 'unsupportedPlatform',
      message: 'Project import and delivery are available on Windows only.'
    })
    return Object.fromEntries(PROJECT_CHANNEL_LIST.map((c) => [c, refuse])) as ProjectHandlers
  }
  const jobs = new Map<string, Job>()
  const job = (args: unknown[]): Job => {
    const id = text(request(args, ['jobId']).jobId, 'jobId')
    const j = jobs.get(id)
    if (!j) throw new ProjectError('notFound', 'No such job in this session.')
    return j
  }

  return {
    projectImportStart: (...args) =>
      wrap(async () => {
        const o = request(args, ['runId', 'itemIds'])
        const runId = text(o.runId, 'runId')
        const itemIds = idList(o.itemIds, 'item')
        const lease = access.acquireImport(runId, itemIds)
        let view: ImportJob = {
          id: `job-${randomUUID()}`,
          kind: 'import',
          status: 'running',
          progress: { done: 0, total: itemIds.length }
        }
        const j: Job = { controller: new AbortController(), view }
        const set = (next: ImportJob): void => {
          // A cancel request recorded on the shared view is kept
          view = { ...next, ...(j.view.cancelRequested ? { cancelRequested: true } : {}) }
          j.view = view
        }
        jobs.set(view.id, j)
        // Rejection handling is attached before the job can settle: a failure becomes a failed job
        importProjectItems({ home, signal: j.controller.signal }, lease, {
          onProgress: (done, total) => {
            if (view.status === 'running') set({ ...view, progress: { done, total } })
          }
        }).then(
          (result) =>
            set({
              ...view,
              status: result.status === 'cancelled' ? 'cancelled' : 'completed',
              result
            }),
          (e: unknown) =>
            set({ ...view, status: 'failed', reason: (e as Error)?.message ?? String(e) })
        )
        return { jobId: j.view.id }
      }),
    projectPoll: (...args) => wrap(async () => copy(job(args).view)),
    projectCancel: (...args) =>
      wrap(async () => {
        const j = job(args)
        if (j.view.status === 'running') {
          j.controller.abort()
          j.view = { ...j.view, cancelRequested: true }
        }
        return copy(j.view)
      }),
    ...deliveryHandlers(home, jobs)
  }
}

/** Plan ids issued in this session (by a preview, a decision or a restore preview), not yet spent here */
interface DeliverySession {
  discovery: DiscoveryHandle | null
  /** Bumped by every discovery: a pending older one finds itself superseded */
  generation: number
  plans: Set<string>
  /** Sync previews made under the current discovery (spent when a new discovery supersedes it) */
  discoveryPlans: Set<string>
  /** Previews whose decision is pending: a discard or a new discovery (for a sync preview) invalidates them */
  pending: Map<string, { sync: boolean; valid: boolean }>
}

const staleRequest = (what: string): ProjectError =>
  new ProjectError('stale', what + ' was replaced, used or never issued here: make a new preview.')

function deliveryHandlers(
  home: string,
  jobs: Map<string, Job>
): Omit<ProjectHandlers, 'projectImportStart' | 'projectPoll' | 'projectCancel'> {
  const s: DeliverySession = {
    discovery: null,
    generation: 0,
    plans: new Set(),
    discoveryPlans: new Set(),
    pending: new Map()
  }
  const ctx = (): { home: string; signal: AbortSignal } => ({
    home,
    signal: new AbortController().signal
  })
  /** Spends a plan of this session (nothing in any project is written) */
  const spend = (planId: string): void => {
    s.plans.delete(planId)
    s.discoveryPlans.delete(planId)
    try {
      discardProjectPlan(home, planId)
    } catch {
      // already spent or gone
    }
  }
  const issued = (planId: string, sync: boolean): void => {
    s.plans.add(planId)
    if (sync) s.discoveryPlans.add(planId)
  }
  /** A pending decision's preview is spent now; its outcome is refused when it settles */
  const invalidate = (planId: string): void => {
    const p = s.pending.get(planId)
    if (!p) return
    p.valid = false
    spend(planId)
  }
  return {
    projectDiscover: (...args) =>
      wrap(async () => {
        const root = text(request(args, ['root']).root, 'root')
        const gen = ++s.generation
        for (const id of [...s.discoveryPlans]) spend(id)
        for (const [id, p] of s.pending) if (p.sync) invalidate(id)
        s.discovery = null
        const d = await discoverProjects(root)
        if (gen !== s.generation) throw staleRequest('This listing')
        s.discovery = d
        return d.view
      }),
    projectPreview: (...args) =>
      wrap(async () => {
        const o = request(args, ['discoveryId', 'selections'])
        const discoveryId = text(o.discoveryId, 'discoveryId')
        const d = s.discovery
        if (!d || d.view.id !== discoveryId) throw staleRequest('This listing')
        const view = await planProjectDelivery(ctx(), d, o.selections as ProjectSelection[])
        if (s.discovery !== d) {
          spend(view.id)
          throw staleRequest('This listing')
        }
        issued(view.id, true)
        return view
      }),
    projectDecide: (...args) =>
      wrap(async () => {
        const o = request(args, ['planId', 'decisions'])
        const planId = text(o.planId, 'planId')
        if (!s.plans.has(planId)) throw staleRequest('This preview')
        const p = { sync: s.discoveryPlans.has(planId), valid: true }
        s.plans.delete(planId)
        s.discoveryPlans.delete(planId)
        s.pending.set(planId, p)
        let view: ProjectPlanView
        try {
          view = await decideProjectPlan(ctx(), planId, o.decisions as ProjectDecision[])
        } catch (e) {
          // Discarded or superseded meanwhile: never given back
          if (!p.valid) throw staleRequest('This preview')
          // An invalid decision leaves the preview usable; anything else spent it
          if (e instanceof ProjectError && e.code === 'invalid') issued(planId, p.sync)
          throw e
        } finally {
          s.pending.delete(planId)
        }
        // The successor of a preview discarded or superseded meanwhile is obsolete: spent, not issued
        if (!p.valid) {
          spend(view.id)
          throw staleRequest('This preview')
        }
        issued(view.id, p.sync)
        return view
      }),
    projectApplyStart: (...args) =>
      wrap(async () => {
        const planId = text(request(args, ['planId']).planId, 'planId')
        if (!s.plans.has(planId)) throw staleRequest('This preview')
        s.plans.delete(planId)
        s.discoveryPlans.delete(planId)
        let view: ApplyJob = {
          id: 'job-' + randomUUID(),
          kind: 'apply',
          status: 'running',
          progress: { done: 0, total: 0 }
        }
        const j: Job = { controller: new AbortController(), view }
        const set = (next: ApplyJob): void => {
          view = { ...next, ...(j.view.cancelRequested ? { cancelRequested: true } : {}) }
          j.view = view
        }
        jobs.set(view.id, j)
        const progress = (rec: ProjectOperationRecord): void =>
          set({
            ...view,
            progress: {
              done: rec.results.filter((r) => r.status !== 'pending').length,
              total: rec.results.length
            }
          })
        // Rejection handling is attached before the job can settle: a failure becomes a failed job
        applyProjectPlan({ home, signal: j.controller.signal }, planId, {
          afterBackup: progress,
          afterRecord: progress
        }).then(
          (rec) =>
            set({
              ...view,
              status: rec.status === 'cancelled' ? 'cancelled' : 'completed',
              progress: { done: rec.results.length, total: rec.results.length },
              result: rec
            }),
          (e: unknown) =>
            set({ ...view, status: 'failed', reason: (e as Error)?.message ?? String(e) })
        )
        return { jobId: view.id }
      }),
    projectDiscardPlan: (...args) =>
      wrap(async () => {
        const planId = text(request(args, ['planId']).planId, 'planId')
        if (s.pending.has(planId)) invalidate(planId)
        else if (!s.plans.has(planId)) throw staleRequest('This preview')
        else spend(planId)
        return { planId }
      }),
    projectOperations: (...args) =>
      wrap(async () => {
        request(args, [])
        return listProjectOperations(home)
      }),
    projectRestorePreview: (...args) =>
      wrap(async () => {
        const operationId = text(request(args, ['operationId']).operationId, 'operationId')
        const view = await planProjectRestore(ctx(), operationId)
        issued(view.id, false)
        return view
      }),
    projectForgetDelivery: (...args) =>
      wrap(async () => {
        const deliveryId = text(request(args, ['deliveryId']).deliveryId, 'deliveryId')
        // Ownership changes are serialized with every apply and restore
        const lock = acquireApplyLock(home, 'pforget-' + randomUUID())
        if (!lock.ok)
          throw new ProjectError(
            'applyInProgress',
            'An apply or restore is running: try again after it.'
          )
        try {
          forgetProjectDelivery(home, deliveryId)
        } finally {
          lock.release()
        }
        return { deliveryId }
      })
  }
}
