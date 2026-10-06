/**
 * Windows first-release isolation fixture (spec 2026-10-04 §2, §9, §12 criteria 1, 12, 13).
 * - The Windows build starts no deferred or writing task (sync on start, library watch, backup cleanup by age, git pull,
 *   session index, update check, quit snapshot).
 * - Deferred IPC channels are refused before reaching their handler; no exposed channel reaches the secret store.
 * - The built app (out/main/index.js, run `npm run build` first) launched on a synthetic HOME writes nothing to the real
 *   HOME probes and nothing to the synthetic tool folders, even with a library and allowRealApply that upstream would sync.
 * Only synthetic profiles are written. Real HOME probes are read with stat only (no content read).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import electronPath from 'electron'
import { CENSUS_CHANNELS, CHANNELS, GLOBAL_CHANNELS, type Channel } from '../src/shared/api'
import { releaseChannels, releaseHandlers, startupTasks } from '../src/main/releaseScope'
import { baseEnv, buildDemoHome } from './readme-shots'

/** Startup tasks of upstream src/main/index.ts that write or belong to deferred features */
const WRITING_OR_DEFERRED_STARTUP = [
  'prepareLibrary',
  'syncOnStart',
  'backupCleanup',
  'libraryWatch',
  'pullOnStart',
  'searchIndex',
  'updateCheck',
  'snapshotOnQuit',
  'tray'
] as const

/** Channels whose upstream handler reaches the secret store (directly or through status/sync/import/market/workspace) */
const SECRET_PATH_CHANNELS: Channel[] = [
  'status',
  'mcp',
  'mcpRead',
  'mcpSave',
  'mcpDelete',
  'mcpToolInfo',
  'mcpFetchTools',
  'mcpPermissionsSave',
  'syncStatus',
  'syncNow',
  'syncPending',
  'syncPreview',
  'syncApplyOnce',
  'importPlan',
  'importApply',
  'marketInstall',
  'marketInstallMany',
  'marketUpdate',
  'workspaceSwitch',
  'workspaceImport'
]

/** Deferred features (spec §2): hooks, permissions, memory, sessions, stats, marketplace, git backup, subagents, auto sync */
const DEFERRED_CHANNELS: Channel[] = [
  'hooks',
  'hookSave',
  'permissions',
  'permissionsSave',
  'memoryFiles',
  'toolMemoryScan',
  'sessions',
  'sessionSearch',
  'usage',
  'models',
  'marketSearch',
  'backupConnect',
  'backupSnapshot',
  'backupRestore',
  'backupCleanupRun',
  'agents',
  'agentCreate',
  'toggle',
  'ruleSave',
  'skillCreate',
  'syncNow'
]

test('the Windows build starts no writing or deferred task; other platforms keep upstream startup', () => {
  assert.deepEqual(startupTasks('win32'), [])
  const mac = startupTasks('darwin')
  for (const t of ['prepareLibrary', 'syncOnStart', 'libraryWatch', 'updateCheck'] as const)
    assert.ok(mac.includes(t), `darwin keeps ${t}`)
  for (const t of WRITING_OR_DEFERRED_STARTUP)
    assert.ok(!startupTasks('win32').includes(t), `win32 must not run ${t}`)
})

test('no channel exposed by the Windows release reaches the secret store or a deferred feature', () => {
  const exposed = new Set(releaseChannels('win32'))
  for (const c of [...SECRET_PATH_CHANNELS, ...DEFERRED_CHANNELS])
    assert.ok(!exposed.has(c), `${c} must not be exposed on win32`)
  assert.equal(releaseChannels('darwin').length, CHANNELS.length)
})

test('deferred channels are refused on win32 before their handler runs; darwin calls through', async () => {
  const called: string[] = []
  const handlers = Object.fromEntries(
    CHANNELS.map((c) => [
      c,
      async (): Promise<unknown> => {
        called.push(c)
        return { ok: true, value: c }
      }
    ])
  ) as Record<Channel, (...args: unknown[]) => Promise<unknown>>
  const win = releaseHandlers('win32', handlers)
  const exposed = new Set(releaseChannels('win32'))
  for (const c of CHANNELS) {
    if (exposed.has(c)) continue
    const r = (await win[c]()) as { ok: boolean; code?: string }
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'notInRelease' }, c)
  }
  assert.deepEqual(called, [])
  const mac = releaseHandlers('darwin', handlers)
  assert.deepEqual(await mac.mcpFetchTools(), { ok: true, value: 'mcpFetchTools' })
  assert.deepEqual(called, ['mcpFetchTools'])
})

test('the Windows allowlist is the app, global and project census channels exactly; census handlers run there', async () => {
  assert.deepEqual(releaseChannels('win32'), [
    'appVersion',
    'uiPrefsSet',
    'pickDirectory',
    ...GLOBAL_CHANNELS,
    ...CENSUS_CHANNELS
  ])
  const called: string[] = []
  const handlers = Object.fromEntries(
    CHANNELS.map((c) => [
      c,
      async (): Promise<unknown> => {
        called.push(c)
        return { ok: true, value: c }
      }
    ])
  ) as Record<Channel, (...args: unknown[]) => Promise<unknown>>
  const win = releaseHandlers('win32', handlers)
  for (const c of CENSUS_CHANNELS) assert.deepEqual(await win[c](), { ok: true, value: c }, c)
  assert.deepEqual(called, [...CENSUS_CHANNELS])
})

/** stat-only signature of a path tree (size, mtime, link target); depth-limited for large folders */
function statTree(root: string, depth = 3): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string, rel: string, d: number): void => {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) out[rel] = `L:${readlinkSync(p)}`
    else if (st.isDirectory()) {
      out[rel] = `D:${st.mtimeMs}`
      if (d > 0) for (const n of readdirSync(p)) walk(join(p, n), `${rel}/${n}`, d - 1)
    } else out[rel] = `F:${st.size}:${st.mtimeMs}`
  }
  walk(root, '.', depth)
  return out
}

/** Content signature of a synthetic tree (bytes hashed) */
function contentTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (!st) return
    if (st.isSymbolicLink()) out[rel] = `L:${readlinkSync(p)}`
    else if (st.isDirectory()) {
      out[rel] = 'D'
      for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`)
    } else out[rel] = 'F:' + createHash('sha256').update(readFileSync(p)).digest('hex')
  }
  walk(root, '.')
  return out
}

function realHomeProbes(): string[] {
  const h = homedir()
  const appData = process.env['APPDATA'] ?? join(h, 'AppData/Roaming')
  return [
    join(h, '.claude/rules'),
    join(h, '.claude/skills'),
    join(h, '.claude/CLAUDE.md'),
    join(h, '.codex/AGENTS.md'),
    join(h, '.codex/skills'),
    join(h, '.config/opencode/AGENTS.md'),
    join(h, '.config/opencode/opencode.json'),
    join(h, '.config/opencode/skills'),
    join(h, '.illithid'),
    join(h, '.config/illithid'),
    join(appData, 'illithid')
  ]
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
  else process.kill(pid, 'SIGKILL')
}

test('the built app on a synthetic HOME writes nothing to the real HOME or the synthetic tool folders', async () => {
  const main = resolve('out/main/index.js')
  assert.ok(existsSync(main), 'out/main/index.js missing: run `npm run build` first')
  const root = mkdtempSync(join(tmpdir(), 'illithid wïn fixture '))
  const home = join(root, 'home ç')
  const userData = join(root, 'user data')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  // Upstream-ready library with allowRealApply, so an automatic sync on start would write the tools
  buildDemoHome(home, { tools: 'all' })
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), text)
  }
  put('.claude/rules/mine.md', '# mine\n')
  put('.claude/skills/own-skill/SKILL.md', '---\nname: own-skill\ndescription: d\n---\nbody\n')
  put('.codex/AGENTS.md', 'codex user text\n')
  const toolDirs = ['.claude', '.codex', '.config/opencode', '.gemini', '.copilot', '.grok']
  const toolsBefore = Object.fromEntries(toolDirs.map((d) => [d, contentTree(join(home, d))]))
  const probesBefore = Object.fromEntries(realHomeProbes().map((p) => [p, statTree(p)]))

  const env: Record<string, string> = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: userData,
    ILLITHID_TEST: '1'
  }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']
  const child = spawn(electronPath as unknown as string, [main], { env, stdio: 'ignore' })
  try {
    const started = Date.now()
    while (!existsSync(join(userData, 'instance.json')) && Date.now() - started < 30000)
      await new Promise((r) => setTimeout(r, 250))
    assert.ok(existsSync(join(userData, 'instance.json')), 'app did not start within 30s')
    // Upstream runs the start sync 500 ms after ready, then the watch and backups; leave time for all of them
    await new Promise((r) => setTimeout(r, 6000))
  } finally {
    if (child.pid) killTree(child.pid)
  }

  const realHomeWrites = realHomeProbes().filter(
    (p) => JSON.stringify(statTree(p)) !== JSON.stringify(probesBefore[p])
  )
  assert.equal(realHomeWrites.length, 0, `real HOME changed: ${realHomeWrites.join(', ')}`)
  for (const d of toolDirs)
    assert.deepEqual(
      contentTree(join(home, d)),
      toolsBefore[d],
      `synthetic ${d} changed at startup`
    )
})
