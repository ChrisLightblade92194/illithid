/**
 * Project import and delivery contracts (spec 2026-10-06 project delivery). Node-free, so the renderer can import the
 * view types. Trusted backend structures (candidate bindings, observations, stored plans) never enter an IPC result.
 */
import type { CandidateBinding, CensusEntry, CensusItem, PathIdentity } from '../census/types'
import type { GlobalKind } from '../globalImport'
import type { GlobalTool } from '../globalPaths'

/** Digest formats that cross subsystems: never compared with one another as strings */
export type CensusDigestAlgorithm = 'sha256-v1' | 'census-skill-v1'
export type RevisionAlgorithm = 'sha256-v1' | 'fullTree-v1'

/**
 * Provenance of a variant imported from a project: where it was, which tools' conventions name that path (potential
 * consumers, not a proven owner) and the complete source digest in its census format. Never carries a `tool`.
 */
export interface ProjectOrigin {
  scope: 'project'
  projectRoot: string
  /** Slash-separated, relative to the project (keeps the original role: override, local file, conditional rule) */
  relativePath: string
  /** Absolute source path */
  path: string
  consumers: GlobalTool[]
  importedAt: string
  digest: string
  digestAlgorithm: CensusDigestAlgorithm
  tool?: never
  linkTarget?: never
}

/** A complete observation of one rule file or skill folder, read without following any link */
export interface ProjectContentObservation {
  /** The observed path (for a copy: the verified copied path) */
  sourcePath: string
  project: CandidateBinding
  relativePath: string
  kind: GlobalKind
  /**
   * Folders inside the project down to the item (identity), then the item and, for a skill, every entry of its tree
   * (identity, size and modification time): a recheck refuses any difference
   */
  identities: PathIdentity[]
  /** Skills: every entry, hidden ones and .DS_Store included */
  manifest?: CensusEntry[]
  bytes: number
  censusDigest: string
  censusAlgorithm: CensusDigestAlgorithm
  /** Library-compatible revision of the same bytes (rule sha256, skill full tree) */
  revision: string
  revisionAlgorithm: RevisionAlgorithm
}

export type ProjectErrorCode =
  | 'invalid'
  | 'stale'
  | 'projectChanged'
  | 'changedSinceCensus'
  | 'changedSinceCheck'
  | 'incomplete'
  | 'unsupportedPlatform'
  | 'unknownPlan'
  | 'planAlreadyApplied'
  | 'applyInProgress'
  | 'notFound'
  | 'refused'

export class ProjectError extends Error {
  constructor(
    public code: ProjectErrorCode,
    message: string,
    /** Census-style reason (linkInside, fileBytes, ambiguousCase…) when the code alone does not say why */
    public reason?: string,
    public problemPath?: string
  ) {
    super(message)
  }
}

/** Backend context of the asynchronous project functions */
export interface ProjectContext {
  home: string
  signal: AbortSignal
}

/** A complete census item with the binding of its project (main-process input, never a renderer capability) */
export interface BoundCensusItem {
  item: CensusItem
  project: CandidateBinding
}

/**
 * The selected items of the current completed census run. `signal` aborts when the run is cancelled or superseded;
 * `assertCurrent` throws stale once it is no longer the current completed run. Not an authentication claim.
 */
export interface CensusImportLease {
  items: readonly BoundCensusItem[]
  signal: AbortSignal
  assertCurrent(): void
}

export interface CensusImportAccess {
  acquireImport(runId: string, itemIds: readonly string[]): CensusImportLease
}

export interface ProjectImportItemResult {
  itemId: string
  kind: GlobalKind
  /** Project folder and project-relative path of the occurrence */
  projectPath: string
  relativePath: string
  status: 'imported' | 'refused' | 'failed' | 'notAttempted'
  code?: string
  reason?: string
  variantId?: string
}

export interface ProjectImportResult {
  status: 'completed' | 'partial' | 'refused' | 'failed' | 'cancelled'
  items: ProjectImportItemResult[]
  /** Variants registered by this import (kept after a cancellation) */
  variantIds: string[]
}

/** Backend/test-only observation points of an import (never exposed over IPC) */
export interface ProjectImportHooks {
  onProgress?: (done: number, total: number) => void
  afterRegister?: (index: number) => void | Promise<void>
}

/** A backend job (import now; apply later) as the renderer polls it */
export interface ProjectJobView {
  id: string
  kind: 'import' | 'apply'
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  progress: { done: number; total: number }
  /** Cancel was asked: the job stops after its current step and still reports what it completed */
  cancelRequested?: boolean
  result?: ProjectImportResult
  reason?: string
}
