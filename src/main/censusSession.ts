/**
 * Session of the Windows project census (spec 2026-10-06): the current discovery and run, in memory, and the import
 * lease other main-process coordinators acquire on the completed run. A new discovery or start supersedes the run (its
 * signal aborts, its ids become stale); a lease never outlives that. Bindings stay in the main process.
 */
import type { CensusRunView, DiscoveryHandle } from '../engine/census/types'
import {
  ProjectError,
  type BoundCensusItem,
  type CensusImportAccess,
  type CensusImportLease
} from '../engine/project/types'

export interface CensusRun {
  id: string
  discovery: DiscoveryHandle
  controller: AbortController
  view: CensusRunView
}

const staleImport = (): ProjectError =>
  new ProjectError('stale', 'This census was replaced or cancelled: run it again to import.')
const invalid = (message: string): ProjectError => new ProjectError('invalid', message)

export class CensusSession implements CensusImportAccess {
  discovery: DiscoveryHandle | null = null
  run: CensusRun | null = null
  /** Bumped by every discovery and start: a pending older one finds itself superseded */
  generation = 0

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** Signals the current run (its scan, details and imports stop) and forgets it */
  supersede(): void {
    this.run?.controller.abort()
    this.run = null
  }

  /**
   * The selected complete items of the current completed run with their project bindings. Ids are checked (non-empty,
   * unique strings of complete items of this run) before anything else; no filesystem access happens here.
   */
  acquireImport(runId: string, itemIds: readonly string[]): CensusImportLease {
    if (this.platform !== 'win32')
      throw new ProjectError('unsupportedPlatform', 'Project import is available on Windows only.')
    if (typeof runId !== 'string' || !runId) throw invalid('runId must be a non-empty string.')
    if (!Array.isArray(itemIds) || itemIds.length === 0)
      throw invalid('Select at least one item to import.')
    if (itemIds.some((id) => typeof id !== 'string' || !id))
      throw invalid('Item ids must be non-empty strings.')
    if (new Set(itemIds).size !== itemIds.length) throw invalid('An item is selected twice.')
    const r = this.run
    const snapshot = r?.view.status === 'completed' ? r.view.snapshot : undefined
    if (!r || r.id !== runId || !snapshot || r.controller.signal.aborted) throw staleImport()
    const byId = new Map(snapshot.items.map((i) => [i.id, i]))
    const items: BoundCensusItem[] = itemIds.map((id) => {
      const item = byId.get(id)
      const project = item && r.discovery.bindings.get(item.projectId)
      if (!item || item.outcome !== 'complete' || !project)
        throw invalid('Not a complete item of this census.')
      return { item, project }
    })
    return {
      items,
      signal: r.controller.signal,
      assertCurrent: () => {
        if (this.run !== r || r.view.status !== 'completed' || r.controller.signal.aborted)
          throw staleImport()
      }
    }
  }
}
