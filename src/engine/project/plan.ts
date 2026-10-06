/**
 * Project delivery previews and their decisions (spec 2026-10-06 project delivery §User flow — deliver, §Physical
 * collisions and existing content, §Preview, Apply and restore guarantees).
 * - Requests are validated completely (exact keys, backend ids, no duplicate logical selection, slots valid for their
 *   tool and kind) before any content is read. Distinct tools sharing one physical file are not duplicates.
 * - Each selected variant is read from validated library storage; each destination is observed without following
 *   links; ambiguous aliases, overlaps with the other scope and changed projects are excluded with their reason.
 * - One physical destination is one change with every recipient label and every incoming variant. Absent → Create,
 *   equal → Unchanged (ownership untouched: nothing is adopted), different → Skip until the user chooses Replace, even
 *   when Illithid delivered it earlier. Several incoming variants need an explicit choice (one variant or Skip).
 * - The backend stores the plan with every binding (projects, variants, destinations, owners, decisions) and a
 *   fingerprint; a decision makes a new plan and spends the old one; anything that changed since the preview makes
 *   the dependent plan stale. A plan is used at most once (applied, replaced or discarded).
 * Previews write nothing in the projects.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { recheckBinding } from '../census/paths'
import type { CandidateBinding, CensusEntry, DiscoveryHandle } from '../census/types'
import { readStoredVariants, type StoredVariant } from '../globalImport'
import { GLOBAL_TOOLS, type GlobalTool } from '../globalPaths'
import { atomicWrite } from '../write'
import { observeLibraryVariant, type VariantObservation } from './content'
import {
  inspectProjectDestination,
  parseProjectSlot,
  projectSlotPath,
  resolveProjectDestination
} from './destinations'
import { findScopeOverlap, projectOwnerAt } from './ownership'
import { projectPlansDir, readProjectDeliveries } from './state'
import {
  ProjectError,
  type ProjectContext,
  type ProjectDecision,
  type ProjectDeliveryRecord,
  type ProjectDestinationObservation,
  type ProjectFileChange,
  type ProjectPlanChange,
  type ProjectPlanView,
  type ProjectPreview,
  type ProjectSelection
} from './types'

/** Bytes of a rule shown per side in a preview (the comparison itself covers the whole content) */
export const PROJECT_PREVIEW_BYTES = 256 * 1024

const invalid = (message: string): ProjectError => new ProjectError('invalid', message)
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------- stored plans

/** A selected project as the plan binds it */
export interface PlanProject {
  id: string
  path: string
  name: string
  binding: CandidateBinding
}

/** What a sync change binds: the observed destination and who owned it */
export interface PlanDestinationBinding {
  candidateId: string
  destination: string
  relativePath: string
  kind: 'rule' | 'skill'
  observation: Omit<ProjectDestinationObservation, 'project' | 'localSlots'>
  owner: ProjectDeliveryRecord | null
}

export interface PlanBindings {
  discoveryId: string
  root: string
  projects: PlanProject[]
  selections: ProjectSelection[]
  variants: Omit<VariantObservation, 'manifest'>[]
  destinations: Record<string, PlanDestinationBinding>
  /** Restore plans: the bound backup and current state of each destination (operations.ts / restore.ts) */
  restore?: unknown
}

export interface ProjectStoredPlan {
  version: 1
  id: string
  kind: 'sync' | 'restore'
  view: ProjectPlanView
  bindings: PlanBindings
  decisions: ProjectDecision[]
  fingerprint: string
}

const PLAN_ID = /^(pplan|prestore)-[0-9a-z]+-[0-9a-f]{8}$/

export function newProjectPlanId(kind: 'sync' | 'restore'): string {
  return `${kind === 'sync' ? 'pplan' : 'prestore'}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function projectPlanFingerprint(p: Omit<ProjectStoredPlan, 'fingerprint'>): string {
  return sha(JSON.stringify([p.version, p.id, p.kind, p.view, p.bindings, p.decisions]))
}

export function storeProjectPlan(
  home: string,
  p: Omit<ProjectStoredPlan, 'fingerprint'>
): ProjectStoredPlan {
  const stored: ProjectStoredPlan = { ...p, fingerprint: projectPlanFingerprint(p) }
  atomicWrite(join(projectPlansDir(home), `${p.id}.json`), JSON.stringify(stored, null, 2) + '\n')
  return stored
}

/** The plan the backend stored, when its id, schema and fingerprint are intact (null otherwise) */
export function readProjectPlan(home: string, planId: string): ProjectStoredPlan | null {
  if (typeof planId !== 'string' || !PLAN_ID.test(planId)) return null
  const p = join(projectPlansDir(home), `${planId}.json`)
  if (!existsSync(p)) return null
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as ProjectStoredPlan
    if (
      o.version !== 1 ||
      o.id !== planId ||
      (o.kind !== 'sync' && o.kind !== 'restore') ||
      o.view?.id !== planId ||
      !o.bindings ||
      !Array.isArray(o.decisions) ||
      typeof o.fingerprint !== 'string'
    )
      return null
    const { fingerprint, ...rest } = o
    return projectPlanFingerprint(rest) === fingerprint ? o : null
  } catch {
    return null
  }
}

const usedMarker = (home: string, planId: string): string =>
  join(projectPlansDir(home), `${planId}.used`)

export const projectPlanUsed = (home: string, planId: string): boolean =>
  existsSync(usedMarker(home, planId))

/** Spends a plan (apply, decision or discard); false when it was already spent. Exclusive create, never undone */
export function consumeProjectPlan(home: string, planId: string, by: string): boolean {
  if (!PLAN_ID.test(planId)) return false
  mkdirSync(projectPlansDir(home), { recursive: true })
  try {
    writeFileSync(
      usedMarker(home, planId),
      JSON.stringify({ by, at: new Date().toISOString() }) + '\n',
      {
        flag: 'wx'
      }
    )
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

/** Closing a preview: its capability is spent, nothing is written in any project */
export function discardProjectPlan(home: string, planId: string): void {
  if (!readProjectPlan(home, planId)) throw new ProjectError('unknownPlan', 'No such preview.')
  consumeProjectPlan(home, planId, 'discarded')
}

// ---------------------------------------------------------------- request validation

const TOOLS = new Set<string>(GLOBAL_TOOLS)

/** Exactly-keyed selections of this discovery's available projects and of existing variants; refused before reads */
export function validateSelections(
  discovery: DiscoveryHandle,
  selections: unknown,
  stored: ReadonlyMap<string, StoredVariant & { dir: string }>
): ProjectSelection[] {
  if (!Array.isArray(selections) || selections.length === 0)
    throw invalid('Select at least one delivery.')
  const seen = new Set<string>()
  return selections.map((x) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x))
      throw invalid('Each selection is an object.')
    const o = x as Record<string, unknown>
    if (Object.keys(o).sort().join(',') !== 'candidateId,slot,tool,variantId')
      throw invalid('A selection has exactly candidateId, variantId, tool and slot.')
    if (typeof o.candidateId !== 'string' || !discovery.bindings.has(o.candidateId))
      throw invalid('Not an available project of this listing.')
    if (typeof o.variantId !== 'string' || !stored.has(o.variantId))
      throw invalid('Not a variant of the library.')
    if (typeof o.tool !== 'string' || !TOOLS.has(o.tool)) throw invalid('Unknown tool.')
    const slot = parseProjectSlot(o.slot)
    const v = stored.get(o.variantId)!
    // The slot must exist for this kind and tool (names are checked with the variant's content)
    projectSlotPath(v.kind, v.kind === 'skill' ? 'x' : 'x.md', o.tool as GlobalTool, slot)
    const s: ProjectSelection = {
      candidateId: o.candidateId,
      variantId: o.variantId,
      tool: o.tool as GlobalTool,
      slot
    }
    const key = JSON.stringify([s.candidateId, s.variantId, s.tool, s.slot])
    if (seen.has(key)) throw invalid('The same delivery is selected twice.')
    seen.add(key)
    return s
  })
}

function storedVariants(home: string): Map<string, StoredVariant & { dir: string }> {
  return new Map(readStoredVariants(home).variants.map((v) => [v.id, v]))
}

// ---------------------------------------------------------------- previews

/** First bytes of a file, only when it is still the observed entry (a swap since is not shown) */
async function head(
  path: string,
  print?: string
): Promise<{ text: string | null; truncated: boolean }> {
  try {
    const fh = await fsp.open(path, 'r')
    try {
      const st = await fh.stat({ bigint: true })
      if (print && `file:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}` !== print)
        return { text: null, truncated: false }
      const buf = Buffer.alloc(Math.min(Number(st.size), PROJECT_PREVIEW_BYTES))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return {
        text: buf.subarray(0, bytesRead).toString('utf8'),
        truncated: st.size > BigInt(PROJECT_PREVIEW_BYTES)
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { text: null, truncated: false }
  }
}

/** Every entry of two complete trees compared (files and folders, hidden ones and .DS_Store included) */
export function compareManifests(
  before: readonly CensusEntry[] | null,
  after: readonly CensusEntry[] | null
): ProjectFileChange[] {
  const b = new Map((before ?? []).map((e) => [e.path, e]))
  const a = new Map((after ?? []).map((e) => [e.path, e]))
  return [...new Set([...b.keys(), ...a.keys()])].sort(ordinal).map((path) => {
    const x = b.get(path)
    const y = a.get(path)
    const change: ProjectFileChange['change'] = !x
      ? 'added'
      : !y
        ? 'removed'
        : x.kind === y.kind && x.bytes === y.bytes && x.digest === y.digest
          ? 'same'
          : 'changed'
    return { path, change }
  })
}

async function previewOf(
  obs: ProjectDestinationObservation,
  incoming: VariantObservation | null
): Promise<ProjectPreview> {
  if (obs.kind === 'skill')
    return {
      before: null,
      after: null,
      files: compareManifests(
        obs.shape === 'dir' ? (obs.manifest ?? []) : null,
        incoming?.manifest ?? null
      )
    }
  const before =
    obs.shape === 'file' ? await head(obs.destination, obs.identities.at(-1)?.fingerprint) : null
  const after = incoming
    ? await head(incoming.contentPath, incoming.identities.at(-1)?.fingerprint)
    : null
  return {
    before: before?.text ?? null,
    after: after?.text ?? null,
    ...(before?.truncated || after?.truncated ? { truncated: true } : {})
  }
}

// ---------------------------------------------------------------- computation

export interface PlanInput {
  discoveryId: string
  root: string
  projects: PlanProject[]
  selections: ProjectSelection[]
}

const destinationIdOf = (physicalKey: string, destination: string): string =>
  `d-${sha(`${physicalKey}\0${destination}`).slice(0, 16)}`

const stateOf = (
  obs: Pick<ProjectDestinationObservation, 'shape' | 'digest'>,
  v: { revision: string }
): ProjectPlanChange['state'] =>
  obs.shape === 'absent' ? 'absent' : obs.digest === v.revision ? 'identical' : 'different'

/** Actions a decision may take for a state (Skip is always possible) */
export function actionsFor(state: ProjectPlanChange['state']): ProjectPlanChange['action'][] {
  return state === 'absent'
    ? ['create', 'skip']
    : state === 'identical'
      ? ['unchanged', 'skip']
      : ['replace', 'skip']
}

/**
 * The sync plan for these selections and decisions, observing everything now. Returns the view and every binding the
 * apply step rechecks; nothing is written.
 */
export async function computeSyncPlan(
  ctx: ProjectContext,
  id: string,
  input: PlanInput,
  decisions: readonly ProjectDecision[]
): Promise<{ view: ProjectPlanView; bindings: PlanBindings }> {
  const stored = storedVariants(ctx.home)
  const excluded: ProjectPlanView['excluded'] = []
  const exclude = (s: ProjectSelection, reason: string, destination?: string): void => {
    excluded.push({ selection: s, reason, ...(destination ? { destination } : {}) })
  }
  // Variants, each read once from validated storage
  const variants = new Map<string, VariantObservation>()
  const variantRefusal = new Map<string, string>()
  for (const vid of new Set(input.selections.map((s) => s.variantId))) {
    const v = stored.get(vid)
    if (!v) {
      variantRefusal.set(vid, 'unknownVariant')
      continue
    }
    try {
      variants.set(vid, await observeLibraryVariant(ctx.home, v, ctx.signal))
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e
      variantRefusal.set(vid, e.reason ?? e.code)
    }
  }
  // Projects, each checked once
  const projects = new Map(input.projects.map((p) => [p.id, p]))
  const changedProjects = new Set<string>()
  for (const p of input.projects)
    try {
      await recheckBinding(p.binding)
    } catch {
      changedProjects.add(p.id)
    }
  // Destinations by exact path
  const byPath = new Map<string, { selections: ProjectSelection[]; project: PlanProject }>()
  for (const s of input.selections) {
    const p = projects.get(s.candidateId)!
    if (changedProjects.has(p.id)) {
      exclude(s, 'projectChanged')
      continue
    }
    const v = variants.get(s.variantId)
    if (!v) {
      exclude(s, variantRefusal.get(s.variantId) ?? 'unknownVariant')
      continue
    }
    let destination: string
    try {
      destination = resolveProjectDestination(p.binding, v.kind, v.name, s.tool, s.slot)
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e
      exclude(s, 'invalidSlot')
      continue
    }
    const g = byPath.get(destination) ?? { selections: [], project: p }
    g.selections.push(s)
    byPath.set(destination, g)
  }
  // Observations (refusals per destination), then ambiguous case-only absent names under one folder
  const observed = new Map<string, ProjectDestinationObservation>()
  for (const [destination, g] of byPath) {
    const kind = variants.get(g.selections[0].variantId)!.kind
    try {
      observed.set(
        destination,
        await inspectProjectDestination(ctx, g.project.binding, destination, kind)
      )
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e
      for (const s of g.selections) exclude(s, e.reason ?? e.code, destination)
    }
  }
  const absentNames = new Map<string, Set<string>>()
  for (const o of observed.values())
    if (o.shape === 'absent') {
      const k = `${o.existingAncestor.fingerprint}\0${o.remaining.join('/').toLowerCase()}`
      absentNames.set(k, (absentNames.get(k) ?? new Set()).add(o.remaining.join('/')))
    }
  for (const [destination, o] of [...observed]) {
    const k = `${o.existingAncestor.fingerprint}\0${o.remaining.join('/').toLowerCase()}`
    const ambiguous = o.shape === 'absent' && (absentNames.get(k)?.size ?? 0) > 1
    const overlap = ambiguous ? null : findScopeOverlap(ctx.home, destination, 'project')
    if (ambiguous || overlap) {
      for (const s of byPath.get(destination)!.selections)
        exclude(s, ambiguous ? 'ambiguousCase' : `scopeOverlap:${overlap!.reason}`, destination)
      observed.delete(destination)
    }
  }
  // One change per physical destination
  const physical = new Map<string, { destination: string; selections: ProjectSelection[] }>()
  for (const [destination, o] of observed) {
    const g = physical.get(o.physicalKey) ?? { destination, selections: [] }
    g.selections.push(...byPath.get(destination)!.selections)
    physical.set(o.physicalKey, g)
  }
  const records = readProjectDeliveries(ctx.home)
  const changes: ProjectPlanChange[] = []
  const collisions: ProjectPlanView['collisions'] = []
  const destinations: Record<string, PlanDestinationBinding> = {}
  for (const [physicalKey, g] of physical) {
    const obs = observed.get(g.destination)!
    const project = projects.get(g.selections[0].candidateId)!
    const destinationId = destinationIdOf(physicalKey, g.destination)
    const incomingIds = [...new Set(g.selections.map((s) => s.variantId))]
    const incoming = incomingIds.map((vid) => variants.get(vid)!)
    const decision = decisions.find((d) => d.destinationId === destinationId) as
      Extract<ProjectDecision, { variantId: string | null }> | undefined
    const selected = decision
      ? decision.variantId === null
        ? null
        : (incoming.find((v) => v.id === decision.variantId) ?? null)
      : incoming.length === 1
        ? incoming[0]
        : null
    const state: ProjectPlanChange['state'] = selected
      ? stateOf(obs, selected)
      : obs.shape === 'absent'
        ? 'absent'
        : incoming.every((v) => stateOf(obs, v) === 'identical')
          ? 'identical'
          : 'different'
    const action: ProjectPlanChange['action'] = decision
      ? decision.action
      : !selected
        ? 'skip'
        : state === 'absent'
          ? 'create'
          : state === 'identical'
            ? 'unchanged'
            : 'skip'
    if (incoming.length > 1 && !decision)
      collisions.push({ destinationId, variantIds: incomingIds })
    const owner = projectOwnerAt(records, g.destination, obs.physicalKey)
    const recipients = GLOBAL_TOOLS.filter((t) => g.selections.some((s) => s.tool === t))
    const relativePath = relative(project.path, g.destination).split(sep).join('/')
    changes.push({
      destinationId,
      destination: g.destination,
      relativePath,
      project: { id: project.id, path: project.path, name: project.name },
      kind: obs.kind,
      recipients,
      incoming: incoming.map((v) => ({
        variantId: v.id,
        variantRevision: v.revision,
        kind: v.kind,
        name: v.name
      })),
      selectedVariantId: selected?.id ?? null,
      state,
      beforeDigest: obs.digest,
      afterDigest: action === 'create' || action === 'replace' ? selected!.revision : obs.digest,
      owner,
      preview: await previewOf(obs, selected ?? (incoming.length === 1 ? incoming[0] : null)),
      action,
      localSlots: obs.localSlots
    })
    const { project: _p, localSlots: _l, ...observation } = obs
    void _p
    void _l
    destinations[destinationId] = {
      candidateId: project.id,
      destination: g.destination,
      relativePath,
      kind: obs.kind,
      observation,
      owner
    }
  }
  changes.sort(
    (a, b) => ordinal(a.project.name, b.project.name) || ordinal(a.relativePath, b.relativePath)
  )
  const view: ProjectPlanView = {
    id,
    kind: 'sync',
    createdAt: new Date().toISOString(),
    root: input.root,
    changes,
    collisions,
    excluded,
    applicable:
      collisions.length === 0 &&
      changes.some((c) => c.action === 'create' || c.action === 'replace')
  }
  const bindings: PlanBindings = {
    discoveryId: input.discoveryId,
    root: input.root,
    projects: input.projects,
    selections: input.selections,
    variants: [...variants.values()].map(({ manifest: _m, ...v }) => (void _m, v)),
    destinations
  }
  return { view, bindings }
}

/**
 * Preview of the selected deliveries under one root (the discovery). Validated before any read; stored by the backend
 * for one Apply. No recipient is written.
 */
export async function planProjectDelivery(
  ctx: ProjectContext,
  discovery: DiscoveryHandle,
  selections: readonly ProjectSelection[]
): Promise<ProjectPlanView> {
  ctx.signal.throwIfAborted()
  const valid = validateSelections(discovery, selections, storedVariants(ctx.home))
  const ids = new Set(valid.map((s) => s.candidateId))
  const projects: PlanProject[] = discovery.view.candidates
    .filter((c) => ids.has(c.id))
    .map((c) => ({ id: c.id, path: c.path, name: c.name, binding: discovery.bindings.get(c.id)! }))
  const id = newProjectPlanId('sync')
  const input: PlanInput = {
    discoveryId: discovery.view.id,
    root: discovery.view.root,
    projects,
    selections: valid
  }
  const { view, bindings } = await computeSyncPlan(ctx, id, input, [])
  storeProjectPlan(ctx.home, { version: 1, id, kind: 'sync', view, bindings, decisions: [] })
  return view
}

/** Exactly-keyed decisions on the changes of a stored plan, consistent with what that plan observed */
export function validateDecisions(plan: ProjectStoredPlan, decisions: unknown): ProjectDecision[] {
  if (!Array.isArray(decisions) || decisions.length === 0) throw invalid('No decision.')
  const seen = new Set<string>()
  return decisions.map((x) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x))
      throw invalid('Each decision is an object.')
    const o = x as Record<string, unknown>
    const keys = Object.keys(o).sort().join(',')
    const change =
      typeof o.destinationId === 'string'
        ? plan.view.changes.find((c) => c.destinationId === o.destinationId)
        : undefined
    if (!change) throw invalid('Not a destination of this preview.')
    if (seen.has(change.destinationId)) throw invalid('A destination is decided twice.')
    seen.add(change.destinationId)
    if (plan.kind === 'restore') {
      if (keys !== 'action,destinationId' || (o.action !== 'restore' && o.action !== 'skip'))
        throw invalid('A restore decision is restore or skip.')
      if (o.action === 'restore' && !change.restore)
        throw invalid('This destination cannot be restored.')
      return { destinationId: change.destinationId, action: o.action }
    }
    if (keys !== 'action,destinationId,variantId') throw invalid('Unexpected decision keys.')
    if (o.variantId === null) {
      if (o.action !== 'skip') throw invalid('Without a variant the only action is Skip.')
      return { destinationId: change.destinationId, variantId: null, action: 'skip' }
    }
    const v = change.incoming.find((i) => i.variantId === o.variantId)
    if (!v) throw invalid('Not an incoming variant of this destination.')
    const state = stateOf(
      { shape: change.beforeDigest === null ? 'absent' : 'file', digest: change.beforeDigest },
      {
        revision: v.variantRevision
      }
    )
    if (!actionsFor(state).includes(o.action as ProjectPlanChange['action']))
      throw invalid(`${String(o.action)} does not fit what the destination holds (${state}).`)
    return {
      destinationId: change.destinationId,
      variantId: v.variantId,
      action: o.action as 'create' | 'unchanged' | 'skip' | 'replace'
    }
  })
}

/** Restore plans are recomputed by restore.ts; registered here to keep one decision entry point */
export type RestoreRecompute = (
  ctx: ProjectContext,
  id: string,
  old: ProjectStoredPlan,
  decisions: readonly ProjectDecision[]
) => Promise<{ view: ProjectPlanView; bindings: PlanBindings }>
let restoreRecompute: RestoreRecompute | null = null
export function registerRestoreRecompute(fn: RestoreRecompute): void {
  restoreRecompute = fn
}

/**
 * Applies the user's decisions to a stored plan: everything is observed again, and anything that changed since the
 * preview makes it stale (a new preview is needed). Returns a newly bound plan; the old one is spent either way.
 */
export async function decideProjectPlan(
  ctx: ProjectContext,
  planId: string,
  decisions: readonly ProjectDecision[]
): Promise<ProjectPlanView> {
  ctx.signal.throwIfAborted()
  const old = readProjectPlan(ctx.home, planId)
  if (!old) throw new ProjectError('unknownPlan', 'No such preview.')
  if (projectPlanUsed(ctx.home, planId))
    throw new ProjectError(
      'planAlreadyApplied',
      'This preview was already used or replaced: make a new one.'
    )
  const fresh = validateDecisions(old, decisions)
  const merged = [
    ...old.decisions.filter((d) => !fresh.some((f) => f.destinationId === d.destinationId)),
    ...fresh
  ]
  const id = newProjectPlanId(old.kind)
  let next: { view: ProjectPlanView; bindings: PlanBindings }
  if (old.kind === 'restore') {
    if (!restoreRecompute) throw invalid('Restore previews are not available.')
    next = await restoreRecompute(ctx, id, old, merged)
  } else
    next = await computeSyncPlan(
      ctx,
      id,
      {
        discoveryId: old.bindings.discoveryId,
        root: old.bindings.root,
        projects: old.bindings.projects,
        selections: old.bindings.selections
      },
      merged
    )
  if (!consumeProjectPlan(ctx.home, planId, id))
    throw new ProjectError(
      'planAlreadyApplied',
      'This preview was already used or replaced: make a new one.'
    )
  const same =
    JSON.stringify(next.bindings) === JSON.stringify(old.bindings) &&
    JSON.stringify(next.view.excluded) === JSON.stringify(old.view.excluded)
  if (!same)
    throw new ProjectError('stale', 'Something changed since the preview: make a new preview.')
  storeProjectPlan(ctx.home, {
    version: 1,
    id,
    kind: old.kind,
    view: next.view,
    bindings: next.bindings,
    decisions: merged
  })
  return next.view
}
