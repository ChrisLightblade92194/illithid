/**
 * Project census candidates (spec 2026-10-06 §User flow 2, §Read boundaries): the chosen root and its immediate
 * folders, from directory metadata only — no configuration content, no grandchildren. Links and junctions are never
 * followed: a linked root, ancestor or child stays visible with its stored link text and cannot be scanned.
 * Each binding keeps the identity of every folder from the filesystem root down to its candidate, so a selection is
 * refused once one of them was replaced, linked or removed, even with identical contents.
 * Filesystem access goes through fs.promises only: asynchronous in the Electron main process, observable by tests.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  CensusError,
  type CandidateBinding,
  type CandidateStatus,
  type CensusCandidate,
  type DiscoveryHandle,
  type PathIdentity
} from './types'

export const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? 'readFailed'

/** Identity of a path from its own metadata (lstat, never through a link) */
export const identityOf = (st: BigIntStats): string => `${st.dev}:${st.ino}:${st.birthtimeNs}`

/** Stored text of a link or junction, without resolving it */
export async function linkText(p: string): Promise<string | undefined> {
  try {
    return await fsp.readlink(p)
  } catch {
    return undefined
  }
}

/** Folders from the filesystem root down to p, inclusive */
function chainOf(p: string): string[] {
  const out: string[] = []
  for (let q = p; ; q = dirname(q)) {
    out.unshift(q)
    if (dirname(q) === q) return out
  }
}

/** An absolute local folder path; on Windows a drive-letter path (no UNC, \\?\ or \\.\ namespace) */
function rootPath(root: unknown): string {
  if (typeof root !== 'string' || !root)
    throw new CensusError('invalid', 'root must be a non-empty string')
  const local =
    process.platform === 'win32'
      ? !/^[\\/]{2}/.test(root) && /^[A-Za-z]:[\\/]/.test(root)
      : isAbsolute(root)
  if (!local)
    throw new CensusError(
      'unsupportedPath',
      'Only absolute local folders are supported (no network or device paths).'
    )
  return resolve(root)
}

/** Case-insensitive order with an ordinal tie-break: deterministic, and never merges distinct names */
function byName(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function candidate(
  path: string,
  name: string,
  isRoot: boolean,
  status: CandidateStatus,
  reason?: string,
  link?: string
): CensusCandidate {
  return {
    id: randomUUID(),
    path,
    name,
    isRoot,
    status,
    ...(reason ? { reason } : {}),
    ...(link !== undefined ? { linkText: link } : {})
  }
}

/**
 * The root and its immediate folders. Enumerates the root only; each child is examined with lstat (and readlink for a
 * link). Files are not candidates. A root below a link, or whose chain cannot be examined, is the only candidate.
 */
export async function discoverProjects(root: string): Promise<DiscoveryHandle> {
  const path = rootPath(root)
  const name = basename(path) || path
  const bindings = new Map<string, CandidateBinding>()
  const view = { id: randomUUID(), root: path, candidates: [] as CensusCandidate[] }
  const only = (c: CensusCandidate): DiscoveryHandle => {
    view.candidates.push(c)
    return { view, bindings }
  }
  const chain: PathIdentity[] = []
  for (const p of chainOf(path)) {
    let st: BigIntStats
    try {
      st = await fsp.lstat(p, { bigint: true })
    } catch (e) {
      const code = errCode(e)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new CensusError('notFound', `${path} does not exist.`)
      return only(candidate(path, name, true, 'unreadable', code))
    }
    if (st.isSymbolicLink())
      return only(
        candidate(
          path,
          name,
          true,
          'linked',
          p === path ? 'link' : 'linkedAncestor',
          await linkText(p)
        )
      )
    if (!st.isDirectory())
      throw new CensusError(p === path ? 'notADirectory' : 'notFound', `${path} is not a folder.`)
    chain.push({ path: p, fingerprint: identityOf(st) })
  }
  // A mapped network drive only shows once resolved; the chain above holds no link to follow
  if (process.platform === 'win32') {
    try {
      if (/^[\\/]{2}/.test(await fsp.realpath(path)))
        return only(candidate(path, name, true, 'unsupported', 'networkPath'))
    } catch (e) {
      return only(candidate(path, name, true, 'unreadable', errCode(e)))
    }
  }
  let names: string[]
  try {
    names = await fsp.readdir(path)
  } catch (e) {
    return only(candidate(path, name, true, 'unreadable', errCode(e)))
  }
  const rootCandidate = candidate(path, name, true, 'available')
  view.candidates.push(rootCandidate)
  bindings.set(rootCandidate.id, { path, chain })
  for (const n of names.sort(byName)) {
    const p = join(path, n)
    let st: BigIntStats
    try {
      st = await fsp.lstat(p, { bigint: true })
    } catch (e) {
      if (errCode(e) !== 'ENOENT')
        view.candidates.push(candidate(p, n, false, 'unreadable', errCode(e)))
      continue
    }
    if (st.isSymbolicLink()) {
      view.candidates.push(candidate(p, n, false, 'linked', 'link', await linkText(p)))
      continue
    }
    if (!st.isDirectory()) continue
    const c = candidate(p, n, false, 'available')
    view.candidates.push(c)
    bindings.set(c.id, { path: p, chain: [...chain, { path: p, fingerprint: identityOf(st) }] })
  }
  return { view, bindings }
}

/** Refuses (projectChanged) once a folder of the binding's chain is missing, linked or another folder */
export async function recheckBinding(b: CandidateBinding): Promise<void> {
  for (const { path, fingerprint } of b.chain) {
    let st: BigIntStats | undefined
    try {
      st = await fsp.lstat(path, { bigint: true })
    } catch {
      st = undefined
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory() || identityOf(st) !== fingerprint)
      throw new CensusError(
        'projectChanged',
        `${b.path} changed since the projects were listed: list them again.`
      )
  }
}

/**
 * The selected candidates, in discovery order. Only bound (available) candidates of this discovery, each once; refused
 * as invalid before any filesystem access otherwise. Then every folder of each chain is checked again.
 */
export async function validateSelection(
  discovery: DiscoveryHandle,
  candidateIds: readonly string[]
): Promise<CensusCandidate[]> {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0)
    throw new CensusError('invalid', 'Select at least one project.')
  const seen = new Set<string>()
  for (const id of candidateIds as unknown[]) {
    if (typeof id !== 'string' || !discovery.bindings.has(id))
      throw new CensusError('invalid', 'Not an available project of this listing.')
    if (seen.has(id)) throw new CensusError('invalid', 'A project is selected twice.')
    seen.add(id)
  }
  for (const id of seen) await recheckBinding(discovery.bindings.get(id)!)
  return discovery.view.candidates.filter((c) => seen.has(c.id))
}
