/**
 * IPC handlers of the Windows project import and delivery (spec 2026-10-06 project delivery §Preview, Apply and
 * restore guarantees, §Integration and UI boundaries). Requests are single objects with exactly their keys; the
 * renderer names backend-issued ids (census run and items, jobs) — never a source or destination path. Validation
 * happens before any filesystem access. Jobs live in memory for the session; a job's result stays pollable after a
 * cancellation, so partial work is shown as it is. Other platforms refuse every project channel without reading.
 */
import { randomUUID } from 'node:crypto'
import { CensusError } from '../engine/census/types'
import { importProjectItems } from '../engine/project/import'
import { ProjectError, type CensusImportAccess, type ProjectJobView } from '../engine/project/types'
import type { GlobalResult, PROJECT_CHANNELS } from '../shared/api'

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
    return { projectImportStart: refuse, projectPoll: refuse, projectCancel: refuse }
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
        const j: Job = {
          controller: new AbortController(),
          view: {
            id: `job-${randomUUID()}`,
            kind: 'import',
            status: 'running',
            progress: { done: 0, total: itemIds.length }
          }
        }
        jobs.set(j.view.id, j)
        // Rejection handling is attached before the job can settle: a failure becomes a failed job
        importProjectItems({ home, signal: j.controller.signal }, lease, {
          onProgress: (done, total) => {
            if (j.view.status === 'running') j.view = { ...j.view, progress: { done, total } }
          }
        }).then(
          (result) => {
            j.view = {
              ...j.view,
              status: result.status === 'cancelled' ? 'cancelled' : 'completed',
              result
            }
          },
          (e: unknown) => {
            j.view = { ...j.view, status: 'failed', reason: (e as Error)?.message ?? String(e) }
          }
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
      })
  }
}
