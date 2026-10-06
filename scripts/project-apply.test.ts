/**
 * Project import/delivery, Task 6 (spec 2026-10-06 project delivery §Preview, Apply and restore guarantees; criteria
 * 7, 9): a one-shot Apply that backs up before writing, writes verified whole content, records ownership last, shares
 * the Windows exclusive apply lock with the global flow, stops at the first failure or a cancellation and reports what
 * really happened — including an interruption, which is never replayed. Synthetic projects and profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultDestination } from '../src/engine/globalDestinations'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import { resolveGlobalPaths } from '../src/engine/globalPaths'
import { listGlobalVariants } from '../src/engine/globalVariants'
import {
  applyProjectPlan,
  listProjectOperations,
  readProjectBackupMeta
} from '../src/engine/project/operations'
import { decideProjectPlan, planProjectDelivery } from '../src/engine/project/plan'
import { readProjectDeliveries } from '../src/engine/project/state'
import type { ProjectPlanView, ProjectSelection } from '../src/engine/project/types'
import { contentSnapshot } from './lib/globalFixture'
import {
  deliveryWorkspace,
  errno,
  inside,
  isWrite,
  linkDir,
  observeFs,
  put,
  samePath,
  snapshot,
  type DeliveryWorkspace
} from './lib/projectFixture'

const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

const ctx = (
  home: string,
  signal = new AbortController().signal
): { home: string; signal: AbortSignal } => ({
  home,
  signal
})
const D = { type: 'default' } as const
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const sel = (
  candidateId: string,
  variantId: string,
  tool: 'claude' | 'codex' | 'opencode'
): ProjectSelection => ({ candidateId, variantId, tool, slot: D })
const change = (
  p: ProjectPlanView,
  project: string,
  rel: string
): ProjectPlanView['changes'][number] =>
  p.changes.find((c) => c.project.name === project && c.relativePath === rel)!

/** E's AGENTS.md replaced explicitly, B's skill and AGENTS.md created */
async function replacePlan(
  w: DeliveryWorkspace,
  extra: ProjectSelection[] = []
): Promise<ProjectPlanView> {
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('E'), w.rule, 'codex'),
    ...extra
  ])
  return decideProjectPlan(ctx(w.home), p0.id, [
    {
      destinationId: change(p0, 'E', 'AGENTS.md').destinationId,
      variantId: w.rule,
      action: 'replace'
    }
  ])
}

function runChild(args: string[]): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/lib/projectApplyChild.ts'), ...args],
    {
      stdio: 'ignore'
    }
  )
}
async function waitFor(path: string, ms = 30000): Promise<void> {
  const t = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${path}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const exited = (c: ChildProcess): Promise<number | null> =>
  c.exitCode !== null
    ? Promise.resolve(c.exitCode)
    : new Promise((r) => c.once('exit', (code) => r(code)))

test('project_apply_backs_up_before_writing', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const originalBytes = readFileSync(E)
  const p = await replacePlan(w, [
    sel(w.cid('B'), w.skill, 'codex'),
    sel(w.cid('B'), w.rule, 'codex')
  ])
  assert.deepEqual(
    p.changes.map((c) => [c.project.name, c.relativePath, c.action]),
    [
      ['B', '.agents/skills/caveman', 'create'],
      ['B', 'AGENTS.md', 'create'],
      ['E', 'AGENTS.md', 'replace']
    ]
  )
  const atBackup: { bytes: Buffer; meta: unknown }[] = []
  const rec = await applyProjectPlan(ctx(w.home), p.id, {
    afterBackup: (r, i) => {
      if (samePath(r.results[i].destination, E))
        atBackup.push({ bytes: readFileSync(E), meta: readProjectBackupMeta(r.results[i].backup!) })
    }
  })
  assert.equal(rec.status, 'completed', JSON.stringify(rec.results))
  // The backup was complete and verified while the destination still held its original bytes
  assert.equal(atBackup.length, 1)
  assert.deepEqual(atBackup[0].bytes, originalBytes)
  const eRes = rec.results.find((r) => samePath(r.destination, E))!
  const meta = readProjectBackupMeta(eRes.backup!)!
  assert.equal(meta.shape, 'file')
  assert.equal(meta.digest, sha(originalBytes))
  assert.deepEqual(readFileSync(join(eRes.backup!, 'content')), originalBytes)
  assert.deepEqual(readFileSync(E), w.ruleBytes)
  // The whole skill folder, resources, hidden files and the empty folder included; created folders are recorded
  const skillDest = join(w.root, 'B', '.agents', 'skills', 'caveman')
  const v = listGlobalVariants(w.home).find((x) => x.id === w.skill)!
  assert.deepEqual(contentSnapshot(skillDest), contentSnapshot(v.contentPath))
  const sRes = rec.results.find((r) => samePath(r.destination, skillDest))!
  assert.deepEqual(
    sRes.createdDirs!.map((d) => d.path),
    [join(w.root, 'B', '.agents'), join(w.root, 'B', '.agents', 'skills')]
  )
  assert.equal(readProjectBackupMeta(sRes.backup!)!.shape, 'absent')
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.phase]),
    [
      ['done', 'recorded'],
      ['done', 'recorded'],
      ['done', 'recorded']
    ]
  )
  // Ownership recorded per physical destination, with the delivered identity
  const records = readProjectDeliveries(w.home)
  assert.equal(records.length, 3)
  for (const r of records) {
    assert.equal(r.operationId, rec.id)
    assert.deepEqual(r.recipients, ['codex'])
    assert.match(r.target.physicalKey, /^id:/)
  }
  // One-shot: the same plan, or the one the decision replaced, cannot be replayed
  const replay = await applyProjectPlan(ctx(w.home), p.id)
  assert.deepEqual([replay.status, replay.error?.code], ['refused', 'planAlreadyApplied'])
  // Untouched: unselected projects and the source library
  assert.deepEqual(readdirSync(join(w.root, 'F', '.agents', 'skills')), ['unrelated'])
})

test('project apply refuses a destination changed after the preview, and a failed backup writes nothing', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const p = await replacePlan(w)
  writeFileSync(E, '# edited after the preview\n')
  const stale = await applyProjectPlan(ctx(w.home), p.id)
  assert.equal(stale.status, 'refused')
  assert.deepEqual(
    stale.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(readFileSync(E, 'utf8'), '# edited after the preview\n')
  assert.deepEqual(readProjectDeliveries(w.home), [])

  // A backup that cannot be written: the destination is never written
  const w2 = await deliveryWorkspace()
  const E2 = join(w2.root, 'E', 'AGENTS.md')
  const p2 = await replacePlan(w2, [sel(w2.cid('F'), w2.rule, 'codex')])
  const before = snapshot(join(w2.root, 'E'))
  const run = await observeFs(() => applyProjectPlan(ctx(w2.home), p2.id), {
    fail: (c) =>
      /open/.test(c.fn) && c.path.includes(join('project', 'backups')) && /content/.test(c.path)
        ? errno('EACCES')
        : undefined
  })
  const rec = run.value!
  assert.equal(rec.status, 'failed', JSON.stringify(rec.results))
  assert.deepEqual(
    rec.results.map((r) => [r.project.name, r.relativePath, r.status, r.code ?? null]),
    [
      ['E', 'AGENTS.md', 'failed', 'backupFailed'],
      ['F', 'AGENTS.md', 'notAttempted', null]
    ]
  )
  assert.equal(existsSync(join(w2.root, 'F', 'AGENTS.md')), false)
  const writesAfterFailedBackup = run.calls.filter(
    (c) => isWrite(c) && (samePath(c.path, E2) || /\.AGENTS\.md\.illithid-/.test(c.path))
  )
  assert.equal(writesAfterFailedBackup.length, 0)
  assert.equal(readFileSync(E2, 'utf8'), '# edited locally\n')
  const after = snapshot(join(w2.root, 'E'))
  assert.equal(after['./AGENTS.md'], before['./AGENTS.md'])
})

test('a failure after one successful write stops the queue: later destinations are not attempted', async () => {
  const w = await deliveryWorkspace()
  const p = await replacePlan(w, [
    sel(w.cid('B'), w.skill, 'codex'),
    sel(w.cid('B'), w.rule, 'codex')
  ])
  const E = join(w.root, 'E', 'AGENTS.md')
  const run = await observeFs(() => applyProjectPlan(ctx(w.home), p.id), {
    // The staged file of B's AGENTS.md cannot be created
    fail: (c) =>
      /open/.test(c.fn) &&
      inside(c.path, join(w.root, 'B')) &&
      /\.AGENTS\.md\.illithid-.*\.tmp$/.test(c.path)
        ? errno('EIO')
        : undefined
  })
  const rec = run.value!
  assert.equal(rec.status, 'partial')
  assert.deepEqual(
    rec.results.map((r) => [r.relativePath, r.status]),
    [
      ['.agents/skills/caveman', 'done'],
      ['AGENTS.md', 'failed'],
      ['AGENTS.md', 'notAttempted']
    ]
  )
  assert.equal(rec.results[1].code, 'EIO')
  assert.equal(existsSync(join(w.root, 'B', 'AGENTS.md')), false)
  assert.deepEqual(
    readdirSync(join(w.root, 'B')).filter((n) => n.includes('.illithid-')),
    [],
    'no staged file left behind'
  )
  assert.equal(readFileSync(E, 'utf8'), '# edited locally\n')
  assert.equal(readProjectDeliveries(w.home).length, 1)
})

test('project_apply_and_global_apply_share_lock', async () => {
  const w = await deliveryWorkspace()
  const held = await replacePlan(w)
  const other = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('B'), w.rule, 'codex')
  ])
  mkdirSync(join(w.home, '.claude'), { recursive: true })
  const paths = resolveGlobalPaths(w.home, { claude: join(w.home, '.claude') }, {})
  const v = listGlobalVariants(w.home).find((x) => x.id === w.rule)!
  const globalPlan = planGlobalSync(
    w.home,
    [
      {
        variantId: v.id,
        variantRevision: v.revision,
        tool: 'claude',
        destination: defaultDestination(join(w.home, '.claude'), 'claude', 'rule', v.name),
        expectedDestinationDigest: null
      }
    ],
    { paths }
  )
  const ready = join(w.base, 'project-paused')
  const child = runChild(['pauseAfterBackup', w.home, held.id, ready])
  try {
    await waitFor(ready)
    const busy = await applyProjectPlan(ctx(w.home), other.id)
    assert.equal(busy.status, 'refused')
    assert.equal(busy.results[0].code, 'applyInProgress')
    assert.equal(busy.error?.code, 'applyInProgress')
    const g = applyGlobalSync(w.home, globalPlan)
    assert.deepEqual([g.status, g.error?.code], ['refused', 'applyInProgress'])
    assert.equal(existsSync(join(w.root, 'B', 'AGENTS.md')), false)
  } finally {
    child.kill()
    await exited(child)
  }
  // The held operation is reported as interrupted (its write never started); nothing is resumed
  const ops = listProjectOperations(w.home)
  const paused = ops.find((o) => o.planId === held.id)!
  assert.equal(paused.status, 'interrupted')
  assert.deepEqual(
    paused.results.map((r) => r.status),
    ['notAttempted']
  )
  assert.equal(readFileSync(join(w.root, 'E', 'AGENTS.md'), 'utf8'), '# edited locally\n')
  // The lock of a process that is gone never blocks: the refused plan was not spent and applies now
  const now = await applyProjectPlan(ctx(w.home), other.id)
  assert.equal(now.status, 'completed')

  // The reverse: the global flow's holder blocks a project apply
  const w2 = await deliveryWorkspace()
  const p2 = await planProjectDelivery(ctx(w2.home), w2.discovery, [
    sel(w2.cid('B'), w2.rule, 'codex')
  ])
  const ready2 = join(w2.base, 'global-holds')
  const holder = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/lib/applyChild.ts'), 'holdLock', w2.home, '', ready2],
    { stdio: 'ignore' }
  )
  try {
    await waitFor(ready2)
    const busy2 = await applyProjectPlan(ctx(w2.home), p2.id)
    assert.equal(busy2.results[0].code, 'applyInProgress')
  } finally {
    holder.kill()
    await exited(holder)
  }
})

test('project_apply_reports_partial_cancel_and_crash', async () => {
  // Cancelled after the first destination is recorded: it stays, the next is not attempted
  const w = await deliveryWorkspace()
  const p = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('B'), w.skill, 'codex'),
    sel(w.cid('B'), w.rule, 'codex')
  ])
  const c = new AbortController()
  const rec = await applyProjectPlan(ctx(w.home, c.signal), p.id, { afterRecord: () => c.abort() })
  assert.equal(rec.status, 'cancelled')
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code ?? null]),
    [
      ['done', null],
      ['notAttempted', 'cancelled']
    ]
  )
  assert.equal(existsSync(join(w.root, 'B', 'AGENTS.md')), false)
  assert.equal(readProjectDeliveries(w.home).length, 1)

  // A crash between the write and the ownership record: interrupted, uncertain, backup intact, nothing replayed
  const w2 = await deliveryWorkspace()
  const E = join(w2.root, 'E', 'AGENTS.md')
  const original = readFileSync(E)
  const p2 = await replacePlan(w2)
  const ready = join(w2.base, 'crash-after-write')
  const child = runChild(['crashAfterWrite', w2.home, p2.id, ready])
  assert.equal(await exited(child), 3)
  const listing = await observeFs(() => listProjectOperations(w2.home))
  const interrupted = listing.value!.find((o) => o.planId === p2.id)!
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.results[0].status, 'uncertain')
  // Listing probes the lock (an exclusive open of the state lock file) but writes nothing in any project
  const startupRecipientWrites = listing.calls.filter((x) => isWrite(x) && inside(x.path, w2.root))
  assert.equal(startupRecipientWrites.length, 0)
  const meta = readProjectBackupMeta(interrupted.results[0].backup!)!
  assert.equal(meta.digest, sha(original))
  assert.deepEqual(readFileSync(join(interrupted.results[0].backup!, 'content')), original)
  assert.deepEqual(readProjectDeliveries(w2.home), [], 'the crash left no ownership record')
  assert.deepEqual(readFileSync(E), w2.ruleBytes, 'the write had happened: uncertain, not undone')
  assert.deepEqual(listProjectOperations(w2.home), listing.value, 'listing twice changes nothing')

  // A crash right after the backup: interrupted, the write never started
  const w3 = await deliveryWorkspace()
  const p3 = await replacePlan(w3)
  const ready3 = join(w3.base, 'crash-after-backup')
  const child3 = runChild(['crashAfterBackup', w3.home, p3.id, ready3])
  assert.equal(await exited(child3), 3)
  const op3 = listProjectOperations(w3.home).find((o) => o.planId === p3.id)!
  assert.equal(op3.status, 'interrupted')
  assert.equal(op3.results[0].status, 'notAttempted')
  assert.equal(readFileSync(join(w3.root, 'E', 'AGENTS.md'), 'utf8'), '# edited locally\n')
  assert.ok(readProjectBackupMeta(op3.results[0].backup!))
  put(w3.base, 'done', 'x')
})

test('destinations sharing missing folders apply in one operation; nothing provisional is left', async () => {
  const w = await deliveryWorkspace()
  // Both Claude destinations of B need the missing `.claude` folder
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [
    { candidateId: w.cid('B'), variantId: w.skill, tool: 'claude', slot: D },
    {
      candidateId: w.cid('B'),
      variantId: w.rule2,
      tool: 'claude',
      slot: { type: 'claudeNamedRule', name: 'team/other.md' }
    }
  ])
  assert.deepEqual(
    p0.changes.map((c) => [c.relativePath, c.action]),
    [
      ['.claude/rules/illithid/team/other.md', 'create'],
      ['.claude/skills/caveman', 'create']
    ]
  )
  const run = await observeFs(() => applyProjectPlan(ctx(w.home), p0.id))
  const rec = run.value!
  assert.equal(rec.status, 'completed', JSON.stringify(rec.results))
  assert.deepEqual(
    rec.results.map((r) => (r.createdDirs ?? []).map((d) => d.path.slice(w.root.length + 1))),
    [
      [
        join('B', '.claude'),
        join('B', '.claude', 'rules'),
        join('B', '.claude', 'rules', 'illithid'),
        join('B', '.claude', 'rules', 'illithid', 'team')
      ],
      [join('B', '.claude', 'skills')]
    ]
  )
  // No staged or aside entry is left in the project; nothing outside the selected project was written
  const leftovers = Object.keys(snapshot(join(w.root, 'B'))).filter((k) => k.includes('.illithid-'))
  assert.deepEqual(leftovers, [])
  assert.deepEqual(
    run.calls.filter(
      (c) => isWrite(c) && inside(c.path, w.root) && !inside(c.path, join(w.root, 'B'))
    ),
    []
  )
  // Only verified copies: no whole-tree copy API, no link-following stat or realpath
  assert.deepEqual(
    run.calls.filter(
      (c) => /^(promises\.)?(cp|copyFile)(Sync)?$/.test(c.fn) || /realpath/.test(c.fn)
    ),
    []
  )
})

test('a junction swapped in after the backup and a library variant changed while staged are refused', async () => {
  const w = await deliveryWorkspace()
  put(w.base, 'outside/keep.txt', 'outside\n')
  const outsideBefore = snapshot(join(w.base, 'outside'))
  const p = await planProjectDelivery(ctx(w.home), w.discovery, [
    { candidateId: w.cid('B'), variantId: w.skill, tool: 'claude', slot: D }
  ])
  const rec = await applyProjectPlan(ctx(w.home), p.id, {
    afterBackup: () => linkDir(join(w.base, 'outside'), join(w.root, 'B', '.claude'))
  })
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.deepEqual(
    snapshot(join(w.base, 'outside')),
    outsideBefore,
    'nothing written through the junction'
  )
  assert.deepEqual(readProjectDeliveries(w.home), [])

  // The library skill changes while its copy is staged beside the destination
  const w2 = await deliveryWorkspace()
  const p2 = await planProjectDelivery(ctx(w2.home), w2.discovery, [
    sel(w2.cid('B'), w2.skill, 'codex')
  ])
  const v = listGlobalVariants(w2.home).find((x) => x.id === w2.skill)!
  let changed = false
  const run = await observeFs(() => applyProjectPlan(ctx(w2.home), p2.id), {
    hold: (c) => {
      if (
        !changed &&
        c.fn === 'promises.open' &&
        samePath(c.path, join(v.contentPath, 'assets', 'x.bin')) &&
        existsSync(join(w2.root, 'B', '.agents', 'skills')) &&
        readdirSync(join(w2.root, 'B', '.agents', 'skills')).some((n) => n.includes('.illithid-'))
      ) {
        changed = true
        writeFileSync(join(v.contentPath, 'assets', 'x.bin'), Buffer.from([9, 9]))
      }
      return undefined
    }
  })
  assert.ok(changed)
  const r2 = run.value!
  assert.deepEqual(
    r2.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(
    existsSync(join(w2.root, 'B', '.agents')),
    false,
    'created folders pruned, nothing staged left'
  )
  assert.deepEqual(readProjectDeliveries(w2.home), [])
})

test('no unhandled rejection in the project apply tests', () => {
  assert.deepEqual(unhandled, [])
})
