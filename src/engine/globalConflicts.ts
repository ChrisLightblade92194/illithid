/**
 * Conflicts between delivery choices and what is on disk (spec 2026-10-04 §7).
 * - variantsDiffer: two different variants chosen for the same destination.
 * - nameCollision: destinations (or an existing entry) differing only in case — the same entry for Windows.
 * - unmanagedDestination: an entry the app never delivered occupies the destination and no decision covers its current
 *   content; links, malformed managed sections and unreadable entries always stay unmanaged (reason says which).
 * - destinationChanged: the content differs from the last delivery, or from what the user saw when deciding.
 * A conflict blocks only the destinations it names. Read-only.
 */
import { destinationKey, readDestination, type DestinationState } from './globalDestinations'
import type { GlobalTool } from './globalPaths'
import {
  deliveryAt,
  listGlobalVariants,
  readDeliveries,
  type DeliveryChoice,
  type VariantRecord
} from './globalVariants'

export interface GlobalConflict {
  type: 'variantsDiffer' | 'destinationChanged' | 'unmanagedDestination' | 'nameCollision'
  variantIds: string[]
  tool: GlobalTool
  destination: string
  /** Digests compared: what the user saw (expected), what is there now (current), what the app delivered last */
  digests: { expected?: string | null; current: string | null; delivered?: string }
  reason?: string
}

/** Conflict of a single choice with the destination state (null = none) */
export function destinationConflict(
  c: DeliveryChoice,
  state: DestinationState,
  delivered: string | undefined
): GlobalConflict | null {
  const base = { variantIds: [c.variantId], tool: c.tool, destination: c.destination }
  if (state.shape === 'caseMismatch')
    return {
      ...base,
      type: 'nameCollision',
      digests: { current: state.digest },
      reason: `existingName:${state.actualName}`
    }
  const blocked: Partial<Record<DestinationState['shape'], string>> = {
    link: 'link',
    malformedSection: 'malformedSection',
    unreadable: 'unreadable',
    other: 'otherEntry'
  }
  const reason = blocked[state.shape]
  if (reason)
    return { ...base, type: 'unmanagedDestination', digests: { current: state.digest }, reason }
  if (c.expectedDestinationDigest !== null) {
    return c.expectedDestinationDigest === state.digest
      ? null
      : {
          ...base,
          type: 'destinationChanged',
          digests: { expected: c.expectedDestinationDigest, current: state.digest },
          reason: 'changedSinceShown'
        }
  }
  if (delivered !== undefined)
    return delivered === state.digest
      ? null
      : {
          ...base,
          type: 'destinationChanged',
          digests: { current: state.digest, delivered },
          reason: 'changedSinceDelivery'
        }
  return state.digest === null
    ? null
    : { ...base, type: 'unmanagedDestination', digests: { current: state.digest } }
}

export function detectGlobalConflicts(
  home: string,
  choices: DeliveryChoice[],
  variants: VariantRecord[] = listGlobalVariants(home)
): GlobalConflict[] {
  const out: GlobalConflict[] = []
  const seen = new Set<string>()
  const push = (c: GlobalConflict): void => {
    const k = `${c.type}\0${c.destination}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(c)
  }
  const known = choices.filter((c) => variants.some((v) => v.id === c.variantId))
  const groups = new Map<string, DeliveryChoice[]>()
  for (const c of known) {
    const k = destinationKey(c.destination)
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  for (const group of groups.values()) {
    const ids = [...new Set(group.map((c) => c.variantId))].sort()
    const dests = [...new Set(group.map((c) => c.destination))]
    if (dests.length > 1)
      for (const c of group)
        push({
          type: 'nameCollision',
          variantIds: ids,
          tool: c.tool,
          destination: c.destination,
          digests: { current: null },
          reason: 'caseOnly'
        })
    else if (ids.length > 1)
      push({
        type: 'variantsDiffer',
        variantIds: ids,
        tool: group[0].tool,
        destination: group[0].destination,
        digests: { current: null }
      })
  }
  const deliveries = readDeliveries(home)
  for (const c of known) {
    const v = variants.find((x) => x.id === c.variantId)!
    const conflict = destinationConflict(
      c,
      readDestination(c.destination, v.kind),
      deliveryAt(deliveries, c.destination)?.deliveredDigest
    )
    if (conflict) push(conflict)
  }
  return out
}
