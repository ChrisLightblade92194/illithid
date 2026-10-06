/**
 * Apply of project delivery and restore plans (spec 2026-10-06 project delivery §Preview, Apply and restore
 * guarantees).
 * - One-shot: the plan the backend stored (fingerprint intact, no unresolved collision) is spent under the Windows
 *   exclusive apply lock shared with the global flow; the lock is never deleted or taken over.
 * - The operation record is persisted before the first change and at every phase: checked → backedUp → writing →
 *   written → recorded (paths and digests only). `writing` is persisted before any project entry can change, so a
 *   crash afterwards is reported as uncertain, never as success or as "nothing changed"; nothing is resumed.
 * - Per destination: the project chain, the library variant (or backup), the destination content, identity and
 *   ownership are checked again; a complete backup is copied, flushed and verified before meta.json is written; the
 *   destination is checked again after the backup; the new content is staged next to it and verified; then the complete
 *   source (library variant or backup), the project chain, the destination (with the folders this operation created)
 *   and its owner are checked again immediately before the commit (an exclusive hard link for a new file, a rename
 *   otherwise; a folder is swapped by renames); the result is read back completely before the ownership record is
 *   written. A change seen there refuses the destination: the staged copy and the still-empty folders created for it
 *   are removed, the new local content is left alone. A refusal skips that destination; a failure or a cancellation
 *   stops the queue (later destinations are not attempted). Not atomic across destinations.
 * - Reads and copies are asynchronous and bounded (the Electron main process stays responsive); the abort signal is
 *   observed until a destination starts changing, then that destination is finished and recorded.
 * The re-checks narrow but do not remove the race with external writers between the last check and the commit.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fsp, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { identityOf, recheckBinding } from '../census/paths'
import { CENSUS_LIMITS, createReader } from '../census/scan'
import type { CandidateBinding, CensusEntry, PathIdentity } from '../census/types'
import { readStoredVariants } from '../globalImport'
import { acquireApplyLock, lockHeld, readLock } from '../globalOperations'
import { appTmpName, atomicWrite } from '../write'
import {
  asProjectError,
  copyFileVerified,
  observeAt,
  observeLibraryVariant,
  type VariantObservation
} from './content'
import { inspectProjectDestination } from './destinations'
import { findScopeOverlap, projectOwnerAt } from './ownership'
import {
  consumeProjectPlan,
  readProjectPlan,
  type PlanDestinationBinding,
  type ProjectStoredPlan,
  type RestoreBinding
} from './plan'
import {
  projectBackupsDir,
  projectOperationsDir,
  readProjectDeliveries,
  writeProjectDeliveries
} from './state'
import {
  ProjectError,
  type ProjectBackupMeta,
  type ProjectContext,
  type ProjectDeliveryRecord,
  type ProjectDestinationObservation,
  type ProjectOperationRecord,
  type ProjectOperationResult,
  type ProjectOperationView,
  type ProjectPhaseHooks,
  type ProjectPlanChange
} from './types'

const MiB = 1024 * 1024

// ---------------------------------------------------------------- records

const OPERATION_ID = /^pop-[0-9a-z]+-[0-9a-f]{8}$/

export function newProjectOperationId(): string {
  return `pop-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function writeProjectOperation(home: string, rec: ProjectOperationRecord): void {
  rec.updatedAt = new Date().toISOString()
  atomicWrite(
    join(projectOperationsDir(home), `${rec.id}.json`),
    JSON.stringify(rec, null, 2) + '\n'
  )
}

export function readProjectOperation(home: string, id: string): ProjectOperationRecord | null {
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) return null
  const p = join(projectOperationsDir(home), `${id}.json`)
  if (!existsSync(p)) return null
  try {
    const r = JSON.parse(readFileSync(p, 'utf8')) as ProjectOperationRecord
    return r.version === 1 && r.scope === 'project' && r.id === id && Array.isArray(r.results)
      ? r
      : null
  } catch {
    return null
  }
}

/**
 * Operations, newest first. A record still running whose process no longer holds the lock is interrupted: a
 * destination whose write had started (writing/written, not recorded) is uncertain, one not started is not attempted.
 * Listing reads only; nothing is resumed or restored.
 */
export function listProjectOperations(home: string): ProjectOperationView[] {
  let names: string[]
  try {
    names = readdirSync(projectOperationsDir(home)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const holder = lockHeld(home) ? readLock(home) : null
  return names
    .map((n) => readProjectOperation(home, n.slice(0, -5)))
    .filter((r): r is ProjectOperationRecord => !!r)
    .map((r): ProjectOperationView => {
      if (r.status !== 'running' || holder?.operationId === r.id) return r
      return {
        ...r,
        status: 'interrupted',
        results: r.results.map((x) =>
          x.status !== 'pending'
            ? x
            : {
                ...x,
                status:
                  x.phase === 'writing' || x.phase === 'written' ? 'uncertain' : 'notAttempted'
              }
        )
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
}

export function readProjectBackupMeta(dir: string): ProjectBackupMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ProjectBackupMeta
    return m.version === 1 && m.scope === 'project' ? m : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- filesystem steps

/** Refusal of one destination (the queue goes on) */
class Refused extends Error {
  constructor(public code: string) {
    super(code)
  }
}

const tmpBeside = (path: string, tag = ''): string =>
  join(dirname(path), appTmpName(`${basename(path)}${tag}`, randomBytes(4).toString('hex')))

/** Complete content of an existing entry, read again (digest in its revision format) */
async function digestAt(
  path: string,
  kind: 'rule' | 'skill',
  signal: AbortSignal
): Promise<{ digest: string; manifest?: CensusEntry[] }> {
  const reader = createReader(signal, CENSUS_LIMITS)
  const st = await reader.fs.lstat(path)
  if (st.isSymbolicLink()) throw new Refused('changedSinceCheck')
  const seen = await observeAt(reader, CENSUS_LIMITS, dirname(path), basename(path), kind, st)
  return { digest: seen.revision, ...(seen.manifest ? { manifest: seen.manifest } : {}) }
}

/** Copies a tree entry by entry (folders first, as listed), each file verified against its digest */
async function copyTree(
  src: string,
  dst: string,
  manifest: readonly CensusEntry[],
  prints: ReadonlyMap<string, string>,
  signal: AbortSignal
): Promise<void> {
  const buffer = Buffer.allocUnsafe(MiB)
  await fsp.mkdir(dst)
  for (const e of manifest) {
    signal.throwIfAborted()
    const s = join(src, ...e.path.split('/'))
    const d = join(dst, ...e.path.split('/'))
    if (e.kind === 'dir') await fsp.mkdir(d)
    else
      await copyFileVerified(
        s,
        d,
        prints.get(s),
        { digest: e.digest!, bytes: e.bytes },
        signal,
        buffer
      )
  }
}

const printsOf = (identities: readonly PathIdentity[]): Map<string, string> =>
  new Map(identities.map((i) => [i.path, i.fingerprint]))

/**
 * Backup of a destination as observed (obs): content copied from the observed entries, flushed, read back and
 * compared, then meta.json. Throws Refused when the content is no longer the observed one.
 */
async function writeBackup(
  home: string,
  opId: string,
  index: number,
  change: ProjectPlanChange,
  project: CandidateBinding,
  obs: ProjectDestinationObservation,
  previousOwner: ProjectDeliveryRecord | null,
  signal: AbortSignal
): Promise<string> {
  const dir = join(projectBackupsDir(home), opId, String(index))
  await fsp.mkdir(dir, { recursive: true })
  const content = join(dir, 'content')
  try {
    if (obs.shape === 'file')
      await copyFileVerified(
        obs.destination,
        content,
        obs.identities.at(-1)?.fingerprint,
        { digest: obs.digest! },
        signal
      )
    else if (obs.shape === 'dir')
      await copyTree(obs.destination, content, obs.manifest ?? [], printsOf(obs.identities), signal)
    if (obs.shape !== 'absent' && (await digestAt(content, obs.kind, signal)).digest !== obs.digest)
      throw new Refused('changedSinceCheck')
  } catch (e) {
    const x = asProjectError(e)
    if (x instanceof ProjectError && x.code === 'changedSinceCheck')
      throw new Refused('changedSinceCheck')
    throw x
  }
  const meta: ProjectBackupMeta = {
    version: 1,
    scope: 'project',
    operationId: opId,
    index,
    destinationId: change.destinationId,
    destination: obs.destination,
    relativePath: change.relativePath,
    kind: obs.kind,
    project,
    shape: obs.shape,
    digest: obs.digest,
    digestAlgorithm: obs.digestAlgorithm,
    ...(obs.manifest ? { manifest: obs.manifest } : {}),
    previousOwner,
    at: new Date().toISOString()
  }
  atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return dir
}

/** Creates the missing folders below the existing ancestor, recording each one's identity right after creation */
async function createFolders(
  obs: ProjectDestinationObservation,
  created: PathIdentity[],
  persist: () => void
): Promise<void> {
  let p = obs.existingAncestor.path
  for (const name of obs.remaining.slice(0, -1)) {
    p = join(p, name)
    try {
      await fsp.mkdir(p)
    } catch (e) {
      // Something appeared there since the check: never written into
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Refused('changedSinceCheck')
      throw e
    }
    const st = await fsp.lstat(p, { bigint: true })
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Refused('changedSinceCheck')
    created.push({ path: p, fingerprint: identityOf(st) })
    persist()
  }
}

/** Removes folders this operation created, deepest first, while each is still the same unlinked empty folder */
export async function pruneCreated(created: readonly PathIdentity[]): Promise<PathIdentity[]> {
  const left = [...created]
  for (const d of [...created].reverse()) {
    try {
      const st = await fsp.lstat(d.path, { bigint: true })
      if (st.isSymbolicLink() || !st.isDirectory() || identityOf(st) !== d.fingerprint) break
      if ((await fsp.readdir(d.path)).length) break
      await fsp.rmdir(d.path)
      left.pop()
    } catch {
      break
    }
  }
  return left
}

/** Stages content beside the destination: a verified copy from a library variant or a backup */
async function stage(
  dest: string,
  kind: 'rule' | 'skill',
  source: { path: string; digest: string; manifest?: CensusEntry[]; prints?: Map<string, string> },
  signal: AbortSignal
): Promise<string> {
  const staged = tmpBeside(dest)
  try {
    if (kind === 'rule')
      await copyFileVerified(
        source.path,
        staged,
        source.prints?.get(source.path),
        { digest: source.digest },
        signal
      )
    else
      await copyTree(source.path, staged, source.manifest ?? [], source.prints ?? new Map(), signal)
    if ((await digestAt(staged, kind, signal)).digest !== source.digest)
      throw new Refused('changedSinceCheck')
    return staged
  } catch (e) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {})
    // The source changed while it was copied: a refusal of this destination, not a failure
    const x = asProjectError(e)
    if (x instanceof ProjectError && x.code === 'changedSinceCheck')
      throw new Refused('changedSinceCheck')
    throw e
  }
}

/**
 * Commits staged content at the destination, which must still be what `obs` saw. New file: exclusive hard link (an
 * entry that appeared meanwhile is never overwritten). Replaced file: rename over it. Folder: renamed into place, the
 * current one moved aside first and dropped afterwards (put back if the swap fails).
 */
async function commit(
  dest: string,
  kind: 'rule' | 'skill',
  staged: string,
  obs: ProjectDestinationObservation,
  res: ProjectOperationResult
): Promise<void> {
  if (kind === 'rule') {
    if (obs.shape === 'absent') {
      try {
        await fsp.link(staged, dest)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Refused('changedSinceCheck')
        throw e
      }
      await fsp.unlink(staged).catch(() => (res.leftover = staged))
      return
    }
    await fsp.rename(staged, dest)
    return
  }
  if (obs.shape === 'absent') {
    await fsp.rename(staged, dest)
    return
  }
  const aside = tmpBeside(dest, '.old')
  await fsp.rename(dest, aside)
  try {
    await fsp.rename(staged, dest)
  } catch (e) {
    await fsp.rename(aside, dest).catch(() => (res.leftover = aside))
    throw e
  }
  await fsp.rm(aside, { recursive: true, force: false }).catch(() => (res.leftover = aside))
}

/** Removes delivered content (restore of an absent-before destination), only while it still is exactly that */
async function removeDelivered(
  dest: string,
  kind: 'rule' | 'skill',
  delivered: string,
  res: ProjectOperationResult
): Promise<void> {
  const aside = tmpBeside(dest, '.removed')
  await fsp.rename(dest, aside)
  const now = await digestAt(aside, kind, new AbortController().signal).catch(() => null)
  if (now?.digest !== delivered) {
    await fsp.rename(aside, dest).catch(() => (res.leftover = aside))
    throw new Refused('changedSinceCheck')
  }
  await fsp.rm(aside, { recursive: true, force: false }).catch(() => (res.leftover = aside))
}

// ---------------------------------------------------------------- ownership

const sameRecord = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function setOwner(
  home: string,
  destination: string,
  keys: readonly string[],
  record: ProjectDeliveryRecord | null
): void {
  const d = resolve(destination)
  const real = keys.filter((k) => k.startsWith('id:'))
  const rest = readProjectDeliveries(home).filter(
    (r) => resolve(r.destination) !== d && !real.includes(r.target.physicalKey)
  )
  writeProjectDeliveries(home, record ? [...rest, record] : rest)
}

// ---------------------------------------------------------------- apply

function overall(
  results: ProjectOperationResult[],
  cancelled: boolean
): ProjectOperationRecord['status'] {
  if (cancelled) return 'cancelled'
  const notDone = results.some((r) =>
    ['refused', 'failed', 'notAttempted', 'pending'].includes(r.status)
  )
  if (!notDone) return 'completed'
  if (results.some((r) => r.status === 'done')) return 'partial'
  return results.some((r) => r.status === 'failed') ? 'failed' : 'refused'
}

function resultsOf(plan: ProjectStoredPlan): ProjectOperationResult[] {
  return plan.view.changes.map((c, index) => ({
    index,
    destinationId: c.destinationId,
    destination: c.destination,
    relativePath: c.relativePath,
    project: c.project,
    kind: c.kind,
    recipients: c.recipients,
    action: c.action,
    variantId: c.selectedVariantId,
    status: 'pending',
    phase: 'pending',
    beforeDigest: c.beforeDigest,
    afterDigest: c.afterDigest
  }))
}

/** A whole-operation refusal: nothing attempted, every destination reported refused with the same code */
function refusal(
  plan: ProjectStoredPlan | null,
  planId: string,
  code: string,
  message: string
): ProjectOperationRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    scope: 'project',
    id: '',
    planId,
    kind: plan?.kind ?? 'sync',
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    status: 'refused',
    results: (plan ? resultsOf(plan) : []).map((r) => ({ ...r, status: 'refused', code })),
    error: { code, message }
  }
}

interface Step {
  ctx: ProjectContext
  plan: ProjectStoredPlan
  rec: ProjectOperationRecord
  res: ProjectOperationResult
  change: ProjectPlanChange
  binding: PlanDestinationBinding
  project: CandidateBinding
  persist: () => void
  hooks: ProjectPhaseHooks
}

/**
 * The bound observation of an absent destination, updated with the folders this operation itself created on its way
 * (an earlier destination of the same plan may share missing folders): no other difference is accepted.
 */
function expectedNow(
  bound: PlanDestinationBinding['observation'],
  created: readonly PathIdentity[]
): PlanDestinationBinding['observation'] {
  if (bound.shape !== 'absent') return bound
  const byPath = new Map(created.map((c) => [c.path, c]))
  let ancestor = bound.existingAncestor
  let remaining = bound.remaining
  const identities = [...bound.identities]
  while (remaining.length > 1) {
    const next = byPath.get(join(ancestor.path, remaining[0]))
    if (!next) break
    identities.push(next)
    ancestor = next
    remaining = remaining.slice(1)
  }
  return {
    ...bound,
    identities,
    physicalKey: `under:${ancestor.fingerprint}:${remaining.join('/')}`,
    existingAncestor: ancestor,
    remaining
  }
}

/** The destination and its owner must still be what the plan bound; returns the current observation */
async function recheck(s: Step): Promise<ProjectDestinationObservation> {
  const { ctx, binding } = s
  try {
    await recheckBinding(s.project)
  } catch {
    throw new Refused('projectChanged')
  }
  let obs: ProjectDestinationObservation
  try {
    obs = await inspectProjectDestination(ctx, s.project, binding.destination, binding.kind)
  } catch (e) {
    if (e instanceof ProjectError)
      throw new Refused(e.code === 'projectChanged' ? 'projectChanged' : 'changedSinceCheck')
    throw e
  }
  const { project: _p, localSlots: _l, ...now } = obs
  void _p
  void _l
  // Folders created by this operation, this destination's own included once they exist (after staging)
  const ours = s.rec.results.flatMap((r) => r.createdDirs ?? [])
  if (!sameRecord(now, expectedNow(binding.observation, ours)))
    throw new Refused('changedSinceCheck')
  const owner = projectOwnerAt(
    readProjectDeliveries(ctx.home),
    binding.destination,
    obs.physicalKey
  )
  if (!sameRecord(owner, binding.owner)) throw new Refused('ownershipChanged')
  if (findScopeOverlap(ctx.home, binding.destination, 'project')) throw new Refused('scopeOverlap')
  return obs
}

/** The bound library variant, read again from validated storage: it must still have the planned revision */
async function variantNow(s: Step): Promise<VariantObservation> {
  const bound = s.plan.bindings.variants.find((v) => v.id === s.change.selectedVariantId)
  const stored = readStoredVariants(s.ctx.home).variants.find(
    (v) => v.id === s.change.selectedVariantId
  )
  if (!bound || !stored) throw new Refused('changedSinceCheck')
  let v: VariantObservation
  try {
    v = await observeLibraryVariant(s.ctx.home, stored, s.ctx.signal)
  } catch (e) {
    if (e instanceof ProjectError) throw new Refused('changedSinceCheck')
    throw e
  }
  if (v.revision !== bound.revision || v.name !== bound.name || v.kind !== bound.kind)
    throw new Refused('changedSinceCheck')
  return v
}

/** Backup, recheck, then the write itself; leaves res at written (caller verifies and records) */
async function backUpAndWrite(
  s: Step,
  obs: ProjectDestinationObservation,
  write: (obs: ProjectDestinationObservation) => Promise<void>
): Promise<void> {
  const { ctx, res } = s
  s.res.phase = 'checked'
  s.persist()
  try {
    res.backup = await writeBackup(
      ctx.home,
      s.rec.id,
      res.index,
      s.change,
      s.project,
      obs,
      s.binding.owner,
      ctx.signal
    )
  } catch (e) {
    if (e instanceof Refused || ctx.signal.aborted) throw e
    throw Object.assign(new Error('backupFailed'), { code: 'backupFailed', stop: true })
  }
  res.phase = 'backedUp'
  s.persist()
  await s.hooks.afterBackup?.(s.rec, res.index)
  const again = await recheck(s)
  ctx.signal.throwIfAborted()
  res.phase = 'writing'
  s.persist()
  await write(again)
  res.phase = 'written'
  s.persist()
  await s.hooks.afterWrite?.(s.rec, res.index)
}

async function syncChange(s: Step): Promise<void> {
  const { ctx, res, change, binding } = s
  const variant = await variantNow(s)
  const obs = await recheck(s)
  await backUpAndWrite(s, obs, async (now) => {
    const created: PathIdentity[] = []
    res.createdDirs = created
    let staged: string | null = null
    try {
      await createFolders(now, created, s.persist)
      staged = await stage(
        binding.destination,
        binding.kind,
        {
          path: variant.contentPath,
          digest: variant.revision,
          ...(variant.manifest ? { manifest: variant.manifest } : {}),
          prints: printsOf(variant.identities)
        },
        ctx.signal
      )
      // Staging took time: the complete source, the project chain, the destination and its owner are checked again
      await variantNow(s)
      const ready = await recheck(s)
      await commit(binding.destination, binding.kind, staged, ready, res)
      staged = null
    } catch (e) {
      if (staged) await fsp.rm(staged, { recursive: true, force: true }).catch(() => {})
      // Nothing was committed: the folders created for it go again when still empty
      res.createdDirs = await pruneCreated(created)
      if (!res.createdDirs.length) delete res.createdDirs
      throw e
    }
  })
  // From here the destination changed: the result is read back and recorded even after a cancellation
  const after = await inspectProjectDestination(
    { home: ctx.home, signal: new AbortController().signal },
    s.project,
    binding.destination,
    binding.kind
  ).catch(() => null)
  if (after?.digest !== variant.revision)
    throw Object.assign(new Error('verifyFailed'), { code: 'verifyFailed', stop: true })
  const record: ProjectDeliveryRecord = {
    version: 1,
    id: `pd-${randomBytes(8).toString('hex')}`,
    scope: 'project',
    project: s.project,
    target: { physicalKey: after.physicalKey },
    destination: binding.destination,
    kind: binding.kind,
    recipients: change.recipients,
    variantId: variant.id,
    variantRevision: variant.revision,
    deliveredDigest: variant.revision,
    digestAlgorithm: variant.revisionAlgorithm,
    operationId: s.rec.id,
    at: new Date().toISOString()
  }
  setOwner(
    ctx.home,
    binding.destination,
    [binding.observation.physicalKey, after.physicalKey],
    record
  )
  res.deliveryId = record.id
}

/** The backup must still hold exactly what it recorded */
async function backupHeld(rb: RestoreBinding, signal: AbortSignal): Promise<ProjectBackupMeta> {
  const meta = readProjectBackupMeta(rb.backup)
  if (!meta || meta.digest !== rb.backupDigest) throw new Refused('backupCorrupt')
  if (meta.shape !== 'absent') {
    const held = await digestAt(join(rb.backup, 'content'), meta.kind, signal).catch(() => null)
    if (held?.digest !== meta.digest) throw new Refused('backupCorrupt')
  }
  return meta
}

async function restoreChange(s: Step, rb: RestoreBinding): Promise<void> {
  const { ctx, res, binding } = s
  const meta = await backupHeld(rb, ctx.signal)
  const obs = await recheck(s)
  if (obs.digest !== rb.backupDigest)
    await backUpAndWrite(s, obs, async () => {
      if (meta.shape === 'absent') {
        await removeDelivered(binding.destination, binding.kind, rb.deliveredDigest!, res)
        const left = await pruneCreated(rb.createdDirs)
        if (left.length) res.leftover = left[left.length - 1].path
        return
      }
      const content = join(rb.backup, 'content')
      const staged = await stage(
        binding.destination,
        binding.kind,
        {
          path: content,
          digest: meta.digest!,
          ...(meta.manifest ? { manifest: meta.manifest } : {})
        },
        ctx.signal
      )
      try {
        // Staging took time: the backup, the project chain, the destination and its owner are checked again
        await backupHeld(rb, ctx.signal)
        const ready = await recheck(s)
        await commit(binding.destination, binding.kind, staged, ready, res)
      } catch (e) {
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {})
        throw e
      }
    })
  else {
    // The bytes are already as before: only the ownership goes back
    res.phase = 'checked'
    s.persist()
  }
  const after = await inspectProjectDestination(
    { home: ctx.home, signal: new AbortController().signal },
    s.project,
    binding.destination,
    binding.kind
  ).catch(() => null)
  if ((after?.digest ?? null) !== rb.backupDigest)
    throw Object.assign(new Error('verifyFailed'), { code: 'verifyFailed', stop: true })
  setOwner(
    ctx.home,
    binding.destination,
    [binding.observation.physicalKey, after!.physicalKey],
    rb.previousOwner
  )
}

/**
 * Applies a stored plan once (sync or restore). Refused as a whole (nothing attempted, plan not spent) when the plan is
 * unknown, has unresolved collisions or nothing to write, or another apply holds the lock; refused (spent) when it was
 * already used. Otherwise returns the operation record with each destination's outcome.
 */
export async function applyProjectPlan(
  ctx: ProjectContext,
  planId: string,
  hooks: ProjectPhaseHooks = {}
): Promise<ProjectOperationRecord> {
  const plan = readProjectPlan(ctx.home, planId)
  if (!plan) return refusal(null, planId, 'unknownPlan', 'No stored preview with this id.')
  if (!plan.view.applicable)
    return refusal(
      plan,
      planId,
      'notApplicable',
      'Resolve every collision and choose at least one write first.'
    )
  const id = newProjectOperationId()
  const lock = acquireApplyLock(ctx.home, id)
  if (!lock.ok)
    return refusal(
      plan,
      planId,
      lock.code,
      lock.code === 'applyInProgress'
        ? 'Another apply or restore is running on this Illithid state.'
        : 'Applying is available on Windows only.'
    )
  try {
    if (!consumeProjectPlan(ctx.home, planId, id))
      return refusal(
        plan,
        planId,
        'planAlreadyApplied',
        'This preview was already used: make a new one.'
      )
    const now = new Date().toISOString()
    const rec: ProjectOperationRecord = {
      version: 1,
      scope: 'project',
      id,
      planId,
      kind: plan.kind,
      ...(plan.view.restoreOf ? { restoreOf: plan.view.restoreOf } : {}),
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      status: 'running',
      results: resultsOf(plan)
    }
    const persist = (): void => writeProjectOperation(ctx.home, rec)
    persist()
    let stop = false
    let cancelled = false
    for (const res of rec.results) {
      const change = plan.view.changes[res.index]
      if (stop || cancelled) {
        res.status = 'notAttempted'
        if (cancelled) res.code = 'cancelled'
        continue
      }
      if (change.action === 'skip') {
        res.status = 'skipped'
        continue
      }
      if (change.action === 'unchanged') {
        res.status = 'unchanged'
        continue
      }
      if (ctx.signal.aborted) {
        cancelled = true
        res.status = 'notAttempted'
        res.code = 'cancelled'
        continue
      }
      const binding = plan.bindings.destinations[change.destinationId]
      const project = plan.bindings.projects.find((p) => p.id === binding?.candidateId)?.binding
      const s: Step = { ctx, plan, rec, res, change, binding, project: project!, persist, hooks }
      try {
        if (!binding || !project) throw new Refused('planMismatch')
        if (change.action === 'restore') {
          const rb = plan.bindings.restore?.[change.destinationId]
          if (!rb) throw new Refused('planMismatch')
          await restoreChange(s, rb)
        } else await syncChange(s)
        res.status = 'done'
        res.phase = 'recorded'
        persist()
        await hooks.afterRecord?.(rec, res.index)
      } catch (e) {
        if (e instanceof Refused) {
          res.status = 'refused'
          res.code = e.code
        } else if (ctx.signal.aborted && res.phase !== 'writing' && res.phase !== 'written') {
          cancelled = true
          res.status = 'notAttempted'
          res.code = 'cancelled'
        } else {
          stop = true
          res.status = 'failed'
          res.code = (e as NodeJS.ErrnoException)?.code ?? 'writeFailed'
        }
        persist()
      }
    }
    rec.status = overall(rec.results, cancelled)
    rec.finishedAt = new Date().toISOString()
    persist()
    return rec
  } finally {
    lock.release()
  }
}
