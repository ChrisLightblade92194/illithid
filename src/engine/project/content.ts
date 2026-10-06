/**
 * Complete-content observations of one project rule or skill (spec 2026-10-06 project delivery §Content, §Preview).
 * - Reads go through the census reader: asynchronous bounded reads, the signal checked before every call, links and
 *   junctions never followed (the item, a folder on the way or an entry inside a skill), census read limits enforced
 *   before any content is read. An incomplete observation is refused; it is never a smaller comparable one.
 * - One pass yields two digests of the same bytes: the census digest (rule sha256, skill `census-skill-v1` manifest)
 *   and the library revision (rule sha256, skill `fullTree-v1`, the format of globalTreeDigest). They are distinct
 *   contracts and are carried with their format names.
 * - A copy re-checks the source identities first, verifies every copied file against the observed digest while it is
 *   read, re-lists the source afterwards and verifies the complete copy before returning. A failed copy removes what it
 *   created at the destination; the source is only read.
 */
import { createHash } from 'node:crypto'
import { promises as fsp, type BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { manifestKey } from '../census/compare'
import { identityOf, recheckBinding } from '../census/paths'
import {
  abs,
  CENSUS_LIMITS,
  createReader,
  fsError,
  Incomplete,
  listSkillTree,
  observeSkillTree,
  type CensusLimits,
  type CensusReader,
  type Listed,
  type TreeSink
} from '../census/scan'
import {
  CensusError,
  type CandidateBinding,
  type CensusEntry,
  type PathIdentity
} from '../census/types'
import type { GlobalKind, StoredVariant } from '../globalImport'
import { globalLibraryDir } from '../globalPaths'
import { validVariantName } from '../globalVariants'
import { ProjectError, type ProjectContentObservation } from './types'

const MiB = 1024 * 1024

/** Identity of an entry of the observed item: any change of inode, size or modification time is a change */
const entryPrint = (kind: 'dir' | 'file', st: BigIntStats): string =>
  `${kind}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`

/** A project-relative, slash-separated path without empty, `.` or `..` segments */
export function validRelative(rel: unknown): rel is string {
  return (
    typeof rel === 'string' &&
    !!rel &&
    !/[\\:]/.test(rel) &&
    rel.split('/').every((s) => !!s && s !== '.' && s !== '..')
  )
}

/** Census and filesystem failures as project errors; abort and programming errors pass through */
export function asProjectError(e: unknown): unknown {
  if (e instanceof ProjectError) return e
  if (e instanceof Incomplete)
    return new ProjectError(
      'incomplete',
      `${e.outcome}: ${e.reason}${e.problemPath ? ` (${e.problemPath})` : ''}`,
      e.reason,
      e.problemPath
    )
  if (e instanceof CensusError)
    return new ProjectError(e.code === 'projectChanged' ? 'projectChanged' : 'invalid', e.message)
  if (fsError(e)) return new ProjectError('incomplete', e.message, e.code)
  return e
}

/** Full-tree (`fullTree-v1`) digest fed in listing order: the bytes globalTreeDigest would hash */
function fullTreeSink(): TreeSink & { digest(): string } {
  const h = createHash('sha256')
  return {
    dir: (p) => h.update(`D\0${p}\0`),
    file: (p) => h.update(`F\0${p}\0`),
    chunk: (c) => h.update(c),
    fileEnd: () => h.update('\0'),
    digest: () => h.digest('hex')
  }
}

interface Located {
  st: BigIntStats
  chain: PathIdentity[]
}

/** The item inside the project, every folder on the way checked without following a link */
async function locateItem(reader: CensusReader, project: string, rel: string): Promise<Located> {
  const chain: PathIdentity[] = []
  const st = await reader.locate(project, rel, (r, s) => {
    if (r !== rel) chain.push({ path: abs(project, r), fingerprint: identityOf(s) })
  })
  if (!st) throw new ProjectError('notFound', `${rel} no longer exists.`, 'absent', rel)
  return { st, chain }
}

/** Observation of the item at `parent/name` (no project binding): the shared part of source and copy reads */
export async function observeAt(
  reader: CensusReader,
  limits: CensusLimits,
  parent: string,
  name: string,
  kind: GlobalKind,
  st: BigIntStats
): Promise<
  Pick<
    ProjectContentObservation,
    | 'identities'
    | 'manifest'
    | 'bytes'
    | 'censusDigest'
    | 'censusAlgorithm'
    | 'revision'
    | 'revisionAlgorithm'
  >
> {
  const path = abs(parent, name)
  if (kind === 'rule') {
    if (!st.isFile()) throw new Incomplete('unsupported', 'notAFile')
    const { digest, bytes } = await reader.hashFile(path, st)
    return {
      identities: [{ path, fingerprint: entryPrint('file', st) }],
      bytes,
      censusDigest: digest,
      censusAlgorithm: 'sha256-v1',
      revision: digest,
      revisionAlgorithm: 'sha256-v1'
    }
  }
  if (!st.isDirectory()) throw new Incomplete('unsupported', 'notAFolder')
  const tree = fullTreeSink()
  const { digest, manifest, listed } = await observeSkillTree(reader, limits, parent, name, tree)
  if (!manifest.some((e) => e.path === 'SKILL.md' && e.kind === 'file'))
    throw new Incomplete('unsupported', 'notASkill')
  return {
    identities: identitiesOf(parent, name, listed),
    manifest,
    bytes: manifest.reduce((n, e) => n + (e.bytes ?? 0), 0),
    censusDigest: digest,
    censusAlgorithm: 'census-skill-v1',
    revision: tree.digest(),
    revisionAlgorithm: 'fullTree-v1'
  }
}

function identitiesOf(parent: string, name: string, listed: readonly Listed[]): PathIdentity[] {
  return listed.map((e) => ({
    path: e.path ? abs(parent, `${name}/${e.path}`) : abs(parent, name),
    fingerprint: entryPrint(e.kind, e.st)
  }))
}

/**
 * Complete observation of a project rule (whole file) or skill (whole folder). Refused with a ProjectError: the
 * project no longer matches its binding (projectChanged), the item is absent (notFound) or incomplete (linked,
 * unreadable, unsupported, over a limit, changed while read).
 */
export async function observeProjectContent(
  project: CandidateBinding,
  relativePath: string,
  kind: GlobalKind,
  signal: AbortSignal,
  limits?: Partial<CensusLimits>
): Promise<ProjectContentObservation> {
  signal.throwIfAborted()
  if (!validRelative(relativePath))
    throw new ProjectError('invalid', 'Not a project-relative path.')
  const lim: CensusLimits = { ...CENSUS_LIMITS, ...limits }
  try {
    await recheckBinding(project)
    const reader = createReader(signal, lim)
    const { st, chain } = await locateItem(reader, project.path, relativePath)
    const parts = relativePath.split('/')
    const parent = abs(project.path, parts.slice(0, -1).join('/') || '.')
    const seen = await observeAt(reader, lim, parent, parts[parts.length - 1], kind, st)
    return {
      sourcePath: abs(project.path, relativePath),
      project,
      relativePath,
      kind,
      ...seen,
      identities: [...chain, ...seen.identities]
    }
  } catch (e) {
    throw asProjectError(e)
  }
}

/** Metadata of the observed item now (folders on the way, the item and its whole tree): no content is read */
export async function currentIdentities(
  o: ProjectContentObservation,
  signal: AbortSignal
): Promise<PathIdentity[]> {
  const reader = createReader(signal, CENSUS_LIMITS)
  await recheckBinding(o.project)
  const { st, chain } = await locateItem(reader, o.project.path, o.relativePath)
  if (o.kind === 'rule') {
    if (!st.isFile()) throw new Incomplete('unsupported', 'notAFile')
    return [...chain, { path: o.sourcePath, fingerprint: entryPrint('file', st) }]
  }
  if (!st.isDirectory()) throw new Incomplete('unsupported', 'notAFolder')
  const parts = o.relativePath.split('/')
  const parent = abs(o.project.path, parts.slice(0, -1).join('/') || '.')
  const name = parts[parts.length - 1]
  return [
    ...chain,
    ...identitiesOf(parent, name, await listSkillTree(reader, CENSUS_LIMITS, parent, name))
  ]
}

/** Throws changedSinceCheck unless the item's metadata is exactly the observed one */
export async function recheckIdentities(
  o: ProjectContentObservation,
  signal: AbortSignal
): Promise<void> {
  let now: PathIdentity[]
  try {
    now = await currentIdentities(o, signal)
  } catch (e) {
    const x = asProjectError(e)
    if (x instanceof ProjectError && x.code === 'projectChanged') throw x
    if (x instanceof ProjectError) throw changed(x.reason)
    throw x
  }
  if (JSON.stringify(now) !== JSON.stringify(o.identities)) throw changed()
}

const changed = (reason?: string): ProjectError =>
  new ProjectError('changedSinceCheck', 'The content changed since it was read.', reason)

/**
 * Copies one file, refused unless it is still the listed plain file and its bytes have the expected digest. The
 * destination is created exclusively and flushed before it is closed.
 */
async function copyFileVerified(
  src: string,
  dst: string,
  print: string | undefined,
  expected: { digest: string; bytes: number },
  signal: AbortSignal,
  buffer: Buffer
): Promise<void> {
  signal.throwIfAborted()
  const listed = await fsp.lstat(src, { bigint: true })
  if (listed.isSymbolicLink() || !listed.isFile() || entryPrint('file', listed) !== print)
    throw changed('changedDuringCopy')
  signal.throwIfAborted()
  const from = await fsp.open(src, 'r')
  try {
    const st = await from.stat({ bigint: true })
    if (entryPrint('file', st) !== print) throw changed('changedDuringCopy')
    signal.throwIfAborted()
    const to = await fsp.open(dst, 'wx')
    try {
      const h = createHash('sha256')
      let total = 0
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await from.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        total += bytesRead
        if (total > expected.bytes) throw changed('changedDuringCopy')
        const chunk = buffer.subarray(0, bytesRead)
        h.update(chunk)
        let off = 0
        while (off < chunk.length)
          off += (await to.write(chunk, off, chunk.length - off)).bytesWritten
      }
      if (total !== expected.bytes || h.digest('hex') !== expected.digest)
        throw changed('changedDuringCopy')
      if (entryPrint('file', await from.stat({ bigint: true })) !== print)
        throw changed('changedDuringCopy')
      await to.sync()
    } finally {
      await to.close()
    }
  } finally {
    await from.close()
  }
}

/**
 * Copies the observed item to `destination` (which must not exist; its folder must) and returns the observation of
 * the verified copy. The source must still match the observation before, during and after the copy.
 */
export async function copyProjectContent(
  observation: ProjectContentObservation,
  destination: string,
  signal: AbortSignal
): Promise<ProjectContentObservation> {
  signal.throwIfAborted()
  const o = observation
  const prints = new Map(o.identities.map((i) => [i.path, i.fingerprint]))
  const buffer = Buffer.allocUnsafe(MiB)
  let created = false
  try {
    await recheckIdentities(o, signal)
    signal.throwIfAborted()
    // Only a destination this copy creates is ever removed
    if (
      await fsp.lstat(destination).then(
        () => true,
        () => false
      )
    )
      throw new ProjectError('invalid', 'The copy destination already exists.')
    if (o.kind === 'rule') {
      created = true
      await copyFileVerified(
        o.sourcePath,
        destination,
        prints.get(o.sourcePath),
        { digest: o.censusDigest, bytes: o.bytes },
        signal,
        buffer
      )
    } else {
      created = true
      await fsp.mkdir(destination)
      for (const e of o.manifest ?? []) {
        const src = join(o.sourcePath, ...e.path.split('/'))
        const dst = join(destination, ...e.path.split('/'))
        signal.throwIfAborted()
        if (e.kind === 'dir') await fsp.mkdir(dst)
        else
          await copyFileVerified(
            src,
            dst,
            prints.get(src),
            { digest: e.digest!, bytes: e.bytes! },
            signal,
            buffer
          )
      }
    }
    await recheckIdentities(o, signal)
    // The copy, read back in full: the observed manifest and both digests
    const reader = createReader(signal, CENSUS_LIMITS)
    signal.throwIfAborted()
    const st = await fsp.lstat(destination, { bigint: true })
    if (st.isSymbolicLink()) throw changed('copyReplaced')
    const copy = await observeAt(
      reader,
      CENSUS_LIMITS,
      dirname(destination),
      basename(destination),
      o.kind,
      st
    )
    if (
      copy.censusDigest !== o.censusDigest ||
      copy.revision !== o.revision ||
      (o.kind === 'skill' && manifestKey(copy.manifest!) !== manifestKey(o.manifest!))
    )
      throw changed('copyDiffers')
    return { ...o, ...copy, sourcePath: destination }
  } catch (e) {
    if (created) await fsp.rm(destination, { recursive: true, force: true }).catch(() => {})
    throw asProjectError(e)
  }
}

/** A library variant's content as observed now, from validated storage inside the library */
export interface VariantObservation {
  id: string
  kind: GlobalKind
  name: string
  revision: string
  revisionAlgorithm: 'sha256-v1' | 'fullTree-v1'
  contentPath: string
  manifest?: CensusEntry[]
  identities: PathIdentity[]
  bytes: number
}

const VARIANT_ID = /^(rule|skill)-[0-9a-f]{16}$/

/**
 * Complete observation of a library variant. Its record must name a folder of the library and content inside that
 * folder (`content` for a skill, `content/<file>` for a rule); a path escape, a link or junction anywhere from the
 * variant folder down, or an incomplete read refuses it (reason variantCorrupt / variantLinked / variantUnreadable).
 */
export async function observeLibraryVariant(
  home: string,
  v: StoredVariant & { dir: string },
  signal: AbortSignal
): Promise<VariantObservation> {
  signal.throwIfAborted()
  const lib = globalLibraryDir(home)
  const corrupt = (why: string): ProjectError =>
    new ProjectError('refused', `Library variant ${v.id}: ${why}.`, 'variantCorrupt')
  if (typeof v.id !== 'string' || !VARIANT_ID.test(v.id) || !v.id.startsWith(`${v.kind}-`))
    throw corrupt('unexpected id')
  if (v.dir !== join(lib, v.id)) throw corrupt('unexpected folder')
  const fileName = v.kind === 'rule' ? /^content\/([^\\/:*?"<>|]+)$/.exec(v.content)?.[1] : null
  if (
    v.kind === 'skill'
      ? v.content !== 'content'
      : !fileName || fileName === '.' || fileName === '..'
  )
    throw corrupt('content outside the variant folder')
  if (typeof v.name !== 'string' || !validVariantName(v.kind, v.name)) throw corrupt('invalid name')
  const reader = createReader(signal, CENSUS_LIMITS)
  const contentPath = join(v.dir, ...v.content.split('/'))
  try {
    const chain: PathIdentity[] = []
    let st: BigIntStats | null = null
    for (const p of v.kind === 'rule'
      ? [v.dir, join(v.dir, 'content'), contentPath]
      : [v.dir, contentPath]) {
      st = await reader.fs.lstat(p)
      if (st.isSymbolicLink())
        throw new ProjectError(
          'refused',
          `Library variant ${v.id}: linked content.`,
          'variantLinked'
        )
      if (p !== contentPath) {
        if (!st.isDirectory()) throw corrupt('not a folder')
        chain.push({ path: p, fingerprint: identityOf(st) })
      }
    }
    const seen = await observeAt(
      reader,
      CENSUS_LIMITS,
      dirname(contentPath),
      basename(contentPath),
      v.kind,
      st!
    )
    return {
      id: v.id,
      kind: v.kind,
      name: v.name,
      revision: seen.revision,
      revisionAlgorithm: seen.revisionAlgorithm,
      contentPath,
      ...(seen.manifest ? { manifest: seen.manifest } : {}),
      identities: [...chain, ...seen.identities],
      bytes: seen.bytes
    }
  } catch (e) {
    const x = asProjectError(e)
    if (x instanceof ProjectError && x.code === 'incomplete')
      throw new ProjectError(
        'refused',
        `Library variant ${v.id}: ${x.message}`,
        'variantUnreadable'
      )
    throw x
  }
}
