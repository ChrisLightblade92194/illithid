/**
 * Ownership across scopes (spec 2026-10-06 project delivery §Physical collisions and existing content): one physical
 * file or folder is owned by the global flow or by a project delivery, never both. A global record covers its whole
 * file when it is a managed section, so a project whole-file delivery of that file overlaps it, and the reverse.
 * Overlap is found by path containment (exact spelling) and by observed identity of the existing entries and their
 * folders, never by lowercasing names. Confirmed global tool roots count as global: a project destination inside one
 * (or containing one) is refused. Reads state and lightweight metadata synchronously (the global apply is synchronous).
 */
import { lstatSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { destinationFile } from '../globalDestinations'
import { effectiveGlobalPaths } from '../globalPaths'
import { readDeliveries } from '../globalVariants'
import { readProjectDeliveries } from './state'
import type { ProjectDeliveryRecord, ScopeOverlap } from './types'

/** child is parent or below it, by exact path spelling */
function pathInside(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** File id of an existing entry, from its own metadata (never through a link) */
function identity(p: string): string | null {
  try {
    const st = lstatSync(p, { bigint: true, throwIfNoEntry: false })
    return st ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/** child is parent, or one of child's existing folders is parent, by identity */
function identityInside(child: string, parent: string): boolean {
  const id = identity(parent)
  if (!id) return false
  for (let q = resolve(child); ; q = dirname(q)) {
    if (identity(q) === id) return true
    if (dirname(q) === q) return false
  }
}

export function overlaps(a: string, b: string): boolean {
  return pathInside(a, b) || pathInside(b, a) || identityInside(a, b) || identityInside(b, a)
}

/**
 * The first record of the other scope that the destination (a project path, or a global path or `file::section`)
 * would overlap; null when none does.
 */
export function findScopeOverlap(
  home: string,
  destination: string,
  scope: 'global' | 'project'
): ScopeOverlap | null {
  const target = destinationFile(destination)
  if (scope === 'project') {
    for (const r of readDeliveries(home))
      if (overlaps(destinationFile(r.destination), target))
        return {
          scope: 'global',
          destination: r.destination,
          recordId: `${r.operationId}:${r.destination}`,
          reason: 'globalDelivery'
        }
    for (const p of effectiveGlobalPaths(home))
      if (p.status === 'resolved' && overlaps(p.paths[0], target))
        return {
          scope: 'global',
          destination: p.paths[0],
          recordId: `root:${p.tool}`,
          reason: 'globalRoot'
        }
    return null
  }
  for (const r of readProjectDeliveries(home))
    if (overlaps(r.destination, target))
      return {
        scope: 'project',
        destination: r.destination,
        recordId: r.id,
        reason: 'projectDelivery'
      }
  return null
}

/** The project delivery record of a destination: same path, or the same existing entry by identity */
export function projectOwnerAt(
  records: readonly ProjectDeliveryRecord[],
  destination: string,
  physicalKey: string | null
): ProjectDeliveryRecord | null {
  const d = resolve(destination)
  return (
    records.find(
      (r) =>
        resolve(r.destination) === d ||
        (!!physicalKey && physicalKey.startsWith('id:') && r.target.physicalKey === physicalKey)
    ) ?? null
  )
}
