/**
 * Project census inventory (spec 2026-10-06 §Paths covered, §Comparison model, §Read boundaries). Reads only the fixed
 * covered paths of the selected projects, never through a link or junction, with asynchronous bounded reads
 * (fs.promises) so the Electron main process stays responsive. Every call first checks the abort signal.
 * A skill is observed as its complete tree — every entry, hidden ones and .DS_Store included: listed first (metadata
 * only, limits enforced before any content read), hashed file by file, then listed again; any difference marks it
 * changed. One item's failure never discards the others; an incomplete item carries no digest and no manifest.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { groupItems, manifestKey } from './compare'
import { errCode, linkText, recheckBinding, validateSelection } from './paths'
import {
  CensusError,
  type CensusEntry,
  type CensusItem,
  type CensusKind,
  type CensusProgress,
  type CensusProjectSummary,
  type CensusSnapshot,
  type CensusTool,
  type DiscoveryHandle,
  type ItemOutcome
} from './types'

const MiB = 1024 * 1024

export interface CensusLimits {
  /** Bytes of one file (rule or skill entry) */
  fileBytes: number
  /** Total file bytes of one skill */
  skillBytes: number
  /** Entries of one skill (files and folders; the skill folder itself is not counted) */
  skillEntries: number
  /** Levels inside a recognized tree (the tree root is level 0, an entry directly in it level 1) */
  depth: number
}

/** Read limits: exceeding one makes the item incomplete, never a smaller comparable observation */
export const CENSUS_LIMITS: CensusLimits = {
  fileBytes: 64 * MiB,
  skillBytes: 256 * MiB,
  skillEntries: 10_000,
  depth: 64
}

/** Documented project-local conventions of each tool: potential consumers, not proof that a session loads them */
const CONVENTIONS: Record<CensusTool, { file: string[]; ruleDir: string[]; skillDir: string[] }> = {
  claude: {
    file: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
    ruleDir: ['.claude/rules'],
    skillDir: ['.claude/skills']
  },
  codex: { file: ['AGENTS.md', 'AGENTS.override.md'], ruleDir: [], skillDir: ['.agents/skills'] },
  opencode: {
    file: ['AGENTS.md', 'CLAUDE.md'],
    ruleDir: [],
    skillDir: ['.claude/skills', '.agents/skills', '.opencode/skills']
  }
}
const TOOLS: CensusTool[] = ['claude', 'codex', 'opencode']

interface Position {
  kind: 'file' | 'ruleDir' | 'skillDir'
  path: string
  consumers: CensusTool[]
}

/** Each covered path once, in the spec's table order, labelled with every tool whose convention names it */
const POSITIONS: Position[] = (
  [
    ['file', 'AGENTS.md'],
    ['file', 'AGENTS.override.md'],
    ['file', 'CLAUDE.md'],
    ['file', 'CLAUDE.local.md'],
    ['file', '.claude/CLAUDE.md'],
    ['ruleDir', '.claude/rules'],
    ['skillDir', '.claude/skills'],
    ['skillDir', '.agents/skills'],
    ['skillDir', '.opencode/skills']
  ] as const
).map(([kind, path]) => ({
  kind,
  path,
  consumers: TOOLS.filter((t) => CONVENTIONS[t][kind].includes(path))
}))

export const CENSUS_COVERAGE: readonly string[] = POSITIONS.map((p) =>
  p.kind === 'file' ? p.path : p.kind === 'ruleDir' ? `${p.path}/**/*.md` : `${p.path}/<folder>/`
)

export interface ScanOptions {
  signal: AbortSignal
  onProgress: (progress: CensusProgress) => void
  /** Overrides of CENSUS_LIMITS (tests check each threshold without huge fixtures) */
  limits?: Partial<CensusLimits>
}

/** Why an item is incomplete; thrown by the readers, caught per item */
class Incomplete extends Error {
  constructor(
    public outcome: Exclude<ItemOutcome, 'complete'>,
    public reason: string,
    public problemPath?: string,
    public link?: string
  ) {
    super(reason)
  }
}

/** A filesystem error (errno code) makes one item incomplete; anything else (abort, bugs) ends the census */
const fsError = (e: unknown): e is NodeJS.ErrnoException =>
  typeof (e as { code?: unknown } | null)?.code === 'string' && !(e instanceof CensusError)

function incomplete(e: unknown): Incomplete {
  if (e instanceof Incomplete) return e
  if (fsError(e)) return new Incomplete('unreadable', errCode(e))
  throw e
}

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const abs = (project: string, rel: string): string => join(project, ...rel.split('/'))
const unchanged = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs

interface Listed {
  path: string
  kind: 'dir' | 'file'
  st: BigIntStats
}

export interface CensusReader {
  fs: {
    lstat(p: string): Promise<BigIntStats>
    readdir(p: string): Promise<string[]>
    readlink(p: string): Promise<string | undefined>
  }
  hashFile(
    p: string,
    st: BigIntStats,
    onChunk?: (chunk: Buffer) => void
  ): Promise<{ digest: string; bytes: number }>
  locate(project: string, rel: string): Promise<BigIntStats | null>
}

/**
 * Filesystem access of the census and of its details: the signal is checked before every call, links are never
 * followed, files are read in bounded chunks. Readers throw Incomplete or filesystem errors.
 */
export function createReader(signal: AbortSignal, limits: CensusLimits): CensusReader {
  const buffer = Buffer.allocUnsafe(MiB)
  /** Every filesystem call starts only while the census is not cancelled */
  const fs = {
    lstat: (p: string): Promise<BigIntStats> => {
      signal.throwIfAborted()
      return fsp.lstat(p, { bigint: true })
    },
    readdir: async (p: string): Promise<string[]> => {
      signal.throwIfAborted()
      return (await fsp.readdir(p)).sort(ordinal)
    },
    readlink: (p: string): Promise<string | undefined> => {
      signal.throwIfAborted()
      return linkText(p)
    }
  }

  /** Digest of a file as listed (st): bounded, incremental, refused if it is not the listed file or changes meanwhile */
  async function hashFile(
    p: string,
    st: BigIntStats,
    onChunk?: (chunk: Buffer) => void
  ): Promise<{ digest: string; bytes: number }> {
    if (st.size > BigInt(limits.fileBytes)) throw new Incomplete('limitExceeded', 'fileBytes')
    signal.throwIfAborted()
    const fh = await fsp.open(p, 'r')
    try {
      const changed = new Incomplete('changed', 'changedDuringRead')
      if (!unchanged(await fh.stat({ bigint: true }), st)) throw changed
      const h = createHash('sha256')
      let total = 0
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        total += bytesRead
        if (BigInt(total) > st.size) throw changed
        h.update(buffer.subarray(0, bytesRead))
        onChunk?.(buffer.subarray(0, bytesRead))
      }
      if (BigInt(total) !== st.size || !unchanged(await fh.stat({ bigint: true }), st))
        throw changed
      return { digest: h.digest('hex'), bytes: total }
    } finally {
      await fh.close()
    }
  }

  /**
   * lstat of a covered path, walking its folders inside the project without following any link. null = absent
   * (ENOENT only). A link on the way makes the position incomplete (linkedAncestor), as does the path itself being a
   * link; so does a folder of the path that exists but is not a folder (ancestorNotAFolder), or any other error.
   */
  async function locate(project: string, rel: string): Promise<BigIntStats | null> {
    const parts = rel.split('/')
    for (let i = 0; i < parts.length; i++) {
      const r = parts.slice(0, i + 1).join('/')
      const last = i === parts.length - 1
      let st: BigIntStats
      try {
        st = await fs.lstat(abs(project, r))
      } catch (e) {
        // Only a missing entry is an ordinary absence; ENOTDIR and every other error leave the position unread
        if (fsError(e) && e.code === 'ENOENT') return null
        const x = incomplete(e)
        if (!last) x.problemPath = r
        throw x
      }
      if (st.isSymbolicLink())
        throw new Incomplete(
          'linked',
          last ? 'link' : 'linkedAncestor',
          last ? undefined : r,
          await fs.readlink(abs(project, r))
        )
      if (last) return st
      // A file (or other entry) where a folder of the path belongs: present but not valid, so incomplete
      if (!st.isDirectory()) throw new Incomplete('unsupported', 'ancestorNotAFolder', r)
    }
    return null
  }

  return { fs, hashFile, locate }
}

export async function scanProjects(
  discovery: DiscoveryHandle,
  candidateIds: readonly string[],
  options: ScanOptions
): Promise<CensusSnapshot> {
  const { signal, onProgress } = options
  signal.throwIfAborted()
  const limits: CensusLimits = { ...CENSUS_LIMITS, ...options.limits }
  const startedAt = new Date().toISOString()
  const selected = await validateSelection(discovery, candidateIds)
  const progress: CensusProgress = {
    projectsCompleted: 0,
    projectsTotal: selected.length,
    itemsCompleted: 0
  }
  const report = (patch: Partial<CensusProgress>): void => {
    Object.assign(progress, patch)
    onProgress({ ...progress })
  }
  const scanId = randomUUID()
  let seq = 0
  const items: CensusItem[] = []
  const projects: CensusProjectSummary[] = []

  const { fs, hashFile, locate } = createReader(signal, limits)

  /** Complete metadata listing of a skill tree, limits enforced; nothing is opened */
  async function listSkill(project: string, rel: string): Promise<Listed[]> {
    const out: Listed[] = []
    let bytes = 0
    const root = await fs.lstat(abs(project, rel))
    if (root.isSymbolicLink() || !root.isDirectory())
      throw new Incomplete('changed', 'changedDuringRead')
    out.push({ path: '', kind: 'dir', st: root })
    const walk = async (dirRel: string, depth: number): Promise<void> => {
      const dir = dirRel ? `${rel}/${dirRel}` : rel
      let names: string[]
      try {
        names = await fs.readdir(abs(project, dir))
      } catch (e) {
        const x = incomplete(e)
        x.problemPath = dir
        throw x
      }
      for (const n of names) {
        const r = dirRel ? `${dirRel}/${n}` : n
        const where = `${rel}/${r}`
        if (depth + 1 > limits.depth) throw new Incomplete('limitExceeded', 'depth', where)
        if (out.length > limits.skillEntries)
          throw new Incomplete('limitExceeded', 'skillEntries', where)
        let st: BigIntStats
        try {
          st = await fs.lstat(abs(project, where))
        } catch (e) {
          const x = incomplete(e)
          x.problemPath = where
          throw x
        }
        if (st.isSymbolicLink())
          throw new Incomplete(
            'linked',
            'linkInside',
            where,
            await fs.readlink(abs(project, where))
          )
        if (st.isDirectory()) {
          out.push({ path: r, kind: 'dir', st })
          await walk(r, depth + 1)
        } else if (st.isFile()) {
          if (st.size > BigInt(limits.fileBytes))
            throw new Incomplete('limitExceeded', 'fileBytes', where)
          bytes += Number(st.size)
          if (bytes > limits.skillBytes) throw new Incomplete('limitExceeded', 'skillBytes', where)
          out.push({ path: r, kind: 'file', st })
        } else throw new Incomplete('unsupported', 'unsupportedEntry', where)
      }
    }
    await walk('', 0)
    return out
  }

  const signature = (l: Listed[]): string =>
    l
      .map((e) => `${e.path}\0${e.kind}\0${e.st.dev}:${e.st.ino}:${e.st.size}:${e.st.mtimeNs}`)
      .join('\n')

  /** Manifest and digest of a complete skill tree, or Incomplete */
  async function observeSkill(
    project: string,
    rel: string
  ): Promise<{ digest: string; manifest: CensusEntry[] }> {
    const listed = await listSkill(project, rel)
    const manifest: CensusEntry[] = []
    for (const e of listed.slice(1)) {
      if (e.kind === 'dir') {
        manifest.push({ path: e.path, kind: 'dir' })
        continue
      }
      try {
        const { digest, bytes } = await hashFile(abs(project, `${rel}/${e.path}`), e.st)
        manifest.push({ path: e.path, kind: 'file', bytes, digest })
      } catch (err) {
        const x = incomplete(err)
        x.problemPath ??= `${rel}/${e.path}`
        throw x
      }
    }
    if (signature(await listSkill(project, rel)) !== signature(listed))
      throw new Incomplete('changed', 'changedDuringRead')
    manifest.sort((a, b) => ordinal(a.path, b.path))
    return {
      digest: createHash('sha256')
        .update(`census-skill-v1\0${manifestKey(manifest)}`)
        .digest('hex'),
      manifest
    }
  }

  for (const candidate of selected) {
    signal.throwIfAborted()
    const project = candidate.path
    const own: CensusItem[] = []
    const add = (
      kind: CensusKind,
      name: string,
      relativePath: string,
      consumers: CensusTool[],
      result: { digest: string; bytes?: number; manifest?: CensusEntry[] } | Incomplete
    ): void => {
      const base = { id: `${scanId}:${seq++}`, projectId: candidate.id, kind, name, relativePath }
      own.push(
        result instanceof Incomplete
          ? {
              ...base,
              consumers,
              outcome: result.outcome,
              reason: result.reason,
              ...(result.problemPath ? { problemPath: result.problemPath } : {}),
              ...(result.link !== undefined ? { linkText: result.link } : {})
            }
          : { ...base, consumers, outcome: 'complete', ...result }
      )
      report({ itemsCompleted: progress.itemsCompleted + 1 })
    }
    /** Runs one read; an Incomplete outcome (or filesystem error) becomes that item's result */
    const attempt = async <T>(read: () => Promise<T>): Promise<T | Incomplete> => {
      try {
        return await read()
      } catch (e) {
        return incomplete(e)
      }
    }

    const rule = async (rel: string, consumers: CensusTool[], st: BigIntStats): Promise<void> => {
      report({ currentProject: candidate.name, currentPath: rel })
      add(
        'rule',
        rel,
        rel,
        consumers,
        st.isFile()
          ? await attempt(() => hashFile(abs(project, rel), st))
          : new Incomplete('unsupported', 'notAFile')
      )
    }

    const ruleTree = async (rel: string, consumers: CensusTool[], depth: number): Promise<void> => {
      const names = await attempt(() => fs.readdir(abs(project, rel)))
      if (names instanceof Incomplete) return add('rule', rel, rel, consumers, names)
      for (const n of names) {
        const r = `${rel}/${n}`
        if (depth + 1 > limits.depth)
          return add('rule', rel, rel, consumers, new Incomplete('limitExceeded', 'depth', r))
        const st = await attempt(() => fs.lstat(abs(project, r)))
        if (st instanceof Incomplete) add('rule', r, r, consumers, st)
        else if (st.isSymbolicLink())
          add(
            'rule',
            r,
            r,
            consumers,
            new Incomplete('linked', 'link', undefined, await fs.readlink(abs(project, r)))
          )
        else if (st.isDirectory()) await ruleTree(r, consumers, depth + 1)
        else if (st.isFile() && /\.md$/i.test(n)) await rule(r, consumers, st)
      }
    }

    const skillContainer = async (rel: string, consumers: CensusTool[]): Promise<void> => {
      const names = await attempt(() => fs.readdir(abs(project, rel)))
      if (names instanceof Incomplete) return add('skill', rel, rel, consumers, names)
      for (const n of names) {
        const r = `${rel}/${n}`
        const st = await attempt(() => fs.lstat(abs(project, r)))
        if (st instanceof Incomplete) {
          add('skill', n, r, consumers, st)
          continue
        }
        if (st.isSymbolicLink()) {
          add(
            'skill',
            n,
            r,
            consumers,
            new Incomplete('linked', 'link', undefined, await fs.readlink(abs(project, r)))
          )
          continue
        }
        if (!st.isDirectory()) continue
        report({ currentProject: candidate.name, currentPath: r })
        const md = await attempt(() => fs.lstat(abs(project, `${r}/SKILL.md`)))
        if (md instanceof Incomplete && md.reason === 'ENOENT')
          add('skill', n, r, consumers, new Incomplete('unsupported', 'notASkill'))
        else if (md instanceof Incomplete) add('skill', n, r, consumers, md)
        else if (md.isDirectory())
          add('skill', n, r, consumers, new Incomplete('unsupported', 'notASkill'))
        else add('skill', n, r, consumers, await attempt(() => observeSkill(project, r)))
      }
    }

    try {
      await recheckBinding(discovery.bindings.get(candidate.id)!)
    } catch (e) {
      if (!(e instanceof CensusError)) throw e
      projects.push({
        candidateId: candidate.id,
        path: project,
        name: candidate.name,
        isRoot: candidate.isRoot,
        status: 'changed',
        rules: 0,
        skills: 0,
        incomplete: 0,
        empty: false
      })
      report({ projectsCompleted: progress.projectsCompleted + 1 })
      continue
    }
    for (const pos of POSITIONS) {
      report({ currentProject: candidate.name, currentPath: pos.path })
      const st = await attempt(() => locate(project, pos.path))
      if (st === null) continue
      const kind: CensusKind = pos.kind === 'skillDir' ? 'skill' : 'rule'
      if (st instanceof Incomplete) add(kind, pos.path, pos.path, pos.consumers, st)
      else if (pos.kind === 'file') await rule(pos.path, pos.consumers, st)
      else if (!st.isDirectory())
        add(kind, pos.path, pos.path, pos.consumers, new Incomplete('unsupported', 'notAFolder'))
      else if (pos.kind === 'ruleDir') await ruleTree(pos.path, pos.consumers, 0)
      else await skillContainer(pos.path, pos.consumers)
    }
    items.push(...own)
    const done = own.filter((i) => i.outcome === 'complete')
    projects.push({
      candidateId: candidate.id,
      path: project,
      name: candidate.name,
      isRoot: candidate.isRoot,
      status: 'scanned',
      rules: done.filter((i) => i.kind === 'rule').length,
      skills: done.filter((i) => i.kind === 'skill').length,
      incomplete: own.length - done.length,
      empty: own.length === 0
    })
    report({ projectsCompleted: progress.projectsCompleted + 1 })
  }
  return {
    root: discovery.view.root,
    startedAt,
    finishedAt: new Date().toISOString(),
    coverage: [...CENSUS_COVERAGE],
    projects,
    items,
    ...groupItems(items)
  }
}
