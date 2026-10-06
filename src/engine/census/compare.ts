/**
 * Project census comparisons (spec 2026-10-06 §Comparison model). Pure, no filesystem access.
 * Equal content: same kind and complete content — a rule's exact bytes (their digest), a skill's complete manifest
 * compared entry by entry (its digest is only a label). Same name: same kind and case-insensitive name with at least
 * two different complete contents. Incomplete items never join a group, whatever digest they carry.
 */
import type { CensusEntry, CensusGroup, CensusGrouping, CensusItem } from './types'

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Unambiguous serialization of a manifest: JSON of its entries in ordinal path order */
export function manifestKey(entries: readonly CensusEntry[]): string {
  return JSON.stringify(
    [...entries]
      .sort((a, b) => ordinal(a.path, b.path))
      .map((e) => (e.kind === 'file' ? [e.path, 'file', e.bytes, e.digest] : [e.path, 'dir']))
  )
}

const comparable = (i: CensusItem): boolean =>
  i.outcome === 'complete' &&
  typeof i.digest === 'string' &&
  (i.kind === 'rule' || Array.isArray(i.manifest))

const contentKey = (i: CensusItem): string =>
  i.kind === 'rule' ? `rule\0${i.digest}` : `skill\0${manifestKey(i.manifest!)}`

function collect(items: CensusItem[], key: (i: CensusItem) => string): CensusItem[][] {
  const m = new Map<string, CensusItem[]>()
  for (const i of items) {
    const k = key(i)
    const list = m.get(k)
    if (list) list.push(i)
    else m.set(k, [i])
  }
  return [...m.values()]
}

const group = (prefix: string, list: CensusItem[], n: number): CensusGroup => ({
  id: `${prefix}-${n}`,
  kind: list[0].kind,
  itemIds: list.map((i) => i.id)
})

export function groupItems(items: readonly CensusItem[]): CensusGrouping {
  const complete = items.filter(comparable)
  const byContent = collect(complete, contentKey)
  const byName = collect(complete, (i) => `${i.kind}\0${i.name.toLowerCase()}`)
  return {
    equalGroups: byContent.filter((l) => l.length > 1).map((l, n) => group('equal', l, n)),
    sameNameDifferences: byName
      .filter((l) => new Set(l.map(contentKey)).size > 1)
      .map((l, n) => group('name', l, n)),
    uniqueItemIds: byContent.filter((l) => l.length === 1).flatMap((l) => l.map((i) => i.id))
  }
}

/** Paths only in right (added), only in left (removed), in both with another kind, length or digest (changed) */
export function diffManifests(
  left: readonly CensusEntry[],
  right: readonly CensusEntry[]
): { added: string[]; removed: string[]; changed: string[] } {
  const l = new Map(left.map((e) => [e.path, e]))
  const r = new Map(right.map((e) => [e.path, e]))
  const same = (a: CensusEntry, b: CensusEntry): boolean =>
    a.kind === b.kind && a.bytes === b.bytes && a.digest === b.digest
  return {
    added: [...r.keys()].filter((p) => !l.has(p)).sort(ordinal),
    removed: [...l.keys()].filter((p) => !r.has(p)).sort(ordinal),
    changed: [...l.keys()].filter((p) => r.has(p) && !same(l.get(p)!, r.get(p)!)).sort(ordinal)
  }
}
