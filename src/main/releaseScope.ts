/**
 * Scope of the Windows first release (spec 2026-10-04): global rules and skills for Claude Code, Codex and OpenCode only,
 * applied by hand after a preview. Deferred features (MCP, secrets, hooks, permissions, memory, sessions, stats,
 * marketplace, git backup, subagents) and every automatic write (sync on start, library watch, backup cleanup by age)
 * stay off on win32. Other platforms keep the upstream behavior. No Electron import, so fixtures can load it.
 */
import { CHANNELS, GLOBAL_CHANNELS, type Channel } from '../shared/api'

/** Startup work of src/main/index.ts, in upstream order */
export type StartupTask =
  | 'prepareLibrary'
  | 'tray'
  | 'updateCheck'
  | 'syncOnStart'
  | 'backupCleanup'
  | 'libraryWatch'
  | 'pullOnStart'
  | 'searchIndex'
  | 'snapshotOnQuit'

const UPSTREAM_STARTUP: readonly StartupTask[] = [
  'prepareLibrary',
  'tray',
  'updateCheck',
  'syncOnStart',
  'backupCleanup',
  'libraryWatch',
  'pullOnStart',
  'searchIndex',
  'snapshotOnQuit'
]

/** Whether this platform runs the Windows first-release scope */
export function isWindowsRelease(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/** Startup tasks the platform runs (index.ts keeps its own extra conditions, e.g. test mode or the macOS menu bar) */
export function startupTasks(platform: NodeJS.Platform = process.platform): StartupTask[] {
  return isWindowsRelease(platform) ? [] : [...UPSTREAM_STARTUP]
}

/** IPC channels the Windows release exposes. Everything else is refused before its handler runs */
const WINDOWS_CHANNELS: readonly Channel[] = [
  'appVersion',
  'uiPrefsSet',
  'pickDirectory',
  ...GLOBAL_CHANNELS
]

export function releaseChannels(platform: NodeJS.Platform = process.platform): Channel[] {
  return isWindowsRelease(platform) ? [...WINDOWS_CHANNELS] : [...CHANNELS]
}

export interface NotInRelease {
  ok: false
  code: 'notInRelease'
  message: string
}

/** Handlers with the channels outside the release replaced by a refusal (their upstream handler is never called) */
export function releaseHandlers<
  H extends Record<Channel, (...args: unknown[]) => Promise<unknown>>
>(platform: NodeJS.Platform, handlers: H): H {
  if (!isWindowsRelease(platform)) return handlers
  const exposed = new Set<Channel>(releaseChannels(platform))
  const out = { ...handlers }
  for (const c of CHANNELS) {
    if (exposed.has(c)) continue
    out[c] = (async (): Promise<NotInRelease> => ({
      ok: false,
      code: 'notInRelease',
      message: `${c} is not available in the Windows release`
    })) as H[Channel]
  }
  return out
}
