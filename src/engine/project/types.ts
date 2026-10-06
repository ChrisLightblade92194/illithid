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

interface ProjectJobBase {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  progress: { done: number; total: number }
  /** Cancel was asked: the job stops after its current step and still reports what it completed */
  cancelRequested?: boolean
  reason?: string
}

/** A backend job as the renderer polls it: an import of census items, or the apply of a stored plan */
export type ProjectJobView =
  | (ProjectJobBase & { kind: 'import'; result?: ProjectImportResult })
  | (ProjectJobBase & { kind: 'apply'; result?: ProjectOperationView })

/** Where a selected variant goes in a project: the tool's native default, or a supported alternative rule slot */
export type ProjectSlot =
  | { type: 'default' }
  | { type: 'claudeNested' }
  | { type: 'claudeLocal' }
  | { type: 'claudeNamedRule'; name: string }
  | { type: 'codexOverride' }
  | { type: 'opencodeClaude' }

/** A supported local instruction or skill slot of the project, from metadata only (its text is never read) */
export interface LocalSlot {
  /** Slash-separated, relative to the project */
  path: string
  present: boolean
  linked: boolean
  /** Documented local precedence or convention overlap (a label, not the effective context of a session) */
  note?: string
}

/** A destination inside a project as observed now, without following links */
export interface ProjectDestinationObservation {
  destination: string
  project: CandidateBinding
  kind: GlobalKind
  shape: 'absent' | 'file' | 'dir'
  /** Complete content digest (null when absent) */
  digest: string | null
  digestAlgorithm: RevisionAlgorithm
  /** Folders inside the project down to the destination (identity), then the destination (and its tree) */
  identities: PathIdentity[]
  /** Skills: every entry of the existing folder */
  manifest?: CensusEntry[]
  /** Existing entry: its identity; absent: the nearest existing folder's identity plus the exact missing names */
  physicalKey: string
  /** Nearest existing folder at or above the destination's parent */
  existingAncestor: PathIdentity
  /** Absent destinations: the names missing below existingAncestor, the destination's own name last */
  remaining: string[]
  localSlots: LocalSlot[]
}

/** An ownership record of the other scope that a destination would overlap */
export interface ScopeOverlap {
  scope: 'global' | 'project'
  destination: string
  recordId: string
  reason: string
}

/** What Illithid delivered to a project destination (state file, never inside the project) */
export interface ProjectDeliveryRecord {
  version: 1
  id: string
  scope: 'project'
  /** The project folder and its identity chain when delivered */
  project: CandidateBinding
  /** Identity of the delivered entry right after the delivery */
  target: { physicalKey: string }
  destination: string
  kind: GlobalKind
  /** Tools whose convention the destination was chosen for (not proof of loading) */
  recipients: GlobalTool[]
  variantId: string
  variantRevision: string
  deliveredDigest: string
  digestAlgorithm: RevisionAlgorithm
  operationId: string
  at: string
}

/** One requested delivery: a library variant to a project for a tool's slot (ids issued by the backend) */
export interface ProjectSelection {
  candidateId: string
  variantId: string
  tool: GlobalTool
  slot: ProjectSlot
}

export interface ProjectFileChange {
  path: string
  change: 'added' | 'removed' | 'changed' | 'same'
}

export interface ProjectPreview {
  before: string | null
  after: string | null
  /** Skills: every entry compared (files and folders, hidden ones included) */
  files?: ProjectFileChange[]
  truncated?: boolean
}

/** One physical destination of a preview, with every incoming variant and the human decision */
export interface ProjectPlanChange {
  destinationId: string
  destination: string
  /** Slash-separated, relative to the project */
  relativePath: string
  project: { id: string; path: string; name: string }
  kind: GlobalKind
  recipients: GlobalTool[]
  incoming: { variantId: string; variantRevision: string; kind: GlobalKind; name: string }[]
  selectedVariantId: string | null
  /** What is there now compared with the selected variant (or with every incoming one when none is chosen) */
  state: 'absent' | 'identical' | 'different'
  beforeDigest: string | null
  afterDigest: string | null
  owner: ProjectDeliveryRecord | null
  preview: ProjectPreview
  action: 'create' | 'unchanged' | 'skip' | 'replace' | 'restore'
  localSlots: LocalSlot[]
  /** Restore plans: what this destination goes back to */
  restore?: { absentBefore: boolean; previousOwner: ProjectDeliveryRecord | null }
}

export interface ProjectPlanView {
  id: string
  kind: 'sync' | 'restore'
  createdAt: string
  root: string
  changes: ProjectPlanChange[]
  /** Physical destinations with several incoming variants and no explicit choice yet */
  collisions: { destinationId: string; variantIds: string[] }[]
  excluded: { selection: ProjectSelection | null; destination?: string; reason: string }[]
  /** No unresolved collision and at least one write */
  applicable: boolean
  restoreOf?: string
}

export type ProjectDecision =
  | {
      destinationId: string
      variantId: string | null
      action: 'create' | 'unchanged' | 'skip' | 'replace'
    }
  | { destinationId: string; action: 'restore' | 'skip' }

export type ProjectResultStatus =
  'pending' | 'done' | 'unchanged' | 'skipped' | 'refused' | 'failed' | 'notAttempted'

/** Persisted before the step it names starts (writing: a project entry may change from here on) */
export type ProjectPhase = 'pending' | 'checked' | 'backedUp' | 'writing' | 'written' | 'recorded'

/** What happened to one physical destination of an apply */
export interface ProjectOperationResult {
  index: number
  destinationId: string
  destination: string
  relativePath: string
  project: { id: string; path: string; name: string }
  kind: GlobalKind
  recipients: GlobalTool[]
  action: ProjectPlanChange['action']
  variantId: string | null
  status: ProjectResultStatus
  phase: ProjectPhase
  code?: string
  beforeDigest: string | null
  afterDigest: string | null
  /** Verified backup taken before this destination changed (kept, never deleted by age) */
  backup?: string
  /** Folders this operation created on the way to the destination, with their identity right after creation */
  createdDirs?: PathIdentity[]
  /** The delivery record written for this destination */
  deliveryId?: string
  /** An aside copy or staged entry that could not be removed after a completed write */
  leftover?: string
}

export interface ProjectOperationRecord {
  version: 1
  scope: 'project'
  id: string
  planId: string
  kind: 'sync' | 'restore'
  restoreOf?: string
  pid: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'refused' | 'cancelled'
  results: ProjectOperationResult[]
  /** Whole-operation refusal (nothing attempted) */
  error?: { code: string; message: string }
}

/** An operation as listed: a running record whose process is gone is interrupted; its unfinished writes uncertain */
export type ProjectOperationView = Omit<ProjectOperationRecord, 'status' | 'results'> & {
  status: ProjectOperationRecord['status'] | 'interrupted'
  results: (Omit<ProjectOperationResult, 'status'> & {
    status: ProjectResultStatus | 'uncertain'
  })[]
}

/** Backend/test-only phase boundaries of an apply (never exposed over IPC) */
export interface ProjectPhaseHooks {
  afterBackup?: (record: ProjectOperationRecord, index: number) => void | Promise<void>
  afterWrite?: (record: ProjectOperationRecord, index: number) => void | Promise<void>
  afterRecord?: (record: ProjectOperationRecord, index: number) => void | Promise<void>
}

/** meta.json of a project backup: written last, after the content was copied, flushed and verified */
export interface ProjectBackupMeta {
  version: 1
  scope: 'project'
  operationId: string
  index: number
  destinationId: string
  destination: string
  relativePath: string
  kind: GlobalKind
  project: CandidateBinding
  /** What was at the destination before the change */
  shape: 'absent' | 'file' | 'dir'
  digest: string | null
  digestAlgorithm: RevisionAlgorithm
  manifest?: CensusEntry[]
  /** Delivery record of the destination before the change (null = not managed by a project delivery) */
  previousOwner: ProjectDeliveryRecord | null
  at: string
}
