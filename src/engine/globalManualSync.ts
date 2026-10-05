/**
 * Manual sync of global rules and skills (spec 2026-10-04 §8, §9).
 * planGlobalSync is read-only for the tool folders: it validates each choice, keeps conflicts and unsupported
 * deliveries out of the applicable subset (with the reason), and stores the plan in the global state so the apply step
 * can only execute what the user saw. Native forms: dedicated rule file (Claude `rules/`, or a whole instructions
 * file), delimited section of an instructions file (CLAUDE.md, Codex AGENTS.md / AGENTS.override.md, OpenCode
 * AGENTS.md), real skill folder copies. Equal files do not prove that a tool loads them.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { destinationConflict, detectGlobalConflicts, type GlobalConflict } from './globalConflicts'
import {
  bytesDigest,
  destinationFile,
  destinationKey,
  findSection,
  parseDestination,
  readDestination,
  sectionBegin,
  sectionBody,
  sectionEnd,
  type DestinationState
} from './globalDestinations'
import type { GlobalKind, GlobalReference } from './globalImport'
import {
  globalStateDir,
  NATIVE_LAYOUT,
  resolveGlobalPaths,
  type GlobalPathResult,
  type GlobalTool
} from './globalPaths'
import {
  choiceValidity,
  deliveryAt,
  listGlobalVariants,
  readDeliveries,
  validVariantName,
  writeDeliveries,
  type DeliveryChoice,
  type DeliveryRecord,
  type VariantRecord
} from './globalVariants'
import {
  acquireApplyLock,
  atomicWriteBytes,
  ChangedSinceCheck,
  newOperationId,
  pruneEmptyDirs,
  readBackupMeta,
  readOperation,
  removeFileChecked,
  writeBackup,
  writeOperation,
  type BackupMeta,
  type GlobalChangeResult,
  type GlobalOperationRecord
} from './globalOperations'
import { deliverDir } from './deliver'
import { globalTreeDigest } from './globalDigest'
import { appTmpName, atomicWrite } from './write'

export type GlobalChangeOp = 'create' | 'update' | 'replace' | 'adopt' | 'unchanged' | 'remove'

export interface GlobalFileChange {
  path: string
  change: 'added' | 'removed' | 'changed' | 'same'
}

export interface GlobalChange {
  choice: DeliveryChoice
  variantId: string
  variantRevision: string
  variantName: string
  kind: GlobalKind
  tool: GlobalTool
  destination: string
  op: GlobalChangeOp
  /** Digest of the content to deliver (the variant revision; for a restore, the backup content) */
  sourceDigest: string
  /** Destination digest when the plan was made (null = absent) */
  destinationDigest: string | null
  /** Destination digest after the change (null = absent after a removal) */
  afterDigest: string | null
  preview: {
    before: string | null
    after: string | null
    /** Section changes: the whole instructions file after the change */
    fileAfter?: string
    /** Skill changes: per-file comparison */
    files?: GlobalFileChange[]
    truncated?: boolean
  }
  notes: string[]
  /** Restore changes: the backup folder whose content is put back */
  restoreFrom?: string
  /** Who delivered the destination when the plan was made (null = not managed): checked again before writing */
  owner: DeliveryOwner | null
}

/** The delivery record a change was planned against */
export interface DeliveryOwner {
  operationId: string
  deliveredDigest: string
  variantId: string
}

export function ownerOf(rec: DeliveryRecord | undefined | null): DeliveryOwner | null {
  return rec
    ? {
        operationId: rec.operationId,
        deliveredDigest: rec.deliveredDigest,
        variantId: rec.variantId
      }
    : null
}

const ownerKey = (o: DeliveryOwner | null | undefined): string =>
  o ? `${o.operationId}\0${o.deliveredDigest}\0${o.variantId}` : ''

export interface GlobalExcluded {
  choice: DeliveryChoice
  reason: string
  detail?: string
}

export interface GlobalSyncPlan {
  id: string
  kind: 'sync' | 'restore'
  createdAt: string
  /** Digest of every variant id and revision of the library when planned */
  libraryRevision: string
  roots: Partial<Record<GlobalTool, string>>
  changes: GlobalChange[]
  conflicts: GlobalConflict[]
  excluded: GlobalExcluded[]
  /** Restore plans: the operation they undo */
  restoreOf?: string
}

const PREVIEW_LIMIT = 256 * 1024

export function within(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!!r && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r))
}

export function libraryRevision(variants: VariantRecord[]): string {
  const h = createHash('sha256')
  for (const v of [...variants].sort((a, b) => a.id.localeCompare(b.id)))
    h.update(`${v.id}:${v.revision}\n`)
  return h.digest('hex')
}

function validSectionName(name: string): boolean {
  return !!name && !/[\r\n]/.test(name) && !name.includes('-->') && !name.includes('::')
}

/** Whether the destination has a native form for the tool and kind, inside the tool root */
export function validDestination(
  tool: GlobalTool,
  kind: GlobalKind,
  destination: string,
  root: string
): boolean {
  const d = parseDestination(destination)
  const file = d.kind === 'path' ? d.path : d.file
  if (!isAbsolute(file) || !within(root, resolve(file)) || resolve(file) === resolve(root))
    return false
  const rel = relative(root, resolve(file)).split(sep)
  const layout = NATIVE_LAYOUT[tool]
  if (kind === 'skill')
    return (
      d.kind === 'path' &&
      rel.length === 2 &&
      layout.skillDirs.includes(rel[0]) &&
      validVariantName('skill', rel[1])
    )
  if (d.kind === 'section')
    return rel.length === 1 && layout.ruleFiles.includes(rel[0]) && validSectionName(d.section)
  if (rel.length === 1) return layout.ruleFiles.includes(rel[0])
  return layout.ruleDirs.includes(rel[0]) && validVariantName('rule', rel.slice(1).join('/'))
}

/** A link or junction between the tool root and the destination's parent folder */
export function linkedAncestor(root: string, destination: string): boolean {
  const file = resolve(destinationFile(destination))
  let p = dirname(file)
  while (within(root, p) && resolve(p) !== resolve(root)) {
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return true
    p = dirname(p)
  }
  return false
}

const isAnchored = (ref: string): boolean =>
  ref === '~' || ref.startsWith('~/') || ref.startsWith('~\\') || isAbsolute(ref)

function skillFrontmatterName(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const m = fm && /^name:\s*(.+?)\s*$/m.exec(fm[1])
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null
  } catch {
    return null
  }
}

/** Why a delivery would lose meaning (null = supported) */
function unsupportedReason(
  v: VariantRecord,
  tool: GlobalTool,
  destination: string,
  root: string
): string | null {
  const refs: GlobalReference[] = v.references ?? []
  const file = resolve(destinationFile(destination))
  const sameDirAsOrigin = v.origins.some((o) => resolve(dirname(o.path)) === dirname(file))
  if (v.kind === 'rule') {
    if (!refs.length) return null
    // Includes are a Claude feature of CLAUDE.md: other tools, and Claude `rules/` files, would lose them
    const claudeMd = tool === 'claude' && relative(root, file) === 'CLAUDE.md'
    if (!claudeMd) return 'includeNotSupported'
    return refs.every((r) => isAnchored(r.ref) || sameDirAsOrigin) ? null : 'includeNotSupported'
  }
  const samePlace = v.origins.some((o) => resolve(o.path) === file)
  if (refs.some((r) => !isAnchored(r.ref) && !samePlace)) return 'externalReference'
  if (tool === 'opencode') {
    const name = skillFrontmatterName(v.contentPath)
    if (name === null) return 'skillNameMissing'
    if (name !== basename(file)) return 'skillNameMismatch'
  }
  return null
}

function text(buf: Buffer | null): { value: string | null; truncated: boolean } {
  if (buf === null) return { value: null, truncated: false }
  return buf.length > PREVIEW_LIMIT
    ? { value: buf.subarray(0, PREVIEW_LIMIT).toString('utf8'), truncated: true }
    : { value: buf.toString('utf8'), truncated: false }
}

/** Bytes put between existing text and an appended section (the BEGIN marker must start a line) */
export function sectionSeparator(file: Buffer): Buffer {
  if (!file.length) return Buffer.alloc(0)
  return Buffer.from(file[file.length - 1] === 0x0a ? '\n' : '\n\n', 'utf8')
}

/** Instructions file with the section set to body (appended when absent; the bytes around it are kept) */
export function renderSection(file: Buffer | null, name: string, body: Buffer): Buffer {
  const block = Buffer.concat([
    Buffer.from(`${sectionBegin(name)}\n`, 'utf8'),
    body,
    Buffer.from(`${sectionEnd(name)}\n`, 'utf8')
  ])
  if (!file || !file.length) return block
  const s = findSection(file, name)
  if (s === 'malformed') throw new Error('malformed section')
  if (s === 'absent') return Buffer.concat([file, sectionSeparator(file), block])
  return Buffer.concat([file.subarray(0, s.bodyStart), body, file.subarray(s.bodyEnd)])
}

/** Instructions file without the section (markers and body removed, the rest kept) */
export function removeSection(file: Buffer, name: string): Buffer {
  const s = findSection(file, name)
  if (s === 'absent') return file
  if (s === 'malformed') throw new Error('malformed section')
  return Buffer.concat([file.subarray(0, s.begin), file.subarray(s.end)])
}

/** Relative file → digest of a folder tree (links recorded by target, never followed) */
export function treeFiles(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, rel: string): void => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n)
      const r = rel ? `${rel}/${n}` : n
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.set(r, 'link')
      else if (st.isDirectory()) walk(p, r)
      else if (st.isFile()) out.set(r, bytesDigest(readFileSync(p)))
    }
  }
  walk(root, '')
  return out
}

export function compareTrees(
  before: Map<string, string> | null,
  after: Map<string, string> | null
): GlobalFileChange[] {
  const names = [...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])].sort()
  return names.map((path) => {
    const b = before?.get(path)
    const a = after?.get(path)
    const change: GlobalFileChange['change'] =
      b === undefined ? 'added' : a === undefined ? 'removed' : a === b ? 'same' : 'changed'
    return { path, change }
  })
}

/** Content a change writes at its destination: file bytes, section body bytes, or a skill folder path */
export function variantPayload(v: VariantRecord, destination: string): Buffer | string {
  if (v.kind === 'skill') return v.contentPath
  const bytes = readFileSync(v.contentPath)
  return parseDestination(destination).kind === 'section' ? sectionBody(bytes) : bytes
}

export function payloadDigest(payload: Buffer | string): string {
  return typeof payload === 'string' ? globalTreeDigest(payload) : bytesDigest(payload)
}

function opFor(
  state: DestinationState,
  after: string,
  rec: DeliveryRecord | undefined,
  variantId: string
): GlobalChangeOp {
  if (state.digest === null) return 'create'
  if (state.digest === after)
    return rec && rec.deliveredDigest === state.digest && rec.variantId === variantId
      ? 'unchanged'
      : 'adopt'
  return rec && rec.deliveredDigest === state.digest ? 'update' : 'replace'
}

function previewFor(
  destination: string,
  state: DestinationState,
  payload: Buffer | string
): GlobalChange['preview'] {
  const d = parseDestination(destination)
  if (typeof payload === 'string') {
    const before = state.shape === 'dir' ? treeFiles(d.kind === 'path' ? d.path : d.file) : null
    return { before: null, after: null, files: compareTrees(before, treeFiles(payload)) }
  }
  if (d.kind === 'section') {
    const fileBuf = existsSync(d.file) ? readFileSync(d.file) : null
    const s = fileBuf ? findSection(fileBuf, d.section) : 'absent'
    const beforeBody =
      fileBuf && s !== 'absent' && s !== 'malformed'
        ? fileBuf.subarray(s.bodyStart, s.bodyEnd)
        : null
    const b = text(beforeBody)
    const a = text(payload)
    const f = text(renderSection(fileBuf, d.section, payload))
    return {
      before: b.value,
      after: a.value,
      fileAfter: f.value ?? '',
      ...(b.truncated || a.truncated || f.truncated ? { truncated: true } : {})
    }
  }
  const b = text(state.shape === 'file' ? readFileSync(d.path) : null)
  const a = text(payload)
  return {
    before: b.value,
    after: a.value,
    ...(b.truncated || a.truncated ? { truncated: true } : {})
  }
}

function notesFor(
  home: string,
  tool: GlobalTool,
  kind: GlobalKind,
  destination: string,
  roots: Partial<Record<GlobalTool, string>>
): string[] {
  const notes: string[] = []
  const file = destinationFile(destination)
  if (
    tool === 'opencode' &&
    kind === 'rule' &&
    basename(file) === 'AGENTS.md' &&
    !existsSync(file) &&
    existsSync(join(home, '.claude', 'CLAUDE.md'))
  )
    notes.push('opencodeStopsClaudeMdFallback')
  if (tool === 'claude' && kind === 'skill' && roots.opencode) notes.push('alsoReadByOpenCode')
  return notes
}

export function plansDir(home: string): string {
  return join(globalStateDir(home), 'plans')
}

export function storePlan(home: string, plan: GlobalSyncPlan): void {
  atomicWrite(join(plansDir(home), `${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n')
}

/** The plan as stored by the backend when it was shown (null if unknown) */
export function readStoredPlan(home: string, id: string): GlobalSyncPlan | null {
  if (!/^(plan|restore)-[0-9a-z-]+$/.test(id)) return null
  const p = join(plansDir(home), `${id}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as GlobalSyncPlan
}

export function newPlanId(prefix: 'plan' | 'restore'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * Plan for the given choices only. Nothing is written in the tool folders; the plan itself is stored in the global
 * state. opts.paths = the tool roots to validate against (default: detection with the confirmed overrides).
 */
export function planGlobalSync(
  home: string,
  choices: DeliveryChoice[],
  opts: { paths?: GlobalPathResult[] } = {}
): GlobalSyncPlan {
  const plan = computeGlobalPlan(home, choices, opts)
  storePlan(home, plan)
  return plan
}

/** The plan planGlobalSync would store, without storing it (used to show recipient states). Read-only */
export function computeGlobalPlan(
  home: string,
  choices: DeliveryChoice[],
  opts: { paths?: GlobalPathResult[]; variants?: VariantRecord[] } = {}
): GlobalSyncPlan {
  const variants = opts.variants ?? listGlobalVariants(home)
  const paths = opts.paths ?? resolveGlobalPaths(home)
  const roots: Partial<Record<GlobalTool, string>> = {}
  for (const p of paths) if (p.status === 'resolved') roots[p.tool] = p.paths[0]
  const excluded: GlobalExcluded[] = []
  const candidates: DeliveryChoice[] = []
  const seen = new Set<string>()
  for (const { choice, status } of choiceValidity(home, choices, variants)) {
    const dupKey = `${choice.variantId}\0${destinationKey(choice.destination)}\0${choice.destination}`
    if (seen.has(dupKey)) continue
    seen.add(dupKey)
    if (status !== 'valid') {
      excluded.push({ choice, reason: status })
      continue
    }
    const v = variants.find((x) => x.id === choice.variantId)!
    const root = roots[choice.tool]
    if (!root) {
      excluded.push({ choice, reason: 'toolUnavailable' })
      continue
    }
    if (!validDestination(choice.tool, v.kind, choice.destination, root)) {
      excluded.push({ choice, reason: 'invalidDestination' })
      continue
    }
    if (linkedAncestor(root, choice.destination)) {
      excluded.push({ choice, reason: 'linkedAncestor' })
      continue
    }
    if (
      choice.tool === 'codex' &&
      basename(destinationFile(choice.destination)) === 'AGENTS.md' &&
      existsSync(join(root, 'AGENTS.override.md'))
    ) {
      excluded.push({ choice, reason: 'shadowedByOverride' })
      continue
    }
    const why = unsupportedReason(v, choice.tool, choice.destination, root)
    if (why) {
      excluded.push({ choice, reason: why })
      continue
    }
    candidates.push(choice)
  }
  const conflicts = detectGlobalConflicts(home, candidates, variants)
  // A whole-file delivery and a section of the same file in one plan cannot both be honoured
  const wholeFiles = new Set(
    candidates
      .filter((c) => parseDestination(c.destination).kind === 'path')
      .map((c) => destinationKey(c.destination))
  )
  for (const c of candidates) {
    const d = parseDestination(c.destination)
    if (d.kind === 'section' && wholeFiles.has(destinationKey(d.file)))
      conflicts.push({
        type: 'nameCollision',
        variantIds: [c.variantId],
        tool: c.tool,
        destination: c.destination,
        digests: { current: null },
        reason: 'fileReplacedInSamePlan'
      })
  }
  const blocked = new Set(conflicts.map((c) => destinationKey(c.destination)))
  const deliveries = readDeliveries(home)
  const changes: GlobalChange[] = []
  for (const c of candidates) {
    if (blocked.has(destinationKey(c.destination))) continue
    const v = variants.find((x) => x.id === c.variantId)!
    const state = readDestination(c.destination, v.kind)
    const payload = variantPayload(v, c.destination)
    const after = payloadDigest(payload)
    const rec = deliveryAt(deliveries, c.destination)
    changes.push({
      choice: c,
      variantId: v.id,
      variantRevision: v.revision,
      variantName: v.name,
      kind: v.kind,
      tool: c.tool,
      destination: c.destination,
      op: opFor(state, after, rec, v.id),
      sourceDigest: v.revision,
      destinationDigest: state.digest,
      afterDigest: after,
      preview: previewFor(c.destination, state, payload),
      notes: notesFor(home, c.tool, v.kind, c.destination, roots),
      owner: ownerOf(rec)
    })
  }
  return {
    id: newPlanId('plan'),
    kind: 'sync',
    createdAt: new Date().toISOString(),
    libraryRevision: libraryRevision(variants),
    roots,
    changes,
    conflicts,
    excluded
  }
}

export interface RemovalRequest {
  destination: string
  /** Destination digest the user saw (null = none shown: the content must still be what the app delivered) */
  expectedDestinationDigest: string | null
}

function toolOf(roots: Partial<Record<GlobalTool, string>>, destination: string): GlobalTool {
  const file = resolve(destinationFile(destination))
  const t = (Object.keys(roots) as GlobalTool[]).find((k) => within(roots[k]!, file))
  return t ?? 'claude'
}

/**
 * Plan of explicit removals. Only destinations the app delivered (delivery records) can be removed; content edited
 * since the delivery needs a decision on what is there now. Disabling a recipient never produces removals by itself.
 */
export function planGlobalRemoval(
  home: string,
  items: RemovalRequest[],
  opts: { paths?: GlobalPathResult[] } = {}
): GlobalSyncPlan {
  const variants = listGlobalVariants(home)
  const paths = opts.paths ?? resolveGlobalPaths(home)
  const roots: Partial<Record<GlobalTool, string>> = {}
  for (const p of paths) if (p.status === 'resolved') roots[p.tool] = p.paths[0]
  const deliveries = readDeliveries(home)
  const changes: GlobalChange[] = []
  const conflicts: GlobalConflict[] = []
  const excluded: GlobalExcluded[] = []
  for (const item of items) {
    const rec = deliveryAt(deliveries, item.destination)
    const choice: DeliveryChoice = {
      variantId: rec?.variantId ?? '',
      variantRevision: rec?.variantRevision ?? '',
      tool: rec?.tool ?? toolOf(roots, item.destination),
      destination: item.destination,
      expectedDestinationDigest: item.expectedDestinationDigest
    }
    if (!rec) {
      excluded.push({ choice, reason: 'notManaged' })
      continue
    }
    const root = roots[rec.tool]
    if (!root) {
      excluded.push({ choice, reason: 'toolUnavailable' })
      continue
    }
    if (linkedAncestor(root, item.destination)) {
      excluded.push({ choice, reason: 'linkedAncestor' })
      continue
    }
    const state = readDestination(item.destination, rec.kind)
    if (state.digest === null) {
      excluded.push({ choice, reason: 'alreadyAbsent' })
      continue
    }
    const conflict = destinationConflict(choice, state, rec.deliveredDigest)
    if (conflict) {
      conflicts.push(conflict)
      continue
    }
    const d = parseDestination(item.destination)
    let preview: GlobalChange['preview']
    if (rec.kind === 'skill')
      preview = {
        before: null,
        after: null,
        files: compareTrees(treeFiles(d.kind === 'path' ? d.path : d.file), null)
      }
    else if (d.kind === 'section') {
      const buf = readFileSync(d.file)
      const sb = findSection(buf, d.section)
      const body =
        sb !== 'absent' && sb !== 'malformed' ? buf.subarray(sb.bodyStart, sb.bodyEnd) : null
      const b = text(body)
      const f = text(removeSection(buf, d.section))
      preview = {
        before: b.value,
        after: null,
        fileAfter: f.value ?? '',
        ...(b.truncated || f.truncated ? { truncated: true } : {})
      }
    } else {
      const b = text(readFileSync(d.path))
      preview = { before: b.value, after: null, ...(b.truncated ? { truncated: true } : {}) }
    }
    changes.push({
      choice,
      variantId: rec.variantId,
      variantRevision: rec.variantRevision,
      variantName: variants.find((v) => v.id === rec.variantId)?.name ?? rec.variantId,
      kind: rec.kind,
      tool: rec.tool,
      destination: item.destination,
      op: 'remove',
      sourceDigest: '',
      destinationDigest: state.digest,
      afterDigest: null,
      preview,
      notes: [],
      owner: ownerOf(rec)
    })
  }
  const plan: GlobalSyncPlan = {
    id: newPlanId('plan'),
    kind: 'sync',
    createdAt: new Date().toISOString(),
    libraryRevision: libraryRevision(variants),
    roots,
    changes,
    conflicts,
    excluded
  }
  storePlan(home, plan)
  return plan
}

// ---------------------------------------------------------------- apply

export interface ApplyHooks {
  /** Called once the backup of change `index` is complete (failure injection in tests) */
  afterBackup?: (index: number) => void
}

export interface GlobalSyncResult {
  operationId: string
  status: 'completed' | 'refused' | 'partial' | 'failed'
  results: GlobalChangeResult[]
  backups: { destination: string; path: string }[]
  /** Whole-operation refusal (no write attempted) */
  error?: { code: string; message: string }
}

const appliedMarker = (home: string, planId: string): string =>
  join(plansDir(home), `${planId}.applied.json`)

/** Fields that define what a plan writes; a plan received for apply must match the stored one on all of them */
function planFingerprint(p: GlobalSyncPlan): string {
  return JSON.stringify({
    id: p.id,
    kind: p.kind,
    restoreOf: p.restoreOf ?? null,
    changes: (p.changes ?? []).map((c) => [
      c.variantId,
      c.variantRevision,
      c.kind,
      c.tool,
      c.destination,
      c.op,
      c.sourceDigest,
      c.destinationDigest,
      c.afterDigest,
      c.restoreFrom ?? null,
      ownerKey(c.owner)
    ])
  })
}

export function overallStatus(results: GlobalChangeResult[]): GlobalSyncResult['status'] {
  const notDone = results.some((r) =>
    ['refused', 'failed', 'notAttempted', 'pending'].includes(r.status)
  )
  if (!notDone) return 'completed'
  if (results.some((r) => r.status === 'done')) return 'partial'
  return results.some((r) => r.status === 'failed') ? 'failed' : 'refused'
}

function upsertDelivery(home: string, rec: DeliveryRecord): void {
  const k = destinationKey(rec.destination)
  writeDeliveries(home, [
    ...readDeliveries(home).filter((r) => destinationKey(r.destination) !== k),
    rec
  ])
}

function dropDelivery(home: string, destination: string): void {
  const k = destinationKey(destination)
  writeDeliveries(
    home,
    readDeliveries(home).filter((r) => destinationKey(r.destination) !== k)
  )
}

/** Content a change delivers, read now; null = the change removes the destination content */
export type PayloadSource = (change: GlobalChange) => Buffer | string | null

function errCode(e: unknown, fallback: string): string {
  return (e as NodeJS.ErrnoException).code ?? fallback
}

/** What a destination looked like before the app first delivered to it (for removals that give it back) */
interface RemovalOrigin {
  /** Section destinations: the instructions file before the first delivery (null = it did not exist) */
  file: Buffer | null
  fileExisted: boolean
  existingAncestor?: string
}

/**
 * The backup taken before the first delivery of a destination: the restored operation's own backup, or the chain of
 * delivery records back to the operation that created the content. null when it cannot be established.
 */
function removalOrigin(home: string, change: GlobalChange): RemovalOrigin | null {
  let found: { meta: BackupMeta; dir: string } | null = null
  if (change.restoreFrom) {
    const meta = readBackupMeta(change.restoreFrom)
    if (meta) found = { meta, dir: change.restoreFrom }
  } else {
    const key = destinationKey(change.destination)
    let rec: DeliveryRecord | null | undefined = deliveryAt(
      readDeliveries(home),
      change.destination
    )
    for (let i = 0; rec && i < 50; i++) {
      const r = readOperation(home, rec.operationId)?.results.find(
        (x) => x.backup && destinationKey(x.destination) === key
      )
      const meta = r?.backup ? readBackupMeta(r.backup) : null
      if (!meta || !r?.backup) break
      if (meta.shape === 'absent') {
        found = { meta, dir: r.backup }
        break
      }
      rec = meta.previousDelivery
    }
  }
  if (!found || found.meta.shape !== 'absent') return null
  const fp = join(found.dir, 'file')
  return {
    file: existsSync(fp) ? readFileSync(fp) : null,
    fileExisted: !!found.meta.fileExisted,
    ...(found.meta.existingAncestor ? { existingAncestor: found.meta.existingAncestor } : {})
  }
}

/** Writes one change after its backup; throws ChangedSinceCheck on a divergence seen right before writing */
function writeChange(
  change: GlobalChange,
  payload: Buffer | string | null,
  state: DestinationState,
  onRestored: () => void,
  origin: RemovalOrigin | null
): string | undefined {
  const d = parseDestination(change.destination)
  if (d.kind === 'section') {
    const buf = existsSync(d.file) ? readFileSync(d.file) : null
    const s = buf ? findSection(buf, d.section) : 'absent'
    if (s === 'malformed') throw new ChangedSinceCheck()
    const body = buf && s !== 'absent' ? bytesDigest(buf.subarray(s.bodyStart, s.bodyEnd)) : null
    if (body !== state.digest) throw new ChangedSinceCheck()
    if (payload === null) {
      let next = removeSection(buf ?? Buffer.alloc(0), d.section)
      // Back to the bytes the file had before the first delivery when nothing else changed since
      if (origin && !origin.fileExisted && next.length === 0) {
        removeFileChecked(d.file, bytesDigest(buf!))
        return undefined
      }
      if (origin?.file && next.equals(Buffer.concat([origin.file, sectionSeparator(origin.file)])))
        next = origin.file
      atomicWriteBytes(d.file, next, buf ? bytesDigest(buf) : null)
      return undefined
    }
    atomicWriteBytes(
      d.file,
      renderSection(buf, d.section, payload as Buffer),
      buf ? bytesDigest(buf) : null
    )
    return undefined
  }
  if (change.kind === 'rule') {
    if (payload === null) {
      removeFileChecked(d.path, state.digest!)
      if (origin?.existingAncestor) pruneEmptyDirs(dirname(d.path), origin.existingAncestor)
    } else atomicWriteBytes(d.path, payload as Buffer, state.digest)
    return undefined
  }
  // Skill folder: copy beside, verify, move the current folder aside, rename into place, drop the aside copy
  const parent = dirname(d.path)
  const aside = join(parent, appTmpName(`${basename(d.path)}.old`, randomBytes(4).toString('hex')))
  const vacate = (): void => {
    const st = lstatSync(d.path, { throwIfNoEntry: false })
    if (state.digest === null) {
      if (st) throw new ChangedSinceCheck()
      return
    }
    if (!st || st.isSymbolicLink() || globalTreeDigest(d.path) !== state.digest)
      throw new ChangedSinceCheck()
    renameSync(d.path, aside)
  }
  if (payload === null) {
    vacate()
    if (origin?.existingAncestor) {
      try {
        rmSync(aside, { recursive: true, force: false })
      } catch {
        return aside
      }
      pruneEmptyDirs(parent, origin.existingAncestor)
      return undefined
    }
  } else {
    const r = deliverDir(payload as string, d.path, {
      expectedHash: change.afterDigest!,
      contentHash: globalTreeDigest,
      vacate,
      restore: () => {
        if (existsSync(aside)) {
          renameSync(aside, d.path)
          onRestored()
        }
      }
    })
    if (!r.ok) {
      if (r.reason === 'hashMismatch') throw new ChangedSinceCheck()
      throw Object.assign(new Error(r.reason), { code: 'writeFailed' })
    }
  }
  if (!existsSync(aside)) return undefined
  try {
    rmSync(aside, { recursive: true, force: false })
    return undefined
  } catch {
    return aside
  }
}

/**
 * Executes a stored plan: the plan received must match the one the backend stored when it was shown, and a plan is
 * executed at most once (an interrupted one is not resumed). Every change re-checks its source and destination; a
 * divergence refuses that change, a failure stops the remaining ones. Not atomic across destinations: the result
 * lists what was applied, refused, failed and not attempted, with the backups taken.
 */
export function executePlan(
  home: string,
  approvedPlan: GlobalSyncPlan,
  payloadOf: PayloadSource,
  opts: { hooks?: ApplyHooks; variantCheck?: boolean } = {}
): GlobalSyncResult {
  const refuse = (code: string, message: string): GlobalSyncResult => ({
    operationId: '',
    status: 'refused',
    results: [],
    backups: [],
    error: { code, message }
  })
  const stored = readStoredPlan(home, approvedPlan.id)
  if (!stored) return refuse('unknownPlan', 'no stored preview with this id')
  if (planFingerprint(stored) !== planFingerprint(approvedPlan))
    return refuse('planMismatch', 'the plan differs from the stored preview')
  if (existsSync(appliedMarker(home, stored.id)))
    return refuse('planAlreadyApplied', 'this preview was already used; make a new one')
  const operationId = newOperationId()
  const lock = acquireApplyLock(home, operationId)
  if (!lock.ok)
    return refuse(
      lock.code,
      lock.code === 'applyInProgress'
        ? 'another apply is running on this library'
        : 'applying is available on Windows only in this release'
    )
  try {
    if (existsSync(appliedMarker(home, stored.id)))
      return refuse('planAlreadyApplied', 'this preview was already used; make a new one')
    atomicWrite(appliedMarker(home, stored.id), JSON.stringify({ operationId }) + '\n')
    const rec: GlobalOperationRecord = {
      version: 1,
      id: operationId,
      planId: stored.id,
      kind: stored.kind,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: '',
      status: 'running',
      ...(stored.restoreOf ? { restoreOf: stored.restoreOf } : {}),
      results: stored.changes.map((c, index) => ({
        index,
        destination: c.destination,
        tool: c.tool,
        kind: c.kind,
        op: c.op,
        variantId: c.variantId,
        status: 'pending',
        phase: 'pending',
        beforeDigest: c.destinationDigest,
        afterDigest: c.afterDigest
      }))
    }
    writeOperation(home, rec)
    const variants = opts.variantCheck === false ? [] : listGlobalVariants(home)
    let stop = false
    stored.changes.forEach((change, i) => {
      const res = rec.results[i]
      if (stop) {
        res.status = 'notAttempted'
        return
      }
      const done = (status: GlobalChangeResult['status'], code?: string): void => {
        res.status = status
        if (code) res.code = code
        writeOperation(home, rec)
      }
      // Re-check of the inputs shown in the preview
      if (opts.variantCheck !== false && !change.restoreFrom && change.op !== 'remove') {
        const v = variants.find((x) => x.id === change.variantId)
        if (!v || v.revision !== change.variantRevision) return done('refused', 'changedSinceCheck')
      }
      let payload: Buffer | string | null
      try {
        payload = payloadOf(change)
      } catch {
        return done('refused', 'changedSinceCheck')
      }
      if (payload !== null && payloadDigest(payload) !== change.afterDigest)
        return done('refused', 'changedSinceCheck')
      // The destination must still belong to whoever owned it in the preview (e.g. not left unmanaged since)
      if (
        ownerKey(ownerOf(deliveryAt(readDeliveries(home), change.destination))) !==
        ownerKey(change.owner)
      )
        return done('refused', 'ownershipChanged')
      // A folder between the root and the destination may have become a link since the preview
      const root = stored.roots[change.tool]
      if (!root || linkedAncestor(root, change.destination))
        return done('refused', 'linkedAncestor')
      const state = readDestination(change.destination, change.kind)
      if (state.digest !== change.destinationDigest) return done('refused', 'changedSinceCheck')
      res.phase = 'checked'
      const delivered = (): DeliveryRecord => ({
        destination: change.destination,
        tool: change.tool,
        kind: change.kind,
        variantId: change.variantId,
        variantRevision: change.variantRevision,
        deliveredDigest: change.afterDigest!,
        at: new Date().toISOString(),
        operationId
      })
      // A restore gives the destination back its earlier owner (or none), even when the content is already as before
      const restoreOwnership = (): void => {
        const before = readBackupMeta(change.restoreFrom!)?.previousDelivery
        if (before) upsertDelivery(home, before)
        else dropDelivery(home, change.destination)
      }
      if (change.op === 'unchanged') {
        if (change.restoreFrom) {
          restoreOwnership()
          res.phase = 'recorded'
        }
        return done('unchanged')
      }
      if (change.op === 'adopt') {
        upsertDelivery(home, delivered())
        res.phase = 'recorded'
        return done('done')
      }
      try {
        res.backup = writeBackup(
          home,
          operationId,
          i,
          change,
          state,
          deliveryAt(readDeliveries(home), change.destination) ?? null
        )
      } catch (e) {
        if (e instanceof ChangedSinceCheck) return done('refused', 'changedSinceCheck')
        stop = true
        return done('failed', 'backupFailed')
      }
      res.phase = 'backedUp'
      writeOperation(home, rec)
      opts.hooks?.afterBackup?.(i)
      let restored = false
      try {
        const origin = payload === null ? removalOrigin(home, change) : null
        const leftover = writeChange(change, payload, state, () => (restored = true), origin)
        if (leftover) res.leftover = leftover
      } catch (e) {
        if (e instanceof ChangedSinceCheck) {
          res.recovery = 'notNeeded'
          return done('refused', 'changedSinceCheck')
        }
        stop = true
        const now = readDestination(change.destination, change.kind).digest
        res.recovery =
          now === change.destinationDigest ? (restored ? 'restored' : 'notNeeded') : 'restoreFailed'
        return done('failed', errCode(e, 'writeFailed'))
      }
      res.phase = 'written'
      writeOperation(home, rec)
      const after = readDestination(change.destination, change.kind).digest
      if (after !== change.afterDigest) {
        stop = true
        return done('failed', 'verifyFailed')
      }
      if (change.restoreFrom) restoreOwnership()
      else if (change.afterDigest === null) dropDelivery(home, change.destination)
      else upsertDelivery(home, delivered())
      res.phase = 'recorded'
      return done('done')
    })
    rec.status = overallStatus(rec.results)
    rec.finishedAt = new Date().toISOString()
    writeOperation(home, rec)
    return {
      operationId,
      status: rec.status,
      results: rec.results,
      backups: rec.results
        .filter((r) => r.backup)
        .map((r) => ({ destination: r.destination, path: r.backup! }))
    }
  } finally {
    lock.release()
  }
}

/** Applies an approved sync plan (see executePlan) */
export function applyGlobalSync(
  home: string,
  approvedPlan: GlobalSyncPlan,
  opts: { hooks?: ApplyHooks } = {}
): GlobalSyncResult {
  const variants = new Map(listGlobalVariants(home).map((v) => [v.id, v]))
  return executePlan(
    home,
    approvedPlan,
    (c) => {
      if (c.op === 'remove') return null
      const v = variants.get(c.variantId)
      if (!v) throw new ChangedSinceCheck()
      return variantPayload(v, c.destination)
    },
    opts
  )
}
