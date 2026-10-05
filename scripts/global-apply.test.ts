/**
 * Task 5 — apply, rechecks, backups and partial results (spec 2026-10-04 §9, §10; §12 criteria 5, 6, 7, 8, 10).
 * Synthetic profiles only. Lock and crash cases run the apply in a separate process (scripts/lib/applyChild.ts).
 * Residual race (declared, not tested away): an external writer between the last recheck and the rename can still be
 * overwritten; every divergence observed before it is refused.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { globalStateDir, resolveGlobalPaths, type GlobalTool } from '../src/engine/globalPaths'
import {
  listGlobalVariants,
  readDeliveries,
  type DeliveryChoice
} from '../src/engine/globalVariants'
import { defaultDestination, readDestination } from '../src/engine/globalDestinations'
import {
  applyGlobalSync,
  planGlobalSync,
  type GlobalSyncPlan
} from '../src/engine/globalManualSync'
import { acquireApplyLock, listGlobalOperations } from '../src/engine/globalOperations'
import { denyWrite, put, seedVariants, snapshot, syntheticHome } from './lib/globalFixture'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))

function toolHome(home: string): Record<GlobalTool, string> {
  for (const d of TOOL_DIRS) mkdirSync(join(home, d), { recursive: true })
  return Object.fromEntries(
    resolveGlobalPaths(home, {}, {}).map((p) => [p.tool, p.paths[0]])
  ) as Record<GlobalTool, string>
}
function pick(home: string, name: string): { id: string; revision: string; contentPath: string } {
  const v = listGlobalVariants(home).find((x) => x.name === name)
  assert.ok(v, name)
  return v
}
const ch = (
  v: { id: string; revision: string },
  tool: GlobalTool,
  destination: string,
  expected: string | null = null
): DeliveryChoice => ({
  variantId: v.id,
  variantRevision: v.revision,
  tool,
  destination,
  expectedDestinationDigest: expected
})
const plan = (home: string, choices: DeliveryChoice[]): GlobalSyncPlan =>
  planGlobalSync(home, choices, { paths: resolveGlobalPaths(home, {}, {}) })
const statuses = (r: ReturnType<typeof applyGlobalSync>): string[] => r.results.map((x) => x.status)

test('apply writes the native forms and records deliveries; a second sync rewrites nothing', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, {
    'rules/r.md': 'Rule R\r\n',
    'skills/kit/SKILL.md': '---\nname: kit\n---\n',
    'skills/kit/bin/x.dat': Buffer.from([0, 255, 13, 10])
  })
  put(home, '.codex/AGENTS.md', 'user text\n')
  const rule = pick(home, 'r.md')
  const kit = pick(home, 'kit')
  const choices = [
    ch(rule, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'r.md')),
    ch(rule, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'r.md')),
    ch(kit, 'codex', defaultDestination(r.codex, 'codex', 'skill', 'kit'))
  ]
  const res = applyGlobalSync(home, plan(home, choices))
  assert.equal(res.status, 'completed')
  assert.deepEqual(statuses(res), ['done', 'done', 'done'])
  assert.deepEqual(readFileSync(join(r.claude, 'rules/illithid/r.md')), Buffer.from('Rule R\r\n'))
  assert.equal(
    readFileSync(join(r.codex, 'AGENTS.md'), 'utf8'),
    'user text\n\n<!-- BEGIN illithid-global: r.md -->\nRule R\r\n<!-- END illithid-global: r.md -->\n'
  )
  assert.deepEqual(
    readFileSync(join(r.codex, 'skills/kit/bin/x.dat')),
    Buffer.from([0, 255, 13, 10])
  )
  assert.equal(readDeliveries(home).length, 3)
  const before = snapTools(home)
  const second = plan(home, choices)
  assert.deepEqual(
    second.changes.map((c) => c.op),
    ['unchanged', 'unchanged', 'unchanged']
  )
  const again = applyGlobalSync(home, second)
  assert.equal(again.status, 'completed')
  assert.deepEqual(statuses(again), ['unchanged', 'unchanged', 'unchanged'])
  assert.deepEqual(snapTools(home), before)
})

test('changed_source_refuses_apply: a library edit after the preview refuses that change, zero writes', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'A\n' })
  const a = pick(home, 'a.md')
  const p = plan(home, [ch(a, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'a.md'))])
  writeFileSync(a.contentPath, 'A edited\n')
  const before = snapTools(home)
  const res = applyGlobalSync(home, p)
  assert.equal(res.status, 'refused')
  assert.deepEqual(
    res.results.map((x) => [x.status, x.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.deepEqual(snapTools(home), before)
  assert.deepEqual(readDeliveries(home), [])
})

test('changed_destination_refuses_apply: only the changed destination is refused; independent ones apply', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'A\n', 'rules/b.md': 'B\n' })
  const a = pick(home, 'a.md')
  const b = pick(home, 'b.md')
  const destA = defaultDestination(r.claude, 'claude', 'rule', 'a.md')
  const p = plan(home, [
    ch(a, 'claude', destA),
    ch(b, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'b.md'))
  ])
  put(home, '.claude/rules/illithid/a.md', 'written by the user meanwhile\n')
  const res = applyGlobalSync(home, p)
  assert.equal(res.status, 'partial')
  assert.deepEqual(
    res.results.map((x) => [x.status, x.code ?? null]),
    [
      ['refused', 'changedSinceCheck'],
      ['done', null]
    ]
  )
  assert.equal(readFileSync(destA, 'utf8'), 'written by the user meanwhile\n')
})

test('tampered_plan_is_refused: an added destination or a changed selection never reaches the disk', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'A\n', 'rules/b.md': 'B\n' })
  const a = pick(home, 'a.md')
  const b = pick(home, 'b.md')
  const p = plan(home, [ch(a, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'a.md'))])
  const before = snapTools(home)
  const added: GlobalSyncPlan = {
    ...p,
    changes: [
      ...p.changes,
      { ...p.changes[0], destination: join(r.claude, 'rules/illithid/extra.md') }
    ]
  }
  const swapped: GlobalSyncPlan = {
    ...p,
    changes: [
      { ...p.changes[0], variantId: b.id, variantRevision: b.revision, sourceDigest: b.revision }
    ]
  }
  for (const t of [added, swapped, { ...p, id: 'plan-unknown-0000' }]) {
    const res = applyGlobalSync(home, t)
    assert.equal(res.status, 'refused')
    assert.ok(['planMismatch', 'unknownPlan'].includes(res.error!.code), res.error!.code)
  }
  assert.deepEqual(snapTools(home), before)
  // The genuine plan still applies once; a replay of the same plan is refused
  assert.equal(applyGlobalSync(home, p).status, 'completed')
  const replay = applyGlobalSync(home, p)
  assert.deepEqual([replay.status, replay.error?.code], ['refused', 'planAlreadyApplied'])
})

function runChild(args: string[]): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/lib/applyChild.ts'), ...args],
    {
      stdio: 'ignore'
    }
  )
}
async function waitFor(path: string, ms = 20000): Promise<void> {
  const t = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${path}`)
    await new Promise((res) => setTimeout(res, 100))
  }
}

test('second_apply_is_refused: an apply held by another process blocks a second one', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'A\n' })
  const a = pick(home, 'a.md')
  const p = plan(home, [ch(a, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'a.md'))])
  const ready = join(home, '..', 'lock-ready')
  const child = runChild(['holdLock', home, '', ready])
  try {
    await waitFor(ready)
    const before = snapTools(home)
    const res = applyGlobalSync(home, p)
    assert.deepEqual([res.status, res.error?.code], ['refused', 'applyInProgress'])
    assert.deepEqual(snapTools(home), before)
  } finally {
    child.kill()
    await new Promise((res) => child.once('exit', res))
  }
  // The holder is gone: its stale lock does not block a new, explicitly requested apply
  assert.equal(applyGlobalSync(home, p).status, 'completed')
})

test('backup_failure_preserves_destination: no backup, no replacement', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'library A\n' })
  const a = pick(home, 'a.md')
  const dest = put(home, '.claude/rules/illithid/a.md', 'user A\n')
  const p = plan(home, [ch(a, 'claude', dest, readDestination(dest, 'rule').digest)])
  assert.deepEqual(
    p.changes.map((c) => c.op),
    ['replace']
  )
  mkdirSync(globalStateDir(home), { recursive: true })
  writeFileSync(join(globalStateDir(home), 'backups'), 'not a folder')
  const res = applyGlobalSync(home, p)
  assert.equal(res.status, 'failed')
  assert.deepEqual(
    res.results.map((x) => [x.status, x.code]),
    [['failed', 'backupFailed']]
  )
  assert.equal(readFileSync(dest, 'utf8'), 'user A\n')
})

test('write_failure_stops_remaining: applied, failed and not attempted are reported as such', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, {
    'rules/a.md': 'A\n',
    'skills/s/SKILL.md': '---\nname: s\n---\n',
    'rules/c.md': 'C\n'
  })
  mkdirSync(join(r.codex, 'skills'), { recursive: true })
  const p = plan(home, [
    ch(pick(home, 'a.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'a.md')),
    ch(pick(home, 's'), 'codex', defaultDestination(r.codex, 'codex', 'skill', 's')),
    ch(pick(home, 'c.md'), 'opencode', defaultDestination(r.opencode, 'opencode', 'rule', 'c.md'))
  ])
  // Permission withdrawn between the preview and the apply
  const undo = denyWrite(join(r.codex, 'skills'))
  let res: ReturnType<typeof applyGlobalSync>
  try {
    res = applyGlobalSync(home, p)
  } finally {
    undo()
  }
  assert.equal(res.status, 'partial')
  assert.deepEqual(statuses(res), ['done', 'failed', 'notAttempted'])
  assert.ok(['EPERM', 'EACCES'].includes(res.results[1].code!), res.results[1].code)
  assert.equal(existsSync(join(r.codex, 'skills/s')), false)
  assert.equal(existsSync(join(r.opencode, 'AGENTS.md')), false)
  const [op] = listGlobalOperations(home)
  assert.equal(op.status, 'partial')
})

test('a file held open without delete sharing (Windows) makes the replacement fail explicitly, content intact', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'library A\n' })
  const dest = put(home, '.claude/rules/illithid/a.md', 'user A\n')
  const p = plan(home, [
    ch(pick(home, 'a.md'), 'claude', dest, readDestination(dest, 'rule').digest)
  ])
  const ready = join(home, '..', 'open-ready')
  const holder = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$f=[IO.File]::Open('${dest.replace(/'/g, "''")}','Open','Read','Read'); Set-Content -LiteralPath '${ready.replace(/'/g, "''")}' -Value ok; Start-Sleep 60`
    ],
    { stdio: 'ignore' }
  )
  let res: ReturnType<typeof applyGlobalSync>
  try {
    await waitFor(ready)
    res = applyGlobalSync(home, p)
  } finally {
    spawnSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'])
  }
  assert.equal(res.status, 'failed')
  assert.equal(res.results[0].status, 'failed')
  assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(res.results[0].code!), res.results[0].code)
  assert.equal(res.results[0].recovery, 'notNeeded')
  assert.equal(readFileSync(dest, 'utf8'), 'user A\n')
  // No app temp file is left next to the destination
  assert.deepEqual(readdirSync(join(r.claude, 'rules/illithid')), ['a.md'])
  // The backup made before the attempt is kept and reported
  assert.ok(res.results[0].backup && existsSync(res.results[0].backup))
})

test('an operation interrupted after its backup is recorded as interrupted and never resumed', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'library A\n', 'rules/b.md': 'B\n' })
  const dest = put(home, '.claude/rules/illithid/a.md', 'user A\n')
  const p = plan(home, [
    ch(pick(home, 'a.md'), 'claude', dest, readDestination(dest, 'rule').digest),
    ch(pick(home, 'b.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'b.md'))
  ])
  const child = runChild(['crashAfterBackup', home, p.id])
  const code = await new Promise((res) => child.once('exit', res))
  assert.equal(code, 3)
  const [op] = listGlobalOperations(home)
  assert.equal(op.status, 'interrupted')
  assert.deepEqual(
    op.results.map((x) => [x.status, x.phase]),
    [
      ['pending', 'backedUp'],
      ['pending', 'pending']
    ]
  )
  assert.equal(readFileSync(dest, 'utf8'), 'user A\n')
  assert.equal(existsSync(join(r.claude, 'rules/illithid/b.md')), false)
  // Listing again (a restart) changes nothing and resumes nothing
  assert.equal(listGlobalOperations(home)[0].status, 'interrupted')
  assert.equal(readFileSync(dest, 'utf8'), 'user A\n')
  const replay = applyGlobalSync(home, p)
  assert.deepEqual([replay.status, replay.error?.code], ['refused', 'planAlreadyApplied'])
})

test('replacing an unmanaged skill keeps a backup of the previous tree', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'skills/s/SKILL.md': '---\nname: s\n---\nlibrary\n' })
  put(home, '.claude/skills/s/SKILL.md', 'user skill\n')
  put(home, '.claude/skills/s/extra.txt', 'user resource\n')
  const destDir = join(r.claude, 'skills/s')
  const res = applyGlobalSync(
    home,
    plan(home, [ch(pick(home, 's'), 'claude', destDir, readDestination(destDir, 'skill').digest)])
  )
  assert.equal(res.status, 'completed')
  assert.deepEqual(readdirSync(destDir), ['SKILL.md'])
  const bak = res.results[0].backup!
  assert.equal(readFileSync(join(bak, 'content/extra.txt'), 'utf8'), 'user resource\n')
  assert.equal(readFileSync(join(bak, 'content/SKILL.md'), 'utf8'), 'user skill\n')
})

test('a folder turned into a link after the preview is not written through', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'skills/s/SKILL.md': '---\nname: s\n---\n' })
  const p = plan(home, [
    ch(pick(home, 's'), 'claude', defaultDestination(r.claude, 'claude', 'skill', 's'))
  ])
  assert.deepEqual(
    p.changes.map((c) => c.op),
    ['create']
  )
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(r.claude, 'skills'), 'junction')
  const res = applyGlobalSync(home, p)
  assert.deepEqual(
    res.results.map((x) => [x.status, x.code]),
    [['refused', 'linkedAncestor']]
  )
  assert.deepEqual(readdirSync(elsewhere), [])
})

const exitOf = (c: ChildProcess): Promise<number | null> =>
  new Promise((res) =>
    c.exitCode !== null ? res(c.exitCode) : c.once('exit', (code) => res(code))
  )

test('review F1a: an incomplete lock of a live process blocks a second apply', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'A\n' })
  const p = plan(home, [
    ch(pick(home, 'a.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'a.md'))
  ])
  const ready = join(home, '..', 'paused-ready')
  // The other process created the lock and has not written its holder information yet
  const child = runChild(['pauseAfterCreate', home, '', ready])
  try {
    await waitFor(ready)
    const before = snapTools(home)
    const res = applyGlobalSync(home, p)
    assert.deepEqual([res.status, res.error?.code], ['refused', 'applyInProgress'])
    assert.deepEqual(snapTools(home), before)
  } finally {
    child.kill()
    await exitOf(child)
  }
})

test('review F1b: taking over a stale lock never removes the lock of a successor', async () => {
  const home = syntheticHome()
  toolHome(home)
  // A crashed apply leaves its lock behind
  assert.equal(await exitOf(runChild(['acquireAndCrash', home])), 5)
  const ready = join(home, '..', 'successor-ready')
  let successor: ChildProcess | null = null
  try {
    const mine = acquireApplyLock(home, 'op-parent', {
      beforeTakeover: () => {
        // Another process takes the stale lock over first
        successor = runChild(['holdLock', home, '', ready])
        const t = Date.now()
        while (!existsSync(ready) && Date.now() - t < 20000)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    })
    const parentHeld = mine.ok
    if (mine.ok) mine.release()
    assert.ok(existsSync(ready), 'the successor took the lock')
    assert.equal(parentHeld, false, 'two processes hold the apply lock')
    // The successor still holds its lock: another apply is refused too
    const third = acquireApplyLock(home, 'op-third')
    const thirdHeld = third.ok
    if (third.ok) third.release()
    assert.equal(thirdHeld, false)
  } finally {
    const s = successor as ChildProcess | null
    if (s) {
      s.kill()
      await exitOf(s)
    }
  }
})
