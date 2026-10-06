/**
 * Project destinations (spec 2026-10-06 project delivery §Project destination conventions, §Physical collisions and
 * existing content).
 * - Native slots, relative to a confirmed project root: Claude `CLAUDE.md` / `.claude/skills/<name>/`, Codex
 *   `AGENTS.md` / `.agents/skills/<name>/`, OpenCode `AGENTS.md` / `.opencode/skills/<name>/`; explicit rule
 *   alternatives per tool. No absolute path, traversal or configured external path is ever accepted.
 * - An observation walks the destination from the project folder with metadata only, never through a link or
 *   junction (as the destination, a folder on the way, or inside a skill), and reads the existing content completely
 *   within the census limits. Each existing name must be spelled exactly as on disk: a case-only spelling difference,
 *   and a file with several hard links, are ambiguous aliases and are refused rather than guessed.
 * - Physical identity: an existing entry is keyed by its file id; an absent one by the identity of its nearest existing
 *   folder plus the exact missing names. Distinct entries are never equated by lowercasing.
 * The tool slot describes a convention, not proof that a tool loads the file or uses it exclusively.
 */
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { identityOf, recheckBinding } from '../census/paths'
import {
  CENSUS_LIMITS,
  createReader,
  Incomplete,
  observeSkillTree,
  type CensusReader
} from '../census/scan'
import type { CandidateBinding, PathIdentity } from '../census/types'
import type { GlobalKind } from '../globalImport'
import { GLOBAL_TOOLS, type GlobalTool } from '../globalPaths'
import { validVariantName } from '../globalVariants'
import { asProjectError } from './content'
import {
  ProjectError,
  type LocalSlot,
  type ProjectContext,
  type ProjectDestinationObservation,
  type ProjectSlot
} from './types'

const SKILL_DIR: Record<GlobalTool, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  opencode: '.opencode/skills'
}

const invalid = (message: string): ProjectError => new ProjectError('invalid', message)

const SLOT_TYPES = new Set([
  'default',
  'claudeNested',
  'claudeLocal',
  'claudeNamedRule',
  'codexOverride',
  'opencodeClaude'
])

/** A slot request with exactly its keys (a named Claude rule carries its name, nothing else does) */
export function parseProjectSlot(v: unknown): ProjectSlot {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw invalid('A slot must be an object.')
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  if (o.type === 'claudeNamedRule') {
    if (keys !== 'name,type' || typeof o.name !== 'string')
      throw invalid('A named Claude rule slot needs exactly a type and a name.')
    return { type: 'claudeNamedRule', name: o.name }
  }
  if (typeof o.type !== 'string' || !SLOT_TYPES.has(o.type) || keys !== 'type')
    throw invalid('Unknown slot.')
  return { type: o.type } as ProjectSlot
}

/** The slot's path relative to the project (slash-separated); refuses slots of another tool or kind */
export function projectSlotPath(
  kind: GlobalKind,
  name: string,
  tool: GlobalTool,
  slot: ProjectSlot
): string {
  if (!GLOBAL_TOOLS.includes(tool)) throw invalid('Unknown tool.')
  if (kind === 'skill') {
    if (slot.type !== 'default') throw invalid('Skills go to the default folder of each tool.')
    if (!validVariantName('skill', name)) throw invalid('Not a valid skill folder name.')
    return `${SKILL_DIR[tool]}/${name}`
  }
  if (kind !== 'rule') throw invalid('Unknown kind.')
  const own = (t: GlobalTool, path: string): string => {
    if (tool !== t) throw invalid('This slot belongs to another tool.')
    return path
  }
  switch (slot.type) {
    case 'default':
      return tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
    case 'claudeNested':
      return own('claude', '.claude/CLAUDE.md')
    case 'claudeLocal':
      return own('claude', 'CLAUDE.local.md')
    case 'claudeNamedRule':
      if (!validVariantName('rule', slot.name))
        throw invalid('A named Claude rule is a relative Markdown path of valid Windows names.')
      return own('claude', `.claude/rules/illithid/${slot.name}`)
    case 'codexOverride':
      return own('codex', 'AGENTS.override.md')
    case 'opencodeClaude':
      return own('opencode', 'CLAUDE.md')
    default:
      throw invalid('Unknown slot.')
  }
}

/** Absolute destination of a variant in a project for a tool and slot */
export function resolveProjectDestination(
  project: CandidateBinding,
  kind: GlobalKind,
  name: string,
  tool: GlobalTool,
  slot: ProjectSlot
): string {
  return join(project.path, ...projectSlotPath(kind, name, tool, slot).split('/'))
}

/** Supported instruction files of a project, with the documented local precedence or overlap shown beside them */
const RULE_SLOTS: [string, string][] = [
  ['AGENTS.md', 'Read by Codex and OpenCode: one shared file.'],
  ['AGENTS.override.md', 'Codex reads it instead of AGENTS.md in the same folder (override).'],
  ['CLAUDE.md', 'Read by Claude Code; OpenCode uses it only when there is no AGENTS.md.'],
  ['CLAUDE.local.md', 'Claude Code personal project instructions, usually not committed.'],
  ['.claude/CLAUDE.md', 'Claude Code alternative location of the project instructions.']
]
const skillSlots = (name: string): [string, string][] => [
  [`.claude/skills/${name}`, 'Claude Code; OpenCode also reads this folder.'],
  [`.agents/skills/${name}`, 'Codex; OpenCode also reads this folder.'],
  [`.opencode/skills/${name}`, 'OpenCode.']
]

async function localSlots(
  reader: CensusReader,
  project: string,
  kind: GlobalKind,
  name: string
): Promise<LocalSlot[]> {
  const out: LocalSlot[] = []
  for (const [path, note] of kind === 'rule' ? RULE_SLOTS : skillSlots(name)) {
    try {
      const st = await reader.locate(project, path)
      out.push({ path, present: st !== null, linked: false, note })
    } catch (e) {
      const linked = e instanceof Incomplete && e.outcome === 'linked'
      if (!linked && !(e instanceof Incomplete) && !(e as NodeJS.ErrnoException)?.code) throw e
      out.push({ path, present: linked, linked, note })
    }
  }
  return out
}

const refuse = (reason: string, rel: string): ProjectError =>
  new ProjectError('refused', `${rel}: ${reason}`, reason, rel)

const entryPrint = (kind: 'dir' | 'file', st: BigIntStats): string =>
  `${kind}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`

/** Project-relative parts of a destination strictly inside the project folder (exact spelling) */
function partsInside(project: string, destination: string): string[] {
  const p = resolve(project)
  const d = resolve(destination)
  const r = relative(p, d)
  if (
    !r ||
    r === '..' ||
    r.startsWith('..' + sep) ||
    isAbsolute(r) ||
    !d.startsWith(p.endsWith(sep) ? p : p + sep)
  )
    throw invalid('The destination is not inside the project.')
  return d.slice(p.length + (p.endsWith(sep) ? 0 : 1)).split(sep)
}

/**
 * The destination as it is now. Refused (ProjectError 'refused' with a reason) when it, or a folder on the way, is a
 * link or junction, a folder on the way is a file, the entry is of the wrong kind, its name exists only in another
 * case, it has several hard links, or its content cannot be read completely; projectChanged when the project folder
 * no longer matches its binding.
 */
export async function inspectProjectDestination(
  ctx: ProjectContext,
  project: CandidateBinding,
  destination: string,
  kind: GlobalKind
): Promise<ProjectDestinationObservation> {
  ctx.signal.throwIfAborted()
  const parts = partsInside(project.path, destination)
  const reader = createReader(ctx.signal, CENSUS_LIMITS)
  try {
    await recheckBinding(project)
    const own = project.chain[project.chain.length - 1]
    let ancestor: PathIdentity = { path: own.path, fingerprint: own.fingerprint }
    const identities: PathIdentity[] = []
    let parent = project.path
    const base = {
      destination,
      project,
      kind,
      digestAlgorithm: kind === 'rule' ? ('sha256-v1' as const) : ('fullTree-v1' as const),
      localSlots: await localSlots(reader, project.path, kind, parts[parts.length - 1])
    }
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const last = i === parts.length - 1
      const rel = parts.slice(0, i + 1).join('/')
      const names = await reader.fs.readdir(parent)
      if (!names.includes(name)) {
        if (names.some((n) => n.toLowerCase() === name.toLowerCase()))
          throw refuse('ambiguousCase', rel)
        const remaining = parts.slice(i)
        return {
          ...base,
          shape: 'absent',
          digest: null,
          identities,
          physicalKey: `under:${ancestor.fingerprint}:${remaining.join('/')}`,
          existingAncestor: ancestor,
          remaining
        }
      }
      const path = join(parent, name)
      const st = await reader.fs.lstat(path)
      if (st.isSymbolicLink()) throw refuse(last ? 'linkedDestination' : 'linkedAncestor', rel)
      if (!last) {
        if (!st.isDirectory()) throw refuse('invalidContainer', rel)
        ancestor = { path, fingerprint: identityOf(st) }
        identities.push(ancestor)
        parent = path
        continue
      }
      const existing = {
        ...base,
        physicalKey: `id:${st.dev}:${st.ino}`,
        existingAncestor: ancestor,
        remaining: []
      }
      if (kind === 'rule') {
        if (!st.isFile()) throw refuse('notAFile', rel)
        if (st.nlink > 1n) throw refuse('hardLinked', rel)
        const { digest } = await reader.hashFile(path, st)
        return {
          ...existing,
          shape: 'file',
          digest,
          identities: [...identities, { path, fingerprint: entryPrint('file', st) }]
        }
      }
      if (!st.isDirectory()) throw refuse('notAFolder', rel)
      const tree = createHash('sha256')
      const seen = await observeSkillTree(reader, CENSUS_LIMITS, parent, name, {
        dir: (p) => tree.update(`D\0${p}\0`),
        file: (p) => tree.update(`F\0${p}\0`),
        chunk: (c) => tree.update(c),
        fileEnd: () => tree.update('\0')
      })
      return {
        ...existing,
        shape: 'dir',
        digest: tree.digest('hex'),
        manifest: seen.manifest,
        identities: [
          ...identities,
          ...seen.listed.map((e) => ({
            path: e.path ? join(path, ...e.path.split('/')) : path,
            fingerprint: entryPrint(e.kind, e.st)
          }))
        ]
      }
    }
    throw invalid('Empty destination.')
  } catch (e) {
    const x = asProjectError(e)
    // Census-style incompleteness of the destination is a refusal of that destination
    if (x instanceof ProjectError && x.code === 'incomplete')
      throw new ProjectError('refused', x.message, x.reason, x.problemPath)
    throw x
  }
}
