/**
 * Global configuration roots of the three tools of the Windows first release (spec 2026-10-04 §8).
 * Defaults follow upstream agents.ts/importer.ts at v0.3.1 (b2ff4f5): `~/.claude`, `~/.codex`, `~/.config/opencode`.
 * An environment override that points elsewhere, or a linked default root, makes the root ambiguous: the app never
 * guesses an alternative profile — the user confirms a path (override) or the tool stays unavailable.
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appConfigDir, appDataRoot } from './config'
import type { Env } from './types'
import { atomicWrite } from './write'

export type GlobalTool = 'claude' | 'codex' | 'opencode'
export const GLOBAL_TOOLS: readonly GlobalTool[] = ['claude', 'codex', 'opencode']

export interface GlobalPathResult {
  tool: GlobalTool
  /** resolved: the one root; ambiguous: the candidates to choose from; unavailable: empty */
  paths: string[]
  status: 'resolved' | 'ambiguous' | 'unavailable'
  reason?: string
}

/** Global rules and skills of each tool, relative to its root */
export interface NativeLayout {
  /** Whole-file instructions the tool reads globally */
  ruleFiles: string[]
  /** Folders whose `*.md` files (recursive) are global rules */
  ruleDirs: string[]
  /** Folders whose subfolders holding SKILL.md are skills */
  skillDirs: string[]
}

export const NATIVE_LAYOUT: Record<GlobalTool, NativeLayout> = {
  claude: { ruleFiles: ['CLAUDE.md'], ruleDirs: ['rules'], skillDirs: ['skills'] },
  codex: { ruleFiles: ['AGENTS.md', 'AGENTS.override.md'], ruleDirs: [], skillDirs: ['skills'] },
  opencode: { ruleFiles: ['AGENTS.md'], ruleDirs: [], skillDirs: ['skills', 'skill'] }
}

const DEFAULT_ROOT: Record<GlobalTool, string> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.config/opencode'
}

/** Library of global variants (originals managed by the app): `<home>/.illithid/global/variants` */
export function globalLibraryDir(home: string): string {
  return join(appDataRoot(home), 'global', 'variants')
}

/** App state of the global flow (deliveries, plans, operations, backups): `<home>/.config/illithid/global` */
export function globalStateDir(home: string): string {
  return join(appConfigDir(home), 'global')
}

function expand(home: string, v: string): string {
  return v === '~'
    ? home
    : v.startsWith('~/') || v.startsWith('~\\')
      ? join(home, v.slice(2))
      : resolve(home, v)
}

/** Roots an environment variable makes the tool read instead of (or besides) the default */
function envRoots(tool: GlobalTool, home: string, env: Env): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []
  const add = (name: string, sub?: string): void => {
    const v = env[name]?.trim()
    if (v) out.push({ name, path: sub ? join(expand(home, v), sub) : expand(home, v) })
  }
  if (tool === 'claude') add('CLAUDE_CONFIG_DIR')
  if (tool === 'codex') add('CODEX_HOME')
  if (tool === 'opencode') {
    add('XDG_CONFIG_HOME', 'opencode')
    add('OPENCODE_CONFIG_DIR')
  }
  return out
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function resolveOne(
  tool: GlobalTool,
  home: string,
  override: string | undefined,
  env: Env
): GlobalPathResult {
  const def = join(home, DEFAULT_ROOT[tool])
  if (override !== undefined) {
    const abs = resolve(override)
    return isDir(abs)
      ? { tool, paths: [abs], status: 'resolved' }
      : { tool, paths: [], status: 'unavailable', reason: 'overrideMissing' }
  }
  const elsewhere = envRoots(tool, home, env).filter((e) => resolve(e.path) !== resolve(def))
  if (elsewhere.length) {
    const candidates = [...new Set([def, ...elsewhere.map((e) => resolve(e.path))])].filter(isDir)
    return candidates.length
      ? {
          tool,
          paths: candidates,
          status: 'ambiguous',
          reason: `envOverride:${elsewhere.map((e) => e.name).join(',')}`
        }
      : { tool, paths: [], status: 'unavailable', reason: 'notFound' }
  }
  if (isLink(def)) return { tool, paths: [def], status: 'ambiguous', reason: 'linkedRoot' }
  return isDir(def)
    ? { tool, paths: [def], status: 'resolved' }
    : { tool, paths: [], status: 'unavailable', reason: 'notFound' }
}

/**
 * Global root of each tool. overrides = paths the user confirmed (they win over detection); env = the environment the
 * tools are expected to run with.
 */
export function resolveGlobalPaths(
  home: string,
  overrides: Partial<Record<GlobalTool, string>> = {},
  env: Env = process.env
): GlobalPathResult[] {
  return GLOBAL_TOOLS.map((t) => resolveOne(t, home, overrides[t], env))
}

export interface GlobalPathView {
  tool: GlobalTool
  /** What detection finds (with no confirmation) */
  detected: GlobalPathResult
  /** The root the user confirmed, if any */
  confirmed: string | null
}

const confirmedFile = (home: string): string => join(globalStateDir(home), 'paths.json')

function readConfirmed(home: string): Partial<Record<GlobalTool, string>> {
  const p = confirmedFile(home)
  if (!existsSync(p)) return {}
  const o = JSON.parse(readFileSync(p, 'utf8')) as {
    version?: number
    confirmed?: Record<string, unknown>
  }
  const out: Partial<Record<GlobalTool, string>> = {}
  if (o.version === 1 && o.confirmed)
    for (const t of GLOBAL_TOOLS)
      if (typeof o.confirmed[t] === 'string') out[t] = o.confirmed[t] as string
  return out
}

/** Detection and confirmation of each tool root, for the paths screen */
export function globalPathsView(home: string, env: Env = process.env): GlobalPathView[] {
  const conf = readConfirmed(home)
  return GLOBAL_TOOLS.map((tool) => ({
    tool,
    detected: resolveOne(tool, home, undefined, env),
    confirmed: conf[tool] ?? null
  }))
}

/** Records the user's confirmation of a tool root (an existing folder), or withdraws it (null) */
export function confirmGlobalPath(
  home: string,
  tool: GlobalTool,
  path: string | null
): { ok: true } | { ok: false; code: 'notADirectory' | 'unknownTool' } {
  if (!GLOBAL_TOOLS.includes(tool)) return { ok: false, code: 'unknownTool' }
  const conf = readConfirmed(home)
  if (path === null) delete conf[tool]
  else {
    if (!isDir(resolve(path))) return { ok: false, code: 'notADirectory' }
    conf[tool] = resolve(path)
  }
  atomicWrite(confirmedFile(home), JSON.stringify({ version: 1, confirmed: conf }, null, 2) + '\n')
  return { ok: true }
}

/**
 * Roots the import, plan, removal and restore steps may use: only confirmed ones (spec §3). A detected but unconfirmed
 * root is unavailable with reason notConfirmed; a confirmed folder that no longer exists, overrideMissing.
 */
export function effectiveGlobalPaths(home: string, env: Env = process.env): GlobalPathResult[] {
  const conf = readConfirmed(home)
  return GLOBAL_TOOLS.map((tool) => {
    const c = conf[tool]
    if (c) return resolveOne(tool, home, c, env)
    const d = resolveOne(tool, home, undefined, env)
    return d.status === 'unavailable'
      ? d
      : { tool, paths: [], status: 'unavailable', reason: 'notConfirmed' }
  })
}
