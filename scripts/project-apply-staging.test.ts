/**
 * Project delivery review finding 1 (spec 2026-10-06 project delivery §Preview, Apply and restore guarantees): the
 * staged copy is prepared asynchronously beside the destination, so the source, the destination, the project chain,
 * the ownership and the scope overlap are checked again after staging, immediately before the destination changes.
 * A change seen there refuses that destination, removes the staged copy and the folders created for it, and leaves the
 * new local content alone. Changes are injected while the staged copy is being written (synthetic projects only).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listGlobalVariants } from '../src/engine/globalVariants'
import { applyProjectPlan, readProjectBackupMeta } from '../src/engine/project/operations'
import { decideProjectPlan, planProjectDelivery } from '../src/engine/project/plan'
import { planProjectRestore } from '../src/engine/project/restore'
import { readProjectDeliveries, writeProjectDeliveries } from '../src/engine/project/state'
import type {
  ProjectDeliveryRecord,
  ProjectPlanView,
  ProjectSelection
} from '../src/engine/project/types'
import {
  deliveryWorkspace,
  observeFs,
  put,
  samePath,
  SKILL,
  snapshot,
  type DeliveryWorkspace,
  type FsCall
} from './lib/projectFixture'

const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

const ctx = (home: string): { home: string; signal: AbortSignal } => ({
  home,
  signal: new AbortController().signal
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

/** The exclusive creation of the staged copy (`.<name>.illithid-<pid>-<hex>.tmp`) of a destination, or a file in it */
const staging = (c: FsCall, destination: string): boolean => {
  if (c.fn !== 'promises.open' || c.flags !== 'wx') return false
  const name = destination.split(/[\\/]/).pop()!
  const tag = new RegExp(`^\\.${name.replace(/\./g, '\\.')}\\.illithid-.*\\.tmp$`)
  for (let p = c.path; dirname(p) !== p; p = dirname(p))
    if (tag.test(p.split(/[\\/]/).pop()!) && samePath(dirname(p), dirname(destination))) return true
  return false
}

/** Runs the apply; `during` runs once, while the destination's staged copy is being created */
async function applyWhileStaging(
  w: DeliveryWorkspace,
  planId: string,
  destination: string,
  during: () => void
): Promise<{ rec: Awaited<ReturnType<typeof applyProjectPlan>>; injected: boolean }> {
  let injected = false
  const run = await observeFs(() => applyProjectPlan(ctx(w.home), planId), {
    hold: (c) => {
      if (!injected && staging(c, destination)) {
        injected = true
        during()
      }
      return undefined
    }
  })
  if (run.error) throw run.error
  return { rec: run.value!, injected }
}

const leftovers = (dir: string): string[] =>
  Object.keys(snapshot(dir)).filter((k) => k.includes('.illithid-'))

test('a local edit of the destination while the copy is staged is refused and kept; the backup holds the bytes before', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const before = readFileSync(E)
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [sel(w.cid('E'), w.rule, 'codex')])
  const p = await decideProjectPlan(ctx(w.home), p0.id, [
    {
      destinationId: change(p0, 'E', 'AGENTS.md').destinationId,
      variantId: w.rule,
      action: 'replace'
    }
  ])
  const { rec, injected } = await applyWhileStaging(w, p.id, E, () =>
    writeFileSync(E, '# edited while staged\n')
  )
  assert.ok(injected, 'the staged copy was observed')
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(rec.status, 'refused')
  assert.equal(readFileSync(E, 'utf8'), '# edited while staged\n', 'the local edit is kept')
  const meta = readProjectBackupMeta(rec.results[0].backup!)!
  assert.equal(meta.digest, sha(before))
  assert.deepEqual(readFileSync(join(rec.results[0].backup!, 'content')), before)
  assert.equal(rec.results[0].deliveryId, undefined)
  assert.deepEqual(leftovers(join(w.root, 'E')), [], 'the staged copy is removed')
  assert.deepEqual(readProjectDeliveries(w.home), [])
})

test('a resource added to the library skill while its copy is staged is refused, not delivered without it', async () => {
  const w = await deliveryWorkspace()
  const dest = join(w.root, 'B', '.agents', 'skills', 'caveman')
  const p = await planProjectDelivery(ctx(w.home), w.discovery, [sel(w.cid('B'), w.skill, 'codex')])
  const v = listGlobalVariants(w.home).find((x) => x.id === w.skill)!
  const { rec, injected } = await applyWhileStaging(w, p.id, dest, () =>
    writeFileSync(join(v.contentPath, 'ADDED.txt'), 'new resource\n')
  )
  assert.ok(injected)
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(existsSync(join(w.root, 'B', '.agents')), false, 'created folders pruned')
  assert.deepEqual(readProjectDeliveries(w.home), [])
  assert.equal(readFileSync(join(v.contentPath, 'ADDED.txt'), 'utf8'), 'new resource\n')
})

test('a destination folder changed while the replacement is staged is refused and kept', async () => {
  const w = await deliveryWorkspace()
  const dest = join(w.root, 'B', '.agents', 'skills', 'caveman')
  put(w.root, 'B/.agents/skills/caveman/SKILL.md', SKILL('caveman') + 'local\n')
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('B'), w.skill, 'codex')
  ])
  const c = change(p0, 'B', '.agents/skills/caveman')
  assert.equal(c.action, 'skip')
  const p = await decideProjectPlan(ctx(w.home), p0.id, [
    { destinationId: c.destinationId, variantId: w.skill, action: 'replace' }
  ])
  const { rec, injected } = await applyWhileStaging(w, p.id, dest, () =>
    writeFileSync(join(dest, 'notes.md'), 'local notes\n')
  )
  assert.ok(injected)
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(readFileSync(join(dest, 'notes.md'), 'utf8'), 'local notes\n')
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), SKILL('caveman') + 'local\n')
  assert.deepEqual(leftovers(join(w.root, 'B')), [])
  assert.deepEqual(readProjectDeliveries(w.home), [])
})

test('an ownership recorded while the copy is staged is refused; the record stays as written', async () => {
  const w = await deliveryWorkspace()
  const dest = join(w.root, 'B', 'AGENTS.md')
  const p = await planProjectDelivery(ctx(w.home), w.discovery, [sel(w.cid('B'), w.rule, 'codex')])
  const other: ProjectDeliveryRecord = {
    version: 1,
    id: 'pd-other',
    scope: 'project',
    project: w.discovery.bindings.get(w.cid('B'))!,
    target: { physicalKey: 'other' },
    destination: dest,
    kind: 'rule',
    recipients: ['codex'],
    variantId: w.rule2,
    variantRevision: 'other',
    deliveredDigest: 'other',
    digestAlgorithm: 'sha256-v1',
    operationId: 'pop-other',
    at: '2026-10-06T10:00:00.000Z'
  }
  const { rec, injected } = await applyWhileStaging(w, p.id, dest, () =>
    writeProjectDeliveries(w.home, [other])
  )
  assert.ok(injected)
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'ownershipChanged']]
  )
  assert.equal(existsSync(dest), false, 'nothing written')
  assert.deepEqual(leftovers(join(w.root, 'B')), [])
  assert.deepEqual(readProjectDeliveries(w.home), [other])
})

test('a local edit while a restore is staged is refused and kept; the delivery stays recorded', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [sel(w.cid('E'), w.rule, 'codex')])
  const p = await decideProjectPlan(ctx(w.home), p0.id, [
    {
      destinationId: change(p0, 'E', 'AGENTS.md').destinationId,
      variantId: w.rule,
      action: 'replace'
    }
  ])
  const op = await applyProjectPlan(ctx(w.home), p.id)
  assert.equal(op.status, 'completed', JSON.stringify(op.results))
  const owners = readProjectDeliveries(w.home)
  const preview = await planProjectRestore(ctx(w.home), op.id)
  assert.equal(change(preview, 'E', 'AGENTS.md').action, 'restore')
  const { rec, injected } = await applyWhileStaging(w, preview.id, E, () =>
    writeFileSync(E, '# edited while the restore is staged\n')
  )
  assert.ok(injected)
  assert.deepEqual(
    rec.results.map((r) => [r.status, r.code]),
    [['refused', 'changedSinceCheck']]
  )
  assert.equal(readFileSync(E, 'utf8'), '# edited while the restore is staged\n')
  assert.deepEqual(leftovers(join(w.root, 'E')), [])
  assert.deepEqual(readProjectDeliveries(w.home), owners, 'ownership is not given back')
})

test('several destinations sharing folders created by the same operation all pass the checks after staging', async () => {
  const w = await deliveryWorkspace()
  const p = await planProjectDelivery(ctx(w.home), w.discovery, [
    { candidateId: w.cid('B'), variantId: w.skill, tool: 'claude', slot: D },
    {
      candidateId: w.cid('B'),
      variantId: w.rule,
      tool: 'claude',
      slot: { type: 'claudeNamedRule', name: 'team/a.md' }
    },
    {
      candidateId: w.cid('B'),
      variantId: w.rule2,
      tool: 'claude',
      slot: { type: 'claudeNamedRule', name: 'team/b.md' }
    }
  ])
  assert.deepEqual(
    p.changes.map((c) => [c.relativePath, c.action]),
    [
      ['.claude/rules/illithid/team/a.md', 'create'],
      ['.claude/rules/illithid/team/b.md', 'create'],
      ['.claude/skills/caveman', 'create']
    ]
  )
  const rec = await applyProjectPlan(ctx(w.home), p.id)
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
      [],
      [join('B', '.claude', 'skills')]
    ]
  )
  const team = join(w.root, 'B', '.claude', 'rules', 'illithid', 'team')
  assert.deepEqual(readFileSync(join(team, 'a.md')), w.ruleBytes)
  assert.equal(readFileSync(join(team, 'b.md'), 'utf8'), '# other\n')
  assert.ok(existsSync(join(w.root, 'B', '.claude', 'skills', 'caveman', 'SKILL.md')))
  assert.deepEqual(leftovers(join(w.root, 'B')), [])
  assert.equal(readProjectDeliveries(w.home).length, 3)
})

test('no unhandled rejection in the staging tests', () => {
  assert.deepEqual(unhandled, [])
})
