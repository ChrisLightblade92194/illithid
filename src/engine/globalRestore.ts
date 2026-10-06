/**
 * Restore of a global sync operation from its backups (spec 2026-10-04 §10).
 * - The restore has its own preview (a plan of kind 'restore', stored like a sync plan).
 * - A destination still holding what the operation wrote is put back as it was; one already as it was is unchanged.
 * - A destination changed after the operation is a conflict: nothing is overwritten unless the user decides on the
 *   content shown (accept with its digest); the current version is backed up first, like any replacement.
 * - A missing or corrupt backup is reported and never counted as restored. Backups are never deleted.
 * - Nothing is restored automatically, including after an interruption.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GlobalConflict } from './globalConflicts'
import { bytesDigest, destinationFile, destinationKey, readDestination } from './globalDestinations'
import { resolveGlobalPaths, type GlobalPathResult, type GlobalTool } from './globalPaths'
import {
  executePlan,
  libraryRevision,
  linkedAncestor,
  newPlanId,
  ownerOf,
  storePlan,
  treeFiles,
  compareTrees,
  within,
  type GlobalChange,
  type GlobalExcluded,
  type GlobalSyncPlan,
  type GlobalSyncResult
} from './globalManualSync'
import { listGlobalOperations, readBackupMeta, type BackupMeta } from './globalOperations'
import {
  deliveryAt,
  listGlobalVariants,
  readDeliveries,
  type DeliveryChoice
} from './globalVariants'
import { dirContentHash } from './skills'
import { globalTreeDigest } from './globalDigest'
import { findScopeOverlap } from './project/ownership'

export interface RestoreDecision {
  destination: string
  /** The current digest the user saw and accepts to replace */
  expectedDestinationDigest: string | null
}

/** Digest of a backup's content, or null when it is missing or does not match its record */
function backupIntact(dir: string, meta: BackupMeta): boolean {
  const content = join(dir, 'content')
  try {
    if (meta.shape === 'absent') return true
    if (!existsSync(content)) return false
    if (meta.digestAlgorithm !== undefined && meta.digestAlgorithm !== 'fullTree-v1') return false
    const d =
      meta.shape === 'dir'
        ? meta.digestAlgorithm === 'fullTree-v1'
          ? globalTreeDigest(content)
          : dirContentHash(content)
        : bytesDigest(readFileSync(content))
    return d === meta.digest
  } catch {
    return false
  }
}

export function planGlobalRestore(
  home: string,
  operationId: string,
  opts: { paths?: GlobalPathResult[]; accept?: RestoreDecision[] } = {}
): GlobalSyncPlan {
  const op = listGlobalOperations(home).find((o) => o.id === operationId)
  if (!op) throw Object.assign(new Error('unknown operation'), { code: 'unknownOperation' })
  const paths = opts.paths ?? resolveGlobalPaths(home)
  const roots: Partial<Record<GlobalTool, string>> = {}
  for (const p of paths) if (p.status === 'resolved') roots[p.tool] = p.paths[0]
  const changes: GlobalChange[] = []
  const conflicts: GlobalConflict[] = []
  const excluded: GlobalExcluded[] = []
  // Undo in reverse order of application
  for (const r of [...op.results].reverse()) {
    if (!r.backup) continue
    const choice: DeliveryChoice = {
      variantId: r.variantId,
      variantRevision: '',
      tool: r.tool,
      destination: r.destination,
      expectedDestinationDigest: null
    }
    const meta = readBackupMeta(r.backup)
    if (!meta) {
      excluded.push({ choice, reason: 'backupMissing' })
      continue
    }
    if (!backupIntact(r.backup, meta)) {
      excluded.push({ choice, reason: 'backupCorrupt' })
      continue
    }
    const root = roots[r.tool]
    if (!root || !within(root, resolve(destinationFile(r.destination)))) {
      excluded.push({ choice, reason: 'toolUnavailable' })
      continue
    }
    if (linkedAncestor(root, r.destination)) {
      excluded.push({ choice, reason: 'linkedAncestor' })
      continue
    }
    if (findScopeOverlap(home, r.destination, 'global')) {
      excluded.push({ choice, reason: 'projectOwnership' })
      continue
    }
    // Legacy backups retain their original verification; new restore plans bind every byte they will copy.
    const restoreDigest =
      meta.shape === 'dir' && meta.digestAlgorithm === undefined
        ? globalTreeDigest(join(r.backup, 'content'))
        : meta.digest
    const state = readDestination(r.destination, r.kind)
    const base = {
      choice,
      variantId: r.variantId,
      variantRevision: '',
      variantName: listGlobalVariants(home).find((v) => v.id === r.variantId)?.name ?? r.variantId,
      kind: r.kind,
      tool: r.tool,
      destination: r.destination,
      sourceDigest: restoreDigest ?? '',
      destinationDigest: state.digest,
      afterDigest: restoreDigest,
      restoreFrom: r.backup,
      owner: ownerOf(deliveryAt(readDeliveries(home), r.destination)),
      notes: [] as string[]
    }
    if (state.digest === restoreDigest) {
      changes.push({ ...base, op: 'unchanged', preview: { before: null, after: null } })
      continue
    }
    const accepted = opts.accept?.find(
      (a) => destinationKey(a.destination) === destinationKey(r.destination)
    )
    const wroteIt = state.digest === r.afterDigest
    if (!wroteIt && !(accepted && accepted.expectedDestinationDigest === state.digest)) {
      conflicts.push({
        type: 'destinationChanged',
        variantIds: [r.variantId],
        tool: r.tool,
        destination: r.destination,
        digests: { expected: r.afterDigest, current: state.digest },
        reason: 'changedSinceOperation'
      })
      continue
    }
    const op: GlobalChange['op'] =
      meta.shape === 'absent' ? 'remove' : state.digest === null ? 'create' : 'replace'
    const preview: GlobalChange['preview'] =
      meta.shape === 'dir' || (meta.shape === 'absent' && r.kind === 'skill')
        ? {
            before: null,
            after: null,
            files: compareTrees(
              state.shape === 'dir' ? treeFiles(r.destination) : null,
              meta.shape === 'dir' ? treeFiles(join(r.backup, 'content')) : null
            )
          }
        : {
            before: null,
            after: meta.shape === 'absent' ? null : readFileSync(join(r.backup, 'content'), 'utf8')
          }
    changes.push({ ...base, op, preview })
  }
  const plan: GlobalSyncPlan = {
    id: newPlanId('restore'),
    kind: 'restore',
    restoreOf: operationId,
    createdAt: new Date().toISOString(),
    libraryRevision: libraryRevision(listGlobalVariants(home)),
    roots,
    changes,
    conflicts,
    excluded
  }
  storePlan(home, plan)
  return plan
}

/** Applies an approved restore plan with the same checks, lock and backups as a sync */
export function applyGlobalRestore(home: string, approvedPlan: GlobalSyncPlan): GlobalSyncResult {
  if (approvedPlan.kind !== 'restore')
    return {
      operationId: '',
      status: 'refused',
      results: [],
      backups: [],
      error: { code: 'planMismatch', message: 'not a restore plan' }
    }
  return executePlan(
    home,
    approvedPlan,
    (c) => {
      const meta = c.restoreFrom ? readBackupMeta(c.restoreFrom) : null
      if (!meta || !c.restoreFrom) throw new Error('backup missing')
      if (meta.shape === 'absent') return null
      const content = join(c.restoreFrom, 'content')
      return meta.shape === 'dir' ? content : readFileSync(content)
    },
    { variantCheck: false }
  )
}
