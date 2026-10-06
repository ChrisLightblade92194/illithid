/**
 * Project import/delivery, Task 6 (spec 2026-10-06 project delivery §Preview, Apply and restore guarantees;
 * criterion 10): restore is its own preview and Apply. It puts back whole files and skills from verified backups,
 * removes only still-verified delivered content of absent-before destinations, prunes only the empty folders the
 * operation created, restores the previous ownership (even when the bytes are already back), and refuses local edits,
 * newer deliveries, corrupt backups and replaced project folders. Synthetic projects only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyProjectPlan } from '../src/engine/project/operations'
import { decideProjectPlan, planProjectDelivery } from '../src/engine/project/plan'
import { planProjectRestore } from '../src/engine/project/restore'
import { readProjectDeliveries, writeProjectDeliveries } from '../src/engine/project/state'
import type {
  ProjectDeliveryRecord,
  ProjectPlanView,
  ProjectSelection
} from '../src/engine/project/types'
import { deliveryWorkspace, put, SKILL, type DeliveryWorkspace } from './lib/projectFixture'

const ctx = (home: string): { home: string; signal: AbortSignal } => ({
  home,
  signal: new AbortController().signal
})
const D = { type: 'default' } as const
const sel = (
  candidateId: string,
  variantId: string,
  tool: 'codex' | 'claude'
): ProjectSelection => ({
  candidateId,
  variantId,
  tool,
  slot: D
})
const change = (
  p: ProjectPlanView,
  project: string,
  rel: string
): ProjectPlanView['changes'][number] =>
  p.changes.find((c) => c.project.name === project && c.relativePath === rel)!

/** An earlier delivery record of E's AGENTS.md (the ownership a restore must give back) */
function earlierOwner(w: DeliveryWorkspace): ProjectDeliveryRecord {
  const st = statSync(join(w.root, 'E', 'AGENTS.md'), { bigint: true })
  return {
    version: 1,
    id: 'pd-earlier',
    scope: 'project',
    project: w.discovery.bindings.get(w.cid('E'))!,
    target: { physicalKey: `id:${st.dev}:${st.ino}` },
    destination: join(w.root, 'E', 'AGENTS.md'),
    kind: 'rule',
    recipients: ['codex'],
    variantId: w.rule2,
    variantRevision: 'earlier',
    deliveredDigest: 'earlier',
    digestAlgorithm: 'sha256-v1',
    operationId: 'pop-earlier',
    at: '2026-10-05T10:00:00.000Z'
  }
}

/** Applies: E's AGENTS.md replaced, B's skill created (B/.agents pre-exists), B's AGENTS.md created */
async function deliver(w: DeliveryWorkspace): Promise<string> {
  const p0 = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('E'), w.rule, 'codex'),
    sel(w.cid('B'), w.skill, 'codex'),
    sel(w.cid('B'), w.rule, 'codex')
  ])
  const p = await decideProjectPlan(ctx(w.home), p0.id, [
    {
      destinationId: change(p0, 'E', 'AGENTS.md').destinationId,
      variantId: w.rule,
      action: 'replace'
    }
  ])
  const op = await applyProjectPlan(ctx(w.home), p.id)
  assert.equal(op.status, 'completed', JSON.stringify(op.results))
  return op.id
}

test('project_restore_preserves_edits_and_ownership', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const originalBytes = readFileSync(E)
  mkdirSync(join(w.root, 'B', '.agents'))
  put(w.root, 'B/.agents/keep.txt', 'pre-existing\n')
  const previousOwnership = [earlierOwner(w)]
  writeProjectDeliveries(w.home, previousOwnership)
  const projectBeforeApply = readFileSync(E)
  const opId = await deliver(w)
  assert.equal(readProjectDeliveries(w.home).length, 3)

  // Listed in reverse order of the restored operation
  const preview = await planProjectRestore(ctx(w.home), opId)
  assert.equal(preview.kind, 'restore')
  assert.equal(preview.restoreOf, opId)
  assert.deepEqual(
    preview.changes.map((c) => [c.project.name, c.relativePath, c.action, c.restore?.absentBefore]),
    [
      ['E', 'AGENTS.md', 'restore', false],
      ['B', 'AGENTS.md', 'restore', true],
      ['B', '.agents/skills/caveman', 'restore', true]
    ]
  )
  assert.equal(change(preview, 'E', 'AGENTS.md').restore?.previousOwner?.id, 'pd-earlier')
  assert.equal(preview.applicable, true)
  const restored = await applyProjectPlan(ctx(w.home), preview.id)
  assert.equal(restored.status, 'completed', JSON.stringify(restored.results))
  const restoredBytes = readFileSync(E)
  assert.deepEqual(restoredBytes, originalBytes)
  assert.deepEqual(readFileSync(E), projectBeforeApply)
  assert.equal(existsSync(join(w.root, 'B', 'AGENTS.md')), false)
  assert.equal(
    existsSync(join(w.root, 'B', '.agents', 'skills')),
    false,
    'the folder the operation created is pruned'
  )
  assert.equal(readFileSync(join(w.root, 'B', '.agents', 'keep.txt'), 'utf8'), 'pre-existing\n')
  const restoredOwnership = readProjectDeliveries(w.home)
  assert.deepEqual(restoredOwnership, previousOwnership)
  // Nothing left to restore: the same operation again proposes no write
  const again = await planProjectRestore(ctx(w.home), opId)
  assert.equal(again.applicable, false)
})

test('restore refuses local edits, newer deliveries, corrupt backups and replaced projects; keeps populated folders', async () => {
  const w = await deliveryWorkspace()
  const opId = await deliver(w)
  // Local edit of E, a newer delivery to B's AGENTS.md, a folder the operation created now holding user content
  writeFileSync(join(w.root, 'E', 'AGENTS.md'), '# edited after the delivery\n')
  const p2 = await planProjectDelivery(ctx(w.home), w.discovery, [
    sel(w.cid('B'), w.rule2, 'codex')
  ])
  const p2d = await decideProjectPlan(ctx(w.home), p2.id, [
    {
      destinationId: change(p2, 'B', 'AGENTS.md').destinationId,
      variantId: w.rule2,
      action: 'replace'
    }
  ])
  assert.equal((await applyProjectPlan(ctx(w.home), p2d.id)).status, 'completed')
  put(w.root, 'B/.agents/skills/mine/SKILL.md', SKILL('mine'))
  const preview = await planProjectRestore(ctx(w.home), opId)
  assert.deepEqual(
    preview.excluded
      .map((x) => [x.destination?.endsWith(join('E', 'AGENTS.md')) ? 'E' : 'B', x.reason])
      .sort(),
    [
      ['B', 'newerDelivery'],
      ['E', 'changedSinceOperation']
    ]
  )
  assert.deepEqual(
    preview.changes.map((c) => c.relativePath),
    ['.agents/skills/caveman']
  )
  // A restore preview is bound too: an edit after it refuses the write
  const r = await applyProjectPlan(ctx(w.home), preview.id)
  assert.equal(r.status, 'completed', JSON.stringify(r.results))
  assert.equal(existsSync(join(w.root, 'B', '.agents', 'skills', 'caveman')), false)
  assert.ok(
    existsSync(join(w.root, 'B', '.agents', 'skills', 'mine', 'SKILL.md')),
    'populated folder kept'
  )
  assert.equal(
    readFileSync(join(w.root, 'E', 'AGENTS.md'), 'utf8'),
    '# edited after the delivery\n'
  )

  // Corrupt backup
  const w2 = await deliveryWorkspace()
  const op2 = await deliver(w2)
  const before = await planProjectRestore(ctx(w2.home), op2)
  assert.equal(before.applicable, true)
  const { readProjectOperation } = await import('../src/engine/project/operations')
  const eBackup = readProjectOperation(w2.home, op2)!.results.find((x) =>
    x.destination.endsWith(join('E', 'AGENTS.md'))
  )!.backup!
  writeFileSync(join(eBackup, 'content'), 'tampered\n')
  const corrupt = await planProjectRestore(ctx(w2.home), op2)
  assert.ok(corrupt.excluded.some((x) => x.reason === 'backupCorrupt'))
  assert.ok(!corrupt.changes.some((c) => c.project.name === 'E'))
  // A stale restore preview is refused at apply
  const fresh = await planProjectRestore(ctx(w2.home), op2)
  writeFileSync(join(w2.root, 'B', 'AGENTS.md'), '# edited after the restore preview\n')
  const staleRestore = await applyProjectPlan(ctx(w2.home), fresh.id)
  const bRule = staleRestore.results.find((x) => x.destination.endsWith(join('B', 'AGENTS.md')))!
  assert.deepEqual([bRule.status, bRule.code], ['refused', 'changedSinceCheck'])
  assert.equal(
    readFileSync(join(w2.root, 'B', 'AGENTS.md'), 'utf8'),
    '# edited after the restore preview\n'
  )

  // A replaced project folder (identical bytes): refused
  const w3 = await deliveryWorkspace()
  const op3 = await deliver(w3)
  renameSync(join(w3.root, 'E'), join(w3.root, 'E-old'))
  put(w3.root, 'E/AGENTS.md', w3.ruleBytes)
  const replaced = await planProjectRestore(ctx(w3.home), op3)
  assert.ok(replaced.excluded.some((x) => x.reason === 'projectChanged'))
  assert.ok(!replaced.changes.some((c) => c.project.name === 'E'))
})

test('a restore gives ownership back even when the bytes are already as before', async () => {
  const w = await deliveryWorkspace()
  const E = join(w.root, 'E', 'AGENTS.md')
  const original = readFileSync(E)
  const previous = [earlierOwner(w)]
  writeProjectDeliveries(w.home, previous)
  const opId = await deliver(w)
  // The user put the original bytes back by hand: only the ownership still differs
  writeFileSync(E, original)
  const preview = await planProjectRestore(ctx(w.home), opId)
  const e = change(preview, 'E', 'AGENTS.md')
  assert.equal(e.action, 'restore')
  assert.equal(e.beforeDigest, e.afterDigest)
  // Restore only E (the others skipped by decision)
  const decided = await decideProjectPlan(
    ctx(w.home),
    preview.id,
    preview.changes
      .filter((c) => c.destinationId !== e.destinationId)
      .map((c) => ({ destinationId: c.destinationId, action: 'skip' as const }))
  )
  const r = await applyProjectPlan(ctx(w.home), decided.id)
  assert.equal(r.status, 'completed', JSON.stringify(r.results))
  assert.deepEqual(readFileSync(E), original)
  const owners = readProjectDeliveries(w.home)
  assert.deepEqual(
    owners.find((o) => o.destination === E),
    previous[0]
  )
  assert.ok(existsSync(join(w.root, 'B', 'AGENTS.md')), 'skipped destinations stay as delivered')
})
