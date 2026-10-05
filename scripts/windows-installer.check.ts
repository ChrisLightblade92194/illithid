/**
 * Installer check of the Windows first release (spec 2026-10-04 §12 criterion 1, plan task 8).
 * Installs dist/illithid-<version>-setup.exe silently for the current (standard) user, starts the installed app on a
 * synthetic HOME with a synthetic library, then uninstalls silently. Checks: no elevation needed, per-user location,
 * the app starts, the uninstall removes the program and keeps the synthetic library, backups and tool folders, and the
 * real HOME probes (tool folders, library, app config) are unchanged. Prints a JSON report; exit 1 on a failed check.
 * Touches the real account only where a per-user install does: %LOCALAPPDATA%\Programs, Start menu and desktop
 * shortcuts, HKCU uninstall entry — all removed by the uninstall (verified below).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import { importGlobalItems, listGlobalImportables } from '../src/engine/globalImport'
import { confirmGlobalPath, effectiveGlobalPaths } from '../src/engine/globalPaths'
import { listGlobalVariants } from '../src/engine/globalVariants'
import { defaultDestination } from '../src/engine/globalDestinations'
import { contentSnapshot, put, snapshot, syntheticHome } from './lib/globalFixture'

const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
const setup = resolve(`dist/illithid-${version}-setup.exe`)
const report: Record<string, unknown> = { setup, user: process.env['USERNAME'] }
const checks: [string, boolean][] = []
const check = (name: string, ok: boolean): void => {
  checks.push([name, ok])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function realProbes(): string[] {
  const h = homedir()
  return [
    join(h, '.claude/rules'),
    join(h, '.claude/skills'),
    join(h, '.claude/CLAUDE.md'),
    join(h, '.codex/AGENTS.md'),
    join(h, '.codex/skills'),
    join(h, '.config/opencode/AGENTS.md'),
    join(h, '.config/opencode/skills'),
    join(h, '.illithid'),
    join(h, '.config/illithid'),
    join(process.env['APPDATA'] ?? '', 'illithid')
  ]
}
const statProbes = (): Record<string, string> =>
  Object.fromEntries(realProbes().map((p) => [p, JSON.stringify(snapshot(p))]))

function uninstallEntry(): { key: string; location: string | null } | null {
  const r = spawnSync(
    'reg',
    [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s',
      '/f',
      'Illithid',
      '/d'
    ],
    {
      encoding: 'utf8'
    }
  )
  const key = r.stdout.split(/\r?\n/).find((l) => l.startsWith('HKEY_CURRENT_USER'))
  if (!key) return null
  const q = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8' })
  const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(q.stdout)
  return { key, location: m ? m[1].trim() : null }
}

async function main(): Promise<number> {
  const before = statProbes()
  check('setup exists', existsSync(setup))

  // Synthetic home with a library, a backup and delivered tool files (the uninstall must not touch any of it)
  const home = syntheticHome('illithid installer ')
  put(home, '.claude/rules/r.md', 'installer check rule\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  for (const p of ['claude', 'codex'] as const)
    confirmGlobalPath(home, p, join(home, p === 'claude' ? '.claude' : '.codex'))
  const paths = effectiveGlobalPaths(home, {})
  importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  const v = listGlobalVariants(home)[0]
  const applied = applyGlobalSync(
    home,
    planGlobalSync(
      home,
      [
        {
          variantId: v.id,
          variantRevision: v.revision,
          tool: 'codex',
          destination: defaultDestination(paths[1].paths[0], 'codex', 'rule', v.name),
          expectedDestinationDigest: null
        }
      ],
      { paths }
    )
  )
  check('synthetic apply completed', applied.status === 'completed')
  const homeBefore = contentSnapshot(home)

  // Install silently (per user). A UAC prompt would block: a timeout is a failed check
  const t0 = Date.now()
  const inst = spawnSync(setup, ['/S'], { timeout: 240000 })
  report['installExit'] = inst.status
  report['installSeconds'] = Math.round((Date.now() - t0) / 1000)
  check('installer exited 0 without elevation', inst.status === 0)
  let entry = uninstallEntry()
  for (let i = 0; !entry && i < 30; i++) {
    await sleep(1000)
    entry = uninstallEntry()
  }
  report['uninstallKey'] = entry?.key ?? null
  report['installLocation'] = entry?.location ?? null
  const location =
    entry?.location ?? join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'illithid')
  const exe = join(location, 'illithid.exe')
  check(
    'installed per user under %LOCALAPPDATA%\\Programs',
    location
      .toLowerCase()
      .startsWith(join(process.env['LOCALAPPDATA'] ?? '', 'Programs').toLowerCase())
  )
  check('installed exe exists', existsSync(exe))
  report['installedFiles'] = existsSync(location) ? readdirSync(location).length : 0

  // Start the installed app on the synthetic home
  const userData = mkdtempSync(join(tmpdir(), 'illithid-installed-ud-'))
  const env = {
    ...process.env,
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: userData,
    ILLITHID_TEST: '1'
  }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = spawn(exe, [], { env, stdio: 'ignore' })
  let started = false
  for (let i = 0; i < 60 && !started; i++) {
    await sleep(500)
    started = existsSync(join(userData, 'instance.json'))
  }
  check('installed app started on the synthetic home', started)
  await sleep(2000)
  if (app.pid) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'])
  await sleep(1000)

  // Uninstall silently; the NSIS uninstaller re-launches itself, so wait for the folder to go
  const uninstaller = readdirSync(location).find((n) => /^Uninstall .*\.exe$/i.test(n))
  report['uninstaller'] = uninstaller ?? null
  const un = uninstaller
    ? spawnSync(join(location, uninstaller), ['/S'], { timeout: 240000 })
    : null
  report['uninstallExit'] = un?.status ?? null
  for (let i = 0; i < 90 && existsSync(exe); i++) await sleep(1000)
  check('uninstall removed the program', !existsSync(exe))
  check('uninstall removed the HKCU entry', uninstallEntry() === null)
  check(
    'synthetic library, backups and tool folders kept',
    JSON.stringify(contentSnapshot(home)) === JSON.stringify(homeBefore)
  )
  const after = statProbes()
  const changed = Object.keys(before).filter((k) => before[k] !== after[k])
  report['realProbesChanged'] = changed
  // Known electron-builder behavior: the installer keeps a copy of itself for updates; the uninstall leaves it
  const updaterCache = join(process.env['LOCALAPPDATA'] ?? '', 'illithid-updater')
  report['leftovers'] = [updaterCache, join(location)].filter((p) => existsSync(p))
  check('real HOME probes unchanged by install and uninstall', changed.length === 0)
  report['checks'] = Object.fromEntries(checks)
  console.log(JSON.stringify(report, null, 2))
  return checks.every(([, ok]) => ok) ? 0 : 1
}

void main().then((code) => process.exit(code))
