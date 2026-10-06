/**
 * Restore previews of project operations (spec 2026-10-06 project delivery §Preview, Apply and restore guarantees).
 * - A restore is its own preview and Apply (operations.ts applies it with the same lock, backups and checks).
 * - Each destination the operation backed up is examined now: the backup must be complete and match its record, the
 *   project folder must still be the one bound, and the destination must still hold what the operation wrote (or
 *   already the backed-up content) with the operation's own ownership (or the previous one). Local edits, newer
 *   deliveries, corrupt backups and replaced projects are excluded with their reason; nothing is overwritten.
 * - An absent-before destination is restored by removing only the still-verified delivered content; only the folders
 *   the operation created are pruned, and only while they are still the same unlinked empty folders.
 * - Ownership goes back to the previous state even when the bytes already are as before.
 * Changes are listed (and applied) in reverse order of the restored operation. Nothing is restored automatically.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { recheckBinding } from '../census/paths'
import { CENSUS_LIMITS, createReader } from '../census/scan'
import { observeAt } from './content'
import { inspectProjectDestination } from './destinations'
import { readProjectBackupMeta, readProjectOperation } from './operations'
import { projectOwnerAt } from './ownership'
import {
  compareManifests,
  newProjectPlanId,
  PROJECT_PREVIEW_BYTES,
  registerRestoreRecompute,
  storeProjectPlan,
  type PlanBindings,
  type PlanDestinationBinding,
  type PlanProject,
  type RestoreBinding
} from './plan'
import { readProjectDeliveries } from './state'
import {
  ProjectError,
  type ProjectContext,
  type ProjectDecision,
  type ProjectOperationRecord,
  type ProjectPlanChange,
  type ProjectPlanView,
  type ProjectPreview
} from './types'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

async function text(path: string): Promise<{ text: string | null; truncated: boolean }> {
  try {
    const fh = await fsp.open(path, 'r')
    try {
      const st = await fh.stat()
      const buf = Buffer.alloc(Math.min(st.size, PROJECT_PREVIEW_BYTES))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return {
        text: buf.subarray(0, bytesRead).toString('utf8'),
        truncated: st.size > PROJECT_PREVIEW_BYTES
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { text: null, truncated: false }
  }
}

/** The restore plan of an operation for these decisions (Skip per destination), observing everything now */
async function computeRestorePlan(
  ctx: ProjectContext,
  id: string,
  op: ProjectOperationRecord,
  decisions: readonly ProjectDecision[]
): Promise<{ view: ProjectPlanView; bindings: PlanBindings }> {
  const records = readProjectDeliveries(ctx.home)
  const changes: ProjectPlanChange[] = []
  const excluded: ProjectPlanView['excluded'] = []
  const projects = new Map<string, PlanProject>()
  const destinations: Record<string, PlanDestinationBinding> = {}
  const restore: Record<string, RestoreBinding> = {}
  const exclude = (destination: string, reason: string): void => {
    excluded.push({ selection: null, destination, reason })
  }
  for (const r of [...op.results].reverse()) {
    if (!r.backup) continue
    const meta = readProjectBackupMeta(r.backup)
    if (!meta || meta.destination !== r.destination) {
      exclude(r.destination, 'backupMissing')
      continue
    }
    if (meta.shape !== 'absent') {
      const reader = createReader(ctx.signal, CENSUS_LIMITS)
      const held = await (async () => {
        const st = await reader.fs.lstat(join(r.backup!, 'content'))
        if (st.isSymbolicLink()) return null
        return observeAt(reader, CENSUS_LIMITS, r.backup!, 'content', meta.kind, st)
      })().catch(() => null)
      if (held?.revision !== meta.digest) {
        exclude(r.destination, 'backupCorrupt')
        continue
      }
    }
    try {
      await recheckBinding(meta.project)
    } catch {
      exclude(r.destination, 'projectChanged')
      continue
    }
    let obs
    try {
      obs = await inspectProjectDestination(ctx, meta.project, meta.destination, meta.kind)
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e
      exclude(r.destination, e.code === 'projectChanged' ? 'projectChanged' : (e.reason ?? e.code))
      continue
    }
    const owner = projectOwnerAt(records, meta.destination, obs.physicalKey)
    const ours = owner?.operationId === op.id
    const before = same(owner, meta.previousOwner)
    const delivered = r.afterDigest
    let action: ProjectPlanChange['action']
    if (obs.digest === meta.digest) {
      // Already as before: only the ownership may still differ
      if (before) action = 'unchanged'
      else if (owner && !ours) {
        exclude(r.destination, 'newerDelivery')
        continue
      } else action = 'restore'
    } else if (owner && !ours && !before) {
      exclude(r.destination, 'newerDelivery')
      continue
    } else if (obs.digest !== delivered || !(ours || before)) {
      exclude(r.destination, 'changedSinceOperation')
      continue
    } else action = 'restore'
    const destinationId = `d-${sha(`${obs.physicalKey}\0${meta.destination}`).slice(0, 16)}`
    const decision = decisions.find((d) => d.destinationId === destinationId)
    if (decision && action === 'restore') action = decision.action as 'restore' | 'skip'
    const projectId = `p-${sha(meta.project.path).slice(0, 16)}`
    projects.set(projectId, {
      id: projectId,
      path: meta.project.path,
      name: basename(meta.project.path),
      binding: meta.project
    })
    let preview: ProjectPreview
    if (meta.kind === 'skill')
      preview = {
        before: null,
        after: null,
        files: compareManifests(
          obs.shape === 'dir' ? (obs.manifest ?? []) : null,
          meta.manifest ?? null
        )
      }
    else {
      const b = obs.shape === 'file' ? await text(meta.destination) : null
      const a = meta.shape === 'file' ? await text(join(r.backup, 'content')) : null
      preview = {
        before: b?.text ?? null,
        after: a?.text ?? null,
        ...(b?.truncated || a?.truncated ? { truncated: true } : {})
      }
    }
    const relativePath = relative(meta.project.path, meta.destination).split(sep).join('/')
    changes.push({
      destinationId,
      destination: meta.destination,
      relativePath,
      project: { id: projectId, path: meta.project.path, name: basename(meta.project.path) },
      kind: meta.kind,
      recipients: r.recipients,
      incoming: [],
      selectedVariantId: null,
      state:
        obs.shape === 'absent' ? 'absent' : obs.digest === meta.digest ? 'identical' : 'different',
      beforeDigest: obs.digest,
      afterDigest: meta.digest,
      owner,
      preview,
      action,
      localSlots: obs.localSlots,
      ...(action === 'unchanged'
        ? {}
        : { restore: { absentBefore: meta.shape === 'absent', previousOwner: meta.previousOwner } })
    })
    const { project: _p, localSlots: _l, ...observation } = obs
    void _p
    void _l
    destinations[destinationId] = {
      candidateId: projectId,
      destination: meta.destination,
      relativePath,
      kind: meta.kind,
      observation,
      owner
    }
    restore[destinationId] = {
      operationId: op.id,
      index: r.index,
      backup: r.backup,
      backupDigest: meta.digest,
      deliveredDigest: delivered,
      previousOwner: meta.previousOwner,
      createdDirs: r.createdDirs ?? []
    }
  }
  const view: ProjectPlanView = {
    id,
    kind: 'restore',
    createdAt: new Date().toISOString(),
    root: '',
    changes,
    collisions: [],
    excluded,
    applicable: changes.some((c) => c.action === 'restore'),
    restoreOf: op.id
  }
  return {
    view,
    bindings: {
      discoveryId: '',
      root: '',
      projects: [...projects.values()],
      selections: [],
      variants: [],
      destinations,
      restore
    }
  }
}

registerRestoreRecompute(async (ctx, id, old, decisions) => {
  const op = old.view.restoreOf ? readProjectOperation(ctx.home, old.view.restoreOf) : null
  if (!op) throw new ProjectError('notFound', 'The restored operation is no longer recorded.')
  return computeRestorePlan(ctx, id, op, decisions)
})

/** Restore preview of a project operation, stored by the backend for one Apply */
export async function planProjectRestore(
  ctx: ProjectContext,
  operationId: string
): Promise<ProjectPlanView> {
  ctx.signal.throwIfAborted()
  const op = readProjectOperation(ctx.home, operationId)
  if (!op) throw new ProjectError('notFound', 'No such project operation.')
  const id = newProjectPlanId('restore')
  const { view, bindings } = await computeRestorePlan(ctx, id, op, [])
  storeProjectPlan(ctx.home, { version: 1, id, kind: 'restore', view, bindings, decisions: [] })
  return view
}
