/**
 * Task 6 — managed removals and restore with conflicts (spec 2026-10-04 §10; §12 criteria 8, 9, 10).
 * Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveGlobalPaths, type GlobalTool } from '../src/engine/globalPaths'
import {
  forgetDelivery,
  listGlobalVariants,
  readDeliveries,
  type DeliveryChoice
} from '../src/engine/globalVariants'
import { defaultDestination, readDestination } from '../src/engine/globalDestinations'
import {
  applyGlobalSync,
  planGlobalRemoval,
  planGlobalSync,
  type GlobalSyncPlan
} from '../src/engine/globalManualSync'
import { applyGlobalRestore, planGlobalRestore } from '../src/engine/globalRestore'
import { contentSnapshot, put, seedVariants, snapshot, syntheticHome } from './lib/globalFixture'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const contentTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, contentSnapshot(join(home, d))]))
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))

function toolHome(home: string): Record<GlobalTool, string> {
  for (const d of TOOL_DIRS) mkdirSync(join(home, d), { recursive: true })
  return Object.fromEntries(
    resolveGlobalPaths(home, {}, {}).map((p) => [p.tool, p.paths[0]])
  ) as Record<GlobalTool, string>
}
const paths = (home: string): ReturnType<typeof resolveGlobalPaths> =>
  resolveGlobalPaths(home, {}, {})
function pick(home: string, name: string): { id: string; revision: string } {
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
  planGlobalSync(home, choices, { paths: paths(home) })

async function deliveredHome(): Promise<{
  home: string
  r: Record<GlobalTool, string>
  before: Record<string, Record<string, string>>
  opId: string
}> {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, {
    'rules/r.md': 'library rule\n',
    'skills/kit/SKILL.md': '---\nname: kit\n---\nlibrary\n',
    'skills/kit/res/new.bin': Buffer.from([1, 2, 3])
  })
  put(home, '.codex/AGENTS.md', 'codex user text')
  put(home, '.claude/skills/kit/SKILL.md', 'user kit\n')
  put(home, '.claude/skills/kit/res/old.bin', Buffer.from([9, 9]))
  const before = contentTools(home)
  const kitDir = join(r.claude, 'skills/kit')
  const res = applyGlobalSync(
    home,
    plan(home, [
      ch(pick(home, 'r.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'r.md')),
      ch(pick(home, 'r.md'), 'codex', defaultDestination(r.codex, 'codex', 'rule', 'r.md')),
      ch(pick(home, 'kit'), 'claude', kitDir, readDestination(kitDir, 'skill').digest),
      ch(pick(home, 'kit'), 'codex', defaultDestination(r.codex, 'codex', 'skill', 'kit'))
    ])
  )
  assert.equal(res.status, 'completed')
  return { home, r, before, opId: res.operationId }
}

test('restore_reconstructs_previous_tree: files, sections, skill trees and created folders', async () => {
  const { home, before, opId } = await deliveredHome()
  const rp = planGlobalRestore(home, opId, { paths: paths(home) })
  assert.deepEqual(rp.conflicts, [])
  assert.deepEqual(rp.excluded, [])
  assert.deepEqual(rp.changes.map((c) => c.op).sort(), ['remove', 'remove', 'remove', 'replace'])
  const res = applyGlobalRestore(home, rp)
  assert.equal(res.status, 'completed')
  assert.deepEqual(contentTools(home), before)
  // Restored destinations are no longer recorded as app deliveries
  assert.deepEqual(readDeliveries(home), [])
})

test('restore_changed_destination_requires_choice: nothing is overwritten without a decision on the new content', async () => {
  const { home, r, opId } = await deliveredHome()
  const rule = defaultDestination(r.claude, 'claude', 'rule', 'r.md')
  writeFileSync(rule, 'edited by the user after the sync\n')
  const rp = planGlobalRestore(home, opId, { paths: paths(home) })
  assert.deepEqual(
    rp.conflicts.map((c) => [c.type, c.destination]),
    [['destinationChanged', rule]]
  )
  assert.ok(!rp.changes.some((c) => c.destination === rule))
  const res = applyGlobalRestore(home, rp)
  assert.equal(res.status, 'completed')
  assert.equal(readFileSync(rule, 'utf8'), 'edited by the user after the sync\n')
  // Explicit decision bound to the content shown: replaced, after a backup of the current version
  const current = readDestination(rule, 'rule').digest!
  const decided = planGlobalRestore(home, opId, {
    paths: paths(home),
    accept: [{ destination: rule, expectedDestinationDigest: current }]
  })
  // The other destinations were already given back by the first restore
  assert.deepEqual(
    decided.changes.filter((c) => c.op !== 'unchanged').map((c) => [c.destination, c.op]),
    [[rule, 'remove']]
  )
  const done = applyGlobalRestore(home, decided)
  assert.equal(done.status, 'completed')
  assert.equal(existsSync(rule), false)
  assert.equal(
    readFileSync(
      join(done.results.find((x) => x.destination === rule)!.backup!, 'content'),
      'utf8'
    ),
    'edited by the user after the sync\n'
  )
})

test('disable_tool_does_not_delete: leaving a tool out of the choices removes nothing', async () => {
  const { home, r } = await deliveredHome()
  const before = snapTools(home)
  const onlyClaude = plan(home, [
    ch(pick(home, 'r.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'r.md'))
  ])
  assert.deepEqual(
    onlyClaude.changes.map((c) => [c.tool, c.op]),
    [['claude', 'unchanged']]
  )
  assert.equal(applyGlobalSync(home, onlyClaude).status, 'completed')
  assert.deepEqual(snapTools(home), before)
  assert.equal(readDeliveries(home).length, 4)
})

test('removal is limited to managed content and shown in the preview; foreign files stay', async () => {
  const { home, r } = await deliveredHome()
  const managed = defaultDestination(r.claude, 'claude', 'rule', 'r.md')
  const foreign = put(home, '.claude/rules/illithid/mine.md', 'user file in the same folder\n')
  const section = defaultDestination(r.codex, 'codex', 'rule', 'r.md')
  const rp = planGlobalRemoval(home, [
    { destination: managed, expectedDestinationDigest: null },
    { destination: foreign, expectedDestinationDigest: null },
    { destination: section, expectedDestinationDigest: null }
  ])
  assert.deepEqual(
    rp.changes.map((c) => [c.destination, c.op]),
    [
      [managed, 'remove'],
      [section, 'remove']
    ]
  )
  assert.deepEqual(
    rp.excluded.map((e) => [e.choice.destination, e.reason]),
    [[foreign, 'notManaged']]
  )
  const res = applyGlobalSync(home, rp)
  assert.equal(res.status, 'completed')
  assert.equal(existsSync(managed), false)
  assert.equal(readFileSync(foreign, 'utf8'), 'user file in the same folder\n')
  assert.equal(readFileSync(join(r.codex, 'AGENTS.md'), 'utf8'), 'codex user text')
  assert.ok(res.results.every((x) => x.backup && existsSync(x.backup)))
  // A managed destination edited since its delivery is not removed without a decision
  const kit = join(r.codex, 'skills/kit')
  writeFileSync(join(kit, 'SKILL.md'), 'edited\n')
  const again = planGlobalRemoval(home, [{ destination: kit, expectedDestinationDigest: null }])
  assert.deepEqual(again.changes, [])
  assert.deepEqual(
    again.conflicts.map((c) => c.type),
    ['destinationChanged']
  )
})

test('a missing or corrupt backup is reported and never counted as restored', async () => {
  const { home, opId } = await deliveredHome()
  const first = planGlobalRestore(home, opId, { paths: paths(home) })
  const [a, b] = first.changes.filter((c) => c.restoreFrom)
  unlinkSync(join(a.restoreFrom!, 'meta.json'))
  const meta = JSON.parse(readFileSync(join(b.restoreFrom!, 'meta.json'), 'utf8')) as {
    shape: string
  }
  if (meta.shape === 'dir') rmSync(join(b.restoreFrom!, 'content'), { recursive: true })
  else writeFileSync(join(b.restoreFrom!, 'content'), 'tampered')
  const rp = planGlobalRestore(home, opId, { paths: paths(home) })
  assert.deepEqual(
    rp.excluded.map((e) => [e.choice.destination, e.reason]).sort(),
    [
      [a.destination, 'backupMissing'],
      [b.destination, 'backupCorrupt']
    ].sort()
  )
  assert.equal(rp.changes.length, first.changes.length - 2)
  const res = applyGlobalRestore(home, rp)
  assert.ok(
    !res.results.some((x) => x.destination === a.destination || x.destination === b.destination)
  )
})

test('restore of an interrupted operation: only what was written is undone, on request', async () => {
  const home = syntheticHome()
  const r = toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'library A\n', 'rules/b.md': 'B\n' })
  const dest = put(home, '.claude/rules/illithid/a.md', 'user A\n')
  const p = plan(home, [
    ch(pick(home, 'a.md'), 'claude', dest, readDestination(dest, 'rule').digest),
    ch(pick(home, 'b.md'), 'claude', defaultDestination(r.claude, 'claude', 'rule', 'b.md'))
  ])
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/lib/applyChild.ts'), 'crashAfterBackup', home, p.id],
    { stdio: 'ignore' }
  )
  assert.equal(await new Promise((res) => child.once('exit', res)), 3)
  const before = snapTools(home)
  const rp = planGlobalRestore(
    home,
    (await import('../src/engine/globalOperations')).listGlobalOperations(home)[0].id,
    {
      paths: paths(home)
    }
  )
  // The first change was backed up but never written: nothing to undo; the second never started
  assert.deepEqual(
    rp.changes.map((c) => [c.destination, c.op]),
    [[dest, 'unchanged']]
  )
  assert.deepEqual(snapTools(home), before)
})

test('review F3: removals and updates are bound to the ownership shown; after forgetDelivery an old plan is refused', async () => {
  const { home, r } = await deliveredHome()
  const rule = defaultDestination(r.claude, 'claude', 'rule', 'r.md')
  const section = defaultDestination(r.codex, 'codex', 'rule', 'r.md')
  const removal = planGlobalRemoval(home, [{ destination: rule, expectedDestinationDigest: null }])
  assert.deepEqual(
    removal.changes.map((c) => c.op),
    ['remove']
  )
  // A library edit makes the delivered section an update (managed content, no decision needed)
  const v = listGlobalVariants(home).find((x) => x.name === 'r.md')!
  writeFileSync(v.contentPath, 'library rule v2\n')
  const v2 = listGlobalVariants(home).find((x) => x.name === 'r.md')!
  const update = plan(home, [ch(v2, 'codex', section)])
  assert.deepEqual(
    update.changes.map((c) => c.op),
    ['update']
  )
  const before = snapTools(home)
  // The user leaves both destinations unmanaged after seeing the previews
  assert.deepEqual(forgetDelivery(home, rule), { ok: true })
  assert.deepEqual(forgetDelivery(home, section), { ok: true })
  for (const p of [removal, update]) {
    const res = applyGlobalSync(home, p)
    assert.equal(res.status, 'refused')
    assert.deepEqual(
      res.results.map((x) => [x.status, x.code]),
      [['refused', 'ownershipChanged']]
    )
  }
  assert.deepEqual(snapTools(home), before)
  assert.equal(readFileSync(rule, 'utf8'), 'library rule\n')
})

test('review F4: a restore also gives back the earlier ownership of destinations already as they were', async () => {
  const { home, r, opId } = await deliveredHome()
  const rule = defaultDestination(r.claude, 'claude', 'rule', 'r.md')
  // The user already removed the delivered file by hand: the content is as before the operation
  unlinkSync(rule)
  assert.ok(readDeliveries(home).some((d) => d.destination === rule))
  const rp = planGlobalRestore(home, opId, { paths: paths(home) })
  assert.deepEqual(
    rp.changes.filter((c) => c.destination === rule).map((c) => c.op),
    ['unchanged']
  )
  const res = applyGlobalRestore(home, rp)
  assert.equal(res.status, 'completed')
  // Before the operation nobody owned it: the record of the restored operation is gone
  assert.deepEqual(
    readDeliveries(home).filter((d) => d.destination === rule),
    []
  )
  assert.equal(existsSync(rule), false)
})
