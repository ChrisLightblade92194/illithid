/**
 * Operations of the global manual sync (spec 2026-10-04 §9, §10).
 * - Apply lock: one apply per library at a time, across processes (`apply.lock` created exclusively). A lock whose
 *   owner process is gone is stale: it never blocks a new, explicitly requested apply, and never resumes anything.
 * - Operation record: persisted before the first write and after every phase (checked → backedUp → written →
 *   recorded), with paths and digests only (no file contents). A record still `running` whose process is gone is
 *   reported as interrupted; nothing is re-applied or restored automatically.
 * - Backups: completed and verified before a destination is replaced or removed; never deleted by age.
 * - Byte writes: tmp file next to the destination, fsync, re-check of the current digest, rename. The re-check narrows
 *   but does not remove the race with external writers (between the re-check and the rename).
 */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  bytesDigest,
  findSection,
  parseDestination,
  type DestinationState
} from './globalDestinations'
import type { GlobalKind } from './globalImport'
import { globalStateDir, type GlobalTool } from './globalPaths'
import type { DeliveryRecord } from './globalVariants'
import { dirContentHash } from './skills'
import { appTmpName, atomicWrite } from './write'

/** Raised when a re-check right before a write sees content other than the one the plan was made on */
export class ChangedSinceCheck extends Error {
  code = 'changedSinceCheck'
}

// ---------------------------------------------------------------- lock

export interface LockInfo {
  pid: number
  operationId: string
  startedAt: string
  host: string
}

export const lockPath = (home: string): string => join(globalStateDir(home), 'apply.lock')
/** Holder information of the lock (readable by others while the lock itself is held) */
const holderPath = (home: string): string => join(globalStateDir(home), 'apply.lock.json')

/**
 * libuv's UV_FS_O_EXLOCK (uv/win.h): open with no sharing. Node does not export the constant but passes the flag to
 * libuv. While a process keeps the lock file open with it, no other process can open, delete or rename the file; the
 * system closes the handle when the process ends, so a crash never leaves a lock that blocks or that must be removed.
 */
const UV_FS_O_EXLOCK = 0x10000000
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])

export function readLock(home: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(holderPath(home), 'utf8')) as LockInfo
  } catch {
    return null
  }
}

/** Whether a live process holds the apply lock (probe: an exclusive open that is closed at once) */
export function lockHeld(home: string): boolean {
  if (!existsSync(lockPath(home))) return false
  try {
    closeSync(openSync(lockPath(home), constants.O_RDWR | UV_FS_O_EXLOCK))
    return false
  } catch (e) {
    return BUSY.has((e as NodeJS.ErrnoException).code ?? '')
  }
}

/** Failure injection points of the lock (tests reproduce races between processes with them) */
export interface LockHooks {
  /** The lock file was just created or opened, before its holder information is written */
  afterCreate?: () => void
  /** An existing lock file was found and is about to be taken over */
  beforeTakeover?: () => void
}

/**
 * Takes the apply lock of the library (Windows: exclusive handle kept open until release). A lock file left by a
 * process that is gone is reused, never deleted, so no process can remove the lock of the one that took it over.
 * Other platforms are outside the first release: the lock is refused there.
 */
export function acquireApplyLock(
  home: string,
  operationId: string,
  hooks: LockHooks = {}
):
  | { ok: true; release: () => void }
  | { ok: false; code: 'applyInProgress' | 'unsupportedPlatform'; holder: LockInfo | null } {
  if (process.platform !== 'win32') return { ok: false, code: 'unsupportedPlatform', holder: null }
  const path = lockPath(home)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) hooks.beforeTakeover?.()
  let fd: number
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | UV_FS_O_EXLOCK)
  } catch (e) {
    if (BUSY.has((e as NodeJS.ErrnoException).code ?? ''))
      return { ok: false, code: 'applyInProgress', holder: readLock(home) }
    throw e
  }
  try {
    hooks.afterCreate?.()
    const info: LockInfo = {
      pid: process.pid,
      operationId,
      startedAt: new Date().toISOString(),
      host: hostname()
    }
    atomicWrite(holderPath(home), JSON.stringify(info) + '\n')
  } catch (e) {
    closeSync(fd)
    throw e
  }
  return {
    ok: true,
    release: () => {
      try {
        if (readLock(home)?.operationId === operationId) unlinkSync(holderPath(home))
      } finally {
        closeSync(fd)
      }
    }
  }
}

// ---------------------------------------------------------------- operation records

export type ChangeStatus = 'pending' | 'done' | 'unchanged' | 'refused' | 'failed' | 'notAttempted'
export type ChangePhase = 'pending' | 'checked' | 'backedUp' | 'written' | 'recorded'

export interface GlobalChangeResult {
  index: number
  destination: string
  tool: GlobalTool
  kind: GlobalKind
  op: string
  variantId: string
  status: ChangeStatus
  phase: ChangePhase
  code?: string
  beforeDigest: string | null
  afterDigest: string | null
  /** Backup folder of this change (kept, never deleted by age) */
  backup?: string
  /** After a failed write: whether the destination is as before */
  recovery?: 'notNeeded' | 'restored' | 'restoreFailed'
  /** A temporary folder that could not be removed after a successful replacement */
  leftover?: string
}

export type OperationStatus = 'running' | 'completed' | 'partial' | 'failed' | 'refused'

export interface GlobalOperationRecord {
  version: 1
  id: string
  planId: string
  kind: 'sync' | 'restore'
  pid: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  status: OperationStatus
  results: GlobalChangeResult[]
  restoreOf?: string
}

export const operationsDir = (home: string): string => join(globalStateDir(home), 'operations')

export function newOperationId(): string {
  return `op-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function writeOperation(home: string, rec: GlobalOperationRecord): void {
  rec.updatedAt = new Date().toISOString()
  atomicWrite(join(operationsDir(home), `${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n')
}

export function readOperation(home: string, id: string): GlobalOperationRecord | null {
  if (!/^op-[0-9a-z-]+$/.test(id)) return null
  const p = join(operationsDir(home), `${id}.json`)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as GlobalOperationRecord) : null
}

/** Operations, newest first. A `running` record whose process no longer holds the lock is shown as interrupted */
export function listGlobalOperations(
  home: string
): (Omit<GlobalOperationRecord, 'status'> & { status: OperationStatus | 'interrupted' })[] {
  let names: string[]
  try {
    names = readdirSync(operationsDir(home)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const holder = lockHeld(home) ? readLock(home) : null
  return names
    .map((n) => readOperation(home, n.slice(0, -5)))
    .filter((r): r is GlobalOperationRecord => !!r)
    .map((r) => {
      const live = holder?.operationId === r.id
      return r.status === 'running' && !live ? { ...r, status: 'interrupted' as const } : r
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
}

// ---------------------------------------------------------------- backups

export interface BackupMeta {
  version: 1
  operationId: string
  index: number
  destination: string
  tool: GlobalTool
  kind: GlobalKind
  /** What was at the destination before the change */
  shape: 'absent' | 'file' | 'dir' | 'section'
  digest: string | null
  /** Section destinations: whether the instructions file existed */
  fileExisted?: boolean
  /** Absent destinations: the nearest folder that existed (folders created below it can be pruned on removal) */
  existingAncestor?: string
  /** Delivery record of the destination before the change (null = not managed by the app) */
  previousDelivery?: DeliveryRecord | null
  at: string
}

export const backupsDir = (home: string): string => join(globalStateDir(home), 'backups')

function copyTreeExact(src: string, dst: string): void {
  mkdirSync(dst)
  for (const n of readdirSync(src)) {
    const s = join(src, n)
    const d = join(dst, n)
    const st = lstatSync(s)
    if (st.isDirectory() && !st.isSymbolicLink()) copyTreeExact(s, d)
    else if (st.isFile()) copyFileSync(s, d, constants.COPYFILE_EXCL)
    else throw Object.assign(new Error('entry cannot be backed up'), { code: 'unsupportedEntry' })
  }
}

/**
 * Backup of a destination as it is now (state = its current read). The content is copied and verified against the
 * digest before meta.json is written; a backup without meta.json is incomplete and never used.
 */
export function writeBackup(
  home: string,
  operationId: string,
  index: number,
  info: { destination: string; tool: GlobalTool; kind: GlobalKind },
  state: DestinationState,
  previousDelivery: DeliveryRecord | null = null
): string {
  const dir = join(backupsDir(home), operationId, String(index))
  mkdirSync(dir, { recursive: true })
  const d = parseDestination(info.destination)
  const content = join(dir, 'content')
  let shape: BackupMeta['shape'] = 'absent'
  let fileExisted: boolean | undefined
  if (d.kind === 'section') {
    fileExisted = existsSync(d.file)
    if (fileExisted) {
      const buf = readFileSync(d.file)
      atomicWriteBytes(join(dir, 'file'), buf, undefined)
      const s = findSection(buf, d.section)
      if (s !== 'absent' && s !== 'malformed') {
        const body = buf.subarray(s.bodyStart, s.bodyEnd)
        if (bytesDigest(body) !== state.digest) throw new ChangedSinceCheck()
        atomicWriteBytes(content, body, undefined)
        shape = 'section'
      } else if (state.digest !== null) throw new ChangedSinceCheck()
    }
  } else if (state.shape === 'file') {
    copyFileSync(d.path, content, constants.COPYFILE_EXCL)
    if (bytesDigest(readFileSync(content)) !== state.digest) throw new ChangedSinceCheck()
    shape = 'file'
  } else if (state.shape === 'dir') {
    copyTreeExact(d.path, content)
    if (dirContentHash(content) !== state.digest) throw new ChangedSinceCheck()
    shape = 'dir'
  } else if (state.digest !== null) throw new ChangedSinceCheck()
  let existingAncestor: string | undefined
  if (shape === 'absent') {
    let p = dirname(d.kind === 'path' ? d.path : d.file)
    while (!existsSync(p) && dirname(p) !== p) p = dirname(p)
    existingAncestor = p
  }
  const meta: BackupMeta = {
    version: 1,
    operationId,
    index,
    destination: info.destination,
    tool: info.tool,
    kind: info.kind,
    shape,
    digest: state.digest,
    ...(fileExisted !== undefined ? { fileExisted } : {}),
    ...(existingAncestor ? { existingAncestor } : {}),
    previousDelivery,
    at: new Date().toISOString()
  }
  atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return dir
}

export function readBackupMeta(dir: string): BackupMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as BackupMeta
    return m.version === 1 ? m : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- byte writes

function currentFileDigest(path: string): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (!st) return null
  if (!st.isFile()) return `shape:${st.isDirectory() ? 'dir' : 'other'}`
  return bytesDigest(readFileSync(path))
}

/**
 * Writes bytes through a tmp file in the same folder, then renames it over the destination after checking that the
 * destination still has expectedDigest (null = must be absent; undefined = no check). The tmp is removed on failure.
 */
export function atomicWriteBytes(
  path: string,
  buf: Buffer,
  expectedDigest: string | null | undefined
): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), appTmpName(basename(path), randomBytes(4).toString('hex')))
  let committed = false
  try {
    const fd = openSync(tmp, 'wx')
    try {
      let off = 0
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (expectedDigest !== undefined && currentFileDigest(path) !== expectedDigest)
      throw new ChangedSinceCheck()
    renameSync(tmp, path)
    committed = true
  } finally {
    if (!committed && existsSync(tmp)) unlinkSync(tmp)
  }
}

/** Removes a file only if it still has expectedDigest */
export function removeFileChecked(path: string, expectedDigest: string): void {
  if (currentFileDigest(path) !== expectedDigest) throw new ChangedSinceCheck()
  unlinkSync(path)
}

/**
 * Removes the empty folders from `from` up to (not including) `stopAt`; stops at the first folder that is not empty.
 * Used after a removal to drop only the folders an earlier delivery created.
 */
export function pruneEmptyDirs(from: string, stopAt: string): void {
  let p = from
  while (p !== stopAt && dirname(p) !== p && p.toLowerCase().startsWith(stopAt.toLowerCase())) {
    try {
      rmdirSync(p)
    } catch {
      return
    }
    p = dirname(p)
  }
}
