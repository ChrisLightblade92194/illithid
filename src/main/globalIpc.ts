/**
 * IPC handlers of the Windows global flow (spec 2026-10-04 §9, §11). Inputs are validated here; the renderer names
 * variants, tools, digests and stored plan ids — never paths to write or a list of writes. Every write goes through a
 * stored preview: globalApply/globalRestoreApply load the plan the backend stored when it was shown.
 */
import {
  importGlobalItems,
  importLocalChange,
  listGlobalImportables,
  type GlobalImportSelection
} from '../engine/globalImport'
import { applyGlobalSync, planGlobalSync, readStoredPlan } from '../engine/globalManualSync'
import { listGlobalOperations } from '../engine/globalOperations'
import {
  confirmGlobalPath,
  effectiveGlobalPaths,
  GLOBAL_TOOLS,
  globalPathsView,
  type GlobalTool
} from '../engine/globalPaths'
import {
  applyGlobalRestore,
  planGlobalRestore,
  type RestoreDecision
} from '../engine/globalRestore'
import { mergeGlobalVariants, readGlobalChoices } from '../engine/globalVariants'
import {
  acceptRecipient,
  globalLibraryView,
  inspectRecipient,
  leaveUnmanaged,
  recipientChoice,
  setRecipient,
  type RecipientRef
} from '../engine/globalView'
import type { GLOBAL_CHANNELS, GlobalResult } from '../shared/api'

type GlobalChannel = (typeof GLOBAL_CHANNELS)[number]

class BadInput extends Error {
  code = 'invalid'
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new BadInput(`${what} must be a non-empty string`)
  return v
}
const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what))
const tool = (v: unknown): GlobalTool => {
  if (!GLOBAL_TOOLS.includes(v as GlobalTool)) throw new BadInput('unknown tool')
  return v as GlobalTool
}
function ref(v: unknown): RecipientRef {
  const o = (v ?? {}) as Record<string, unknown>
  if (o.kind !== 'rule' && o.kind !== 'skill') throw new BadInput('kind must be rule or skill')
  return { kind: o.kind, name: str(o.name, 'name'), tool: tool(o.tool) }
}
function selections(v: unknown): GlobalImportSelection[] {
  if (!Array.isArray(v)) throw new BadInput('selection must be a list')
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>
    if (o.kind !== 'rule' && o.kind !== 'skill') throw new BadInput('kind must be rule or skill')
    return {
      tool: tool(o.tool),
      kind: o.kind,
      name: str(o.name, 'name'),
      sourcePath: str(o.sourcePath, 'sourcePath'),
      sourceDigest: str(o.sourceDigest, 'sourceDigest')
    }
  })
}
function decisions(v: unknown): RestoreDecision[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new BadInput('decisions must be a list')
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>
    return {
      destination: str(o.destination, 'destination'),
      expectedDestinationDigest: strOrNull(o.expectedDestinationDigest, 'digest')
    }
  })
}

function wrap<T>(fn: () => T): GlobalResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? 'error', message: err.message ?? String(e) }
  }
}

/** Outcome of a decision step: refusal codes become a GlobalResult error, success returns the refreshed view */
function step<R extends { ok: boolean; code?: string }>(
  home: string,
  r: R
): ReturnType<typeof globalLibraryView> {
  if (!r.ok) throw Object.assign(new Error(r.code ?? 'refused'), { code: r.code ?? 'refused' })
  return globalLibraryView(home)
}

export function globalHandlers(
  home: string
): Record<GlobalChannel, (...args: unknown[]) => Promise<unknown>> {
  const paths = (): ReturnType<typeof effectiveGlobalPaths> => effectiveGlobalPaths(home)
  return {
    globalPaths: async () => wrap(() => globalPathsView(home)),
    globalPathsConfirm: async (t, p) =>
      wrap(() => {
        const r = confirmGlobalPath(home, tool(t), strOrNull(p, 'path'))
        if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code })
        return globalPathsView(home)
      }),
    globalImportables: async () => wrap(() => listGlobalImportables(home, paths())),
    globalImport: async (sel) => wrap(() => importGlobalItems(home, selections(sel), paths())),
    globalVariants: async () => wrap(() => globalLibraryView(home)),
    globalChoiceSet: async (req) =>
      wrap(() => {
        const o = (req ?? {}) as Record<string, unknown>
        return step(
          home,
          setRecipient(home, { ...ref(req), variantId: strOrNull(o.variantId, 'variantId') })
        )
      }),
    globalChoiceAccept: async (req) =>
      wrap(() => {
        const o = (req ?? {}) as Record<string, unknown>
        return step(
          home,
          acceptRecipient(home, {
            ...ref(req),
            expectedDestinationDigest: strOrNull(o.expectedDestinationDigest, 'digest')
          })
        )
      }),
    globalLocalChange: async (req) =>
      wrap(() => {
        const r = ref(req)
        const o = (req ?? {}) as Record<string, unknown>
        const c = recipientChoice(home, r)
        if (!c) throw Object.assign(new Error('no choice for this recipient'), { code: 'notFound' })
        return step(
          home,
          importLocalChange(
            home,
            r.tool,
            c.destination,
            r.kind,
            str(o.expectedDestinationDigest, 'digest')
          )
        )
      }),
    globalLeaveUnmanaged: async (req) => wrap(() => step(home, leaveUnmanaged(home, ref(req)))),
    globalMerge: async (ids, rev) =>
      wrap(() => {
        if (!Array.isArray(ids)) throw new BadInput('ids must be a list')
        return step(
          home,
          mergeGlobalVariants(
            home,
            ids.map((x) => str(x, 'id')),
            str(rev, 'revision')
          )
        )
      }),
    globalInspect: async (req) => wrap(() => inspectRecipient(home, ref(req))),
    globalPlan: async () =>
      wrap(() => planGlobalSync(home, readGlobalChoices(home), { paths: paths() })),
    globalApply: async (id) =>
      wrap(() => {
        const plan = readStoredPlan(home, str(id, 'planId'))
        if (!plan || plan.kind !== 'sync')
          throw Object.assign(new Error('unknown preview'), { code: 'unknownPlan' })
        return applyGlobalSync(home, plan)
      }),
    globalOperations: async () => wrap(() => listGlobalOperations(home)),
    globalRestorePlan: async (opId, accept) =>
      wrap(() =>
        planGlobalRestore(home, str(opId, 'operationId'), {
          paths: paths(),
          accept: decisions(accept)
        })
      ),
    globalRestoreApply: async (id) =>
      wrap(() => {
        const plan = readStoredPlan(home, str(id, 'planId'))
        if (!plan || plan.kind !== 'restore')
          throw Object.assign(new Error('unknown preview'), { code: 'unknownPlan' })
        return applyGlobalRestore(home, plan)
      })
  }
}
