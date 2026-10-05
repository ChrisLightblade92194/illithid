/**
 * What the Windows library screens show and the choices they make (spec 2026-10-04 §7, §11).
 * - Recipient states: unmanaged, toApply, synced (files match the delivered revision — not proof that a tool loaded
 *   them), conflict, unsupported, error. They come from the same plan computation the preview uses.
 * - The backend computes destinations (default native form under the confirmed root) and binds a decision to the
 *   destination digest the user saw; the renderer only names a variant, a tool and a digest.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalConflict } from './globalConflicts'
import {
  defaultDestination,
  destinationKey,
  findSection,
  parseDestination,
  readDestination
} from './globalDestinations'
import type { GlobalKind } from './globalImport'
import { computeGlobalPlan, validDestination } from './globalManualSync'
import {
  effectiveGlobalPaths,
  GLOBAL_TOOLS,
  globalPathsView,
  type GlobalPathResult,
  type GlobalPathView,
  type GlobalTool
} from './globalPaths'
import {
  forgetDelivery,
  listGlobalVariants,
  readDeliveries,
  readGlobalChoices,
  writeGlobalChoices,
  type DeliveryChoice,
  type DeliveryRecord,
  type VariantRecord
} from './globalVariants'
import type { Env } from './types'

export type RecipientStatus =
  'unmanaged' | 'toApply' | 'synced' | 'conflict' | 'unsupported' | 'error'

export interface RecipientView {
  tool: GlobalTool
  variantId: string | null
  destination: string | null
  status: RecipientStatus
  /** Plan operation (toApply/synced), exclusion reason (unsupported/error) */
  op?: string
  reason?: string
  conflict?: GlobalConflict
}

export interface VariantGroupView {
  kind: GlobalKind
  name: string
  variantIds: string[]
  recipients: RecipientView[]
}

export interface GlobalLibraryView {
  paths: GlobalPathView[]
  effective: GlobalPathResult[]
  variants: VariantRecord[]
  groups: VariantGroupView[]
  deliveries: DeliveryRecord[]
}

export interface RecipientRef {
  kind: GlobalKind
  name: string
  tool: GlobalTool
}

/** Exclusion reasons that mean "this tool cannot receive it in its native form" */
const UNSUPPORTED = new Set([
  'includeNotSupported',
  'externalReference',
  'skillNameMismatch',
  'skillNameMissing',
  'shadowedByOverride'
])

function choiceIndex(
  choices: DeliveryChoice[],
  variants: VariantRecord[],
  ref: RecipientRef
): number {
  return choices.findIndex((c) => {
    if (c.tool !== ref.tool) return false
    const v = variants.find((x) => x.id === c.variantId)
    return !!v && v.kind === ref.kind && v.name === ref.name
  })
}

export function globalLibraryView(home: string, env: Env = process.env): GlobalLibraryView {
  const variants = listGlobalVariants(home)
  const effective = effectiveGlobalPaths(home, env)
  const choices = readGlobalChoices(home)
  const plan = computeGlobalPlan(home, choices, { paths: effective, variants })
  const groups = new Map<string, VariantGroupView>()
  for (const v of variants) {
    const k = `${v.kind}\0${v.name}`
    const g = groups.get(k) ?? { kind: v.kind, name: v.name, variantIds: [], recipients: [] }
    g.variantIds.push(v.id)
    groups.set(k, g)
  }
  for (const g of groups.values())
    g.recipients = GLOBAL_TOOLS.map((tool): RecipientView => {
      const i = choiceIndex(choices, variants, { kind: g.kind, name: g.name, tool })
      if (i === -1) return { tool, variantId: null, destination: null, status: 'unmanaged' }
      const c = choices[i]
      const base = { tool, variantId: c.variantId, destination: c.destination }
      const key = destinationKey(c.destination)
      const change = plan.changes.find(
        (x) => x.variantId === c.variantId && destinationKey(x.destination) === key
      )
      if (change)
        return { ...base, status: change.op === 'unchanged' ? 'synced' : 'toApply', op: change.op }
      const conflict = plan.conflicts.find((x) => destinationKey(x.destination) === key)
      if (conflict) return { ...base, status: 'conflict', conflict, reason: conflict.reason }
      const ex = plan.excluded.find(
        (x) => x.choice.variantId === c.variantId && destinationKey(x.choice.destination) === key
      )
      return {
        ...base,
        status: ex && UNSUPPORTED.has(ex.reason) ? 'unsupported' : 'error',
        reason: ex?.reason ?? 'unknown'
      }
    })
  return {
    paths: globalPathsView(home, env),
    effective,
    variants,
    groups: [...groups.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    ),
    deliveries: readDeliveries(home)
  }
}

/** Chooses the variant a tool receives for a name (null = none); the destination is computed here */
export function setRecipient(
  home: string,
  req: RecipientRef & { variantId: string | null },
  env: Env = process.env
): { ok: true } | { ok: false; code: 'unknownVariant' | 'toolUnavailable' } {
  const variants = listGlobalVariants(home)
  const v = req.variantId ? variants.find((x) => x.id === req.variantId) : null
  if (req.variantId && (!v || v.kind !== req.kind || v.name !== req.name))
    return { ok: false, code: 'unknownVariant' }
  const root = effectiveGlobalPaths(home, env).find(
    (p) => p.tool === req.tool && p.status === 'resolved'
  )?.paths[0]
  if (v && !root) return { ok: false, code: 'toolUnavailable' }
  const choices = readGlobalChoices(home)
  const i = choiceIndex(choices, variants, req)
  if (i !== -1) choices.splice(i, 1)
  if (v && root)
    choices.push({
      variantId: v.id,
      variantRevision: v.revision,
      tool: req.tool,
      // A variant that came from this tool targets its original (managed in place), never a second copy
      destination:
        v.origins.find(
          (o) => o.tool === req.tool && validDestination(req.tool, req.kind, o.path, root)
        )?.path ?? defaultDestination(root, req.tool, req.kind, v.name),
      expectedDestinationDigest: null
    })
  writeGlobalChoices(home, choices)
  return { ok: true }
}

/** Decision on the content now at the destination (replace after backup, or adopt when identical) */
export function acceptRecipient(
  home: string,
  req: RecipientRef & { expectedDestinationDigest: string | null }
): { ok: true } | { ok: false; code: 'notFound' | 'changedSinceCheck' } {
  const variants = listGlobalVariants(home)
  const choices = readGlobalChoices(home)
  const i = choiceIndex(choices, variants, req)
  if (i === -1) return { ok: false, code: 'notFound' }
  const current = readDestination(choices[i].destination, req.kind).digest
  if (current !== req.expectedDestinationDigest) return { ok: false, code: 'changedSinceCheck' }
  // The variant revision is refreshed with the decision: the user decides on what is shown now
  const v = variants.find((x) => x.id === choices[i].variantId)!
  choices[i] = { ...choices[i], variantRevision: v.revision, expectedDestinationDigest: current }
  writeGlobalChoices(home, choices)
  return { ok: true }
}

/** Stops managing a tool's destination for a name: the choice and the delivery record go, the files stay */
export function leaveUnmanaged(
  home: string,
  req: RecipientRef
): { ok: true } | { ok: false; code: 'notFound' } {
  const variants = listGlobalVariants(home)
  const choices = readGlobalChoices(home)
  const i = choiceIndex(choices, variants, req)
  if (i === -1) return { ok: false, code: 'notFound' }
  const [c] = choices.splice(i, 1)
  writeGlobalChoices(home, choices)
  forgetDelivery(home, c.destination)
  return { ok: true }
}

export interface InspectSide {
  digest: string | null
  shape: string
  /** Rule text, or SKILL.md of a skill */
  text: string | null
  /** Skill folders: relative files */
  files?: string[]
}

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(root, r))
    else out.push(r)
  }
  return out
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Both sides of a recipient decision: what is at the destination now and the chosen variant */
export function inspectRecipient(
  home: string,
  req: RecipientRef
): { destination: InspectSide; variant: InspectSide } {
  const variants = listGlobalVariants(home)
  const choices = readGlobalChoices(home)
  const i = choiceIndex(choices, variants, req)
  if (i === -1) throw Object.assign(new Error('no choice for this recipient'), { code: 'notFound' })
  const c = choices[i]
  const v = variants.find((x) => x.id === c.variantId)!
  const state = readDestination(c.destination, req.kind)
  const d = parseDestination(c.destination)
  let destination: InspectSide = { digest: state.digest, shape: state.shape, text: null }
  if (state.shape === 'section' && d.kind === 'section') {
    const buf = readFileSync(d.file)
    const s = findSection(buf, d.section)
    if (s !== 'absent' && s !== 'malformed')
      destination.text = buf.subarray(s.bodyStart, s.bodyEnd).toString('utf8')
  } else if (state.shape === 'file' && d.kind === 'path') destination.text = readText(d.path)
  else if (state.shape === 'dir' && d.kind === 'path')
    destination = {
      ...destination,
      text: readText(join(d.path, 'SKILL.md')),
      files: listFiles(d.path)
    }
  const variant: InspectSide =
    v.kind === 'skill'
      ? {
          digest: v.revision,
          shape: 'dir',
          text: readText(join(v.contentPath, 'SKILL.md')),
          files: listFiles(v.contentPath)
        }
      : { digest: v.revision, shape: 'file', text: readText(v.contentPath) }
  return { destination, variant }
}

/** The saved choice of a recipient, if any */
export function recipientChoice(home: string, req: RecipientRef): DeliveryChoice | null {
  const choices = readGlobalChoices(home)
  const i = choiceIndex(choices, listGlobalVariants(home), req)
  return i === -1 ? null : choices[i]
}
