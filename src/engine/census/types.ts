/**
 * Project census contracts (spec 2026-10-06): views shared with the renderer and the engine/IPC handles. Node-free, so
 * the renderer can import its types. Candidate bindings (paths and identities to recheck) never reach the renderer.
 */

/** Tools whose documented conventions name a covered path (potential consumers, not proof of loading) */
export type CensusTool = 'claude' | 'codex' | 'opencode'

export type CandidateStatus = 'available' | 'linked' | 'unreadable' | 'unsupported'

export interface CensusCandidate {
  id: string
  path: string
  name: string
  /** The chosen root itself (shown apart from its immediate folders) */
  isRoot: boolean
  status: CandidateStatus
  /** Why a candidate cannot be scanned (an error code or a census reason) */
  reason?: string
  /** Stored text of a link or junction, when it can be read (never resolved) */
  linkText?: string
}

export interface CensusDiscovery {
  id: string
  root: string
  candidates: CensusCandidate[]
}

/** Identity of one path at discovery time */
export interface PathIdentity {
  path: string
  /** dev, inode (file index on Windows) and birth time, from lstat */
  fingerprint: string
}

/** What the backend rechecks before reading a candidate: every folder from the filesystem root to the candidate */
export interface CandidateBinding {
  path: string
  chain: PathIdentity[]
}

export interface DiscoveryHandle {
  view: CensusDiscovery
  bindings: ReadonlyMap<string, CandidateBinding>
}

/** One entry of a skill tree, relative to the skill folder (slash-separated); the folder itself is not an entry */
export interface CensusEntry {
  path: string
  kind: 'dir' | 'file'
  bytes?: number
  digest?: string
}

export type CensusKind = 'rule' | 'skill'

export type ItemOutcome =
  'complete' | 'linked' | 'unreadable' | 'changed' | 'unsupported' | 'limitExceeded'

export interface CensusItem {
  id: string
  projectId: string
  kind: CensusKind
  /** Rules: the project-relative path; skills: the outer folder name */
  name: string
  /** Slash-separated, relative to the project */
  relativePath: string
  consumers: CensusTool[]
  outcome: ItemOutcome
  reason?: string
  /** Stored link text of the linked entry that made the item incomplete */
  linkText?: string
  /** Project-relative path of the entry the reason applies to, when it is not the item itself */
  problemPath?: string
  /** Only complete items have a comparable digest */
  digest?: string
  /** Rules: file length */
  bytes?: number
  /** Skills (complete only): sorted entries, outer folder name excluded */
  manifest?: CensusEntry[]
}

export interface CensusGroup {
  id: string
  kind: CensusKind
  itemIds: string[]
}

export interface CensusGrouping {
  /** Two or more complete items with the same kind and content, whatever their names or projects */
  equalGroups: CensusGroup[]
  /** Same kind and case-insensitive name, at least two different complete contents */
  sameNameDifferences: CensusGroup[]
  /** Complete items whose content occurs once in the snapshot */
  uniqueItemIds: string[]
}

export interface CensusProjectSummary {
  candidateId: string
  path: string
  name: string
  isRoot: boolean
  /** scanned, or changed: the project no longer matched its discovery when its turn came (nothing read) */
  status: 'scanned' | 'changed'
  rules: number
  skills: number
  incomplete: number
  /** No matching local configuration in the covered paths (and nothing incomplete) */
  empty: boolean
}

export interface CensusSnapshot extends CensusGrouping {
  root: string
  startedAt: string
  finishedAt: string
  /** Covered paths, relative to each project: absence and uniqueness are scoped to them */
  coverage: string[]
  projects: CensusProjectSummary[]
  items: CensusItem[]
}

export interface CensusProgress {
  projectsCompleted: number
  projectsTotal: number
  itemsCompleted: number
  currentProject?: string
  currentPath?: string
}

export interface CensusRunView {
  runId: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  progress: CensusProgress
  snapshot?: CensusSnapshot
  reason?: string
}

export interface CensusSideRef {
  itemId: string
  projectPath: string
  relativePath: string
  fullPath: string
}

export interface RulePreview extends CensusSideRef {
  bytes: number
  /** Decoded only when the bytes are valid in that encoding; unknown = not shown as text */
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | 'unknown'
  lineEndings: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'
  /** At most RULE_PREVIEW_BYTES of the file; null when the encoding is unknown */
  text: string | null
  truncated: boolean
}

export type CensusDetails =
  | { kind: 'rule'; left: RulePreview; right: RulePreview; identical: boolean }
  | {
      kind: 'skill'
      left: CensusSideRef
      right: CensusSideRef
      added: string[]
      removed: string[]
      changed: string[]
    }

export type CensusErrorCode =
  | 'invalid'
  | 'stale'
  | 'projectChanged'
  | 'changedSinceCensus'
  | 'unsupportedPath'
  | 'notFound'
  | 'notADirectory'
  | 'unsupportedPlatform'

export class CensusError extends Error {
  constructor(
    public code: CensusErrorCode,
    message: string
  ) {
    super(message)
  }
}
