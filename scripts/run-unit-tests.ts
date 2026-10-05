/**
 * Portable unit test runner (replaces `tsx --test $(ls scripts/*.test.ts | grep -v ...)`, which needs a Unix shell:
 * under cmd.exe the substitution stays literal, node globs every test file including the UI ones, and the exit code
 * is grep's). Discovers scripts/*.test.ts without a shell, leaves out *.ui.test.ts, runs them with node --test through
 * the tsx loader and exits with node's status.
 *
 * On win32 the test files of features deferred by the Windows first release (hooks, permissions, hook scripts,
 * marketplace hooks) are left out and listed: they drive bash scripts and Unix modes that the release keeps off.
 * `--all` runs them anyway.
 *
 * Usage: tsx scripts/run-unit-tests.ts [--all] [file ...]   (no files = every unit test file)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Deferred-feature test files skipped on win32 (spec 2026-10-04 §2: hooks, permissions, marketplace stay off) */
export const WINDOWS_DEFERRED_TEST_FILES: readonly string[] = [
  'hooks-actions.test.ts',
  'hooks-import.test.ts',
  'hooks-library.test.ts',
  'hooks-sync.test.ts',
  'hooks-view.test.ts',
  'market-hooks.test.ts',
  'permissions-sync.test.ts',
  'scripts-library.test.ts'
]

export function unitTestFiles(dir = 'scripts', skip: readonly string[] = []): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.ui.test.ts') && !skip.includes(f))
    .sort()
    .map((f) => join(dir, f))
}

const argv = process.argv.slice(2)
const all = argv.includes('--all')
const named = argv.filter((a) => a !== '--all')
const skip = !all && process.platform === 'win32' ? WINDOWS_DEFERRED_TEST_FILES : []
const files = named.length ? named : unitTestFiles('scripts', skip)
if (!files.length) {
  console.error('no unit test files found')
  process.exit(1)
}
if (!named.length && skip.length)
  console.log(`# skipped on win32 (deferred features, --all to run): ${skip.join(', ')}`)
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit'
})
if (r.error) {
  console.error(r.error.message)
  process.exit(1)
}
process.exit(r.status ?? 1)
