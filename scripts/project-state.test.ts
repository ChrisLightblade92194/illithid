/**
 * Project import/delivery, Task 4 (spec 2026-10-06 project delivery §Content, provenance and ownership; criteria 3,
 * 6): project delivery records live in their own state file, legacy global state is read and written unchanged, and
 * ownership overlap between global and project scopes is found in both directions — whole files holding global
 * sections, folders containing one another, confirmed global roots — by path and by observed identity.
 * Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sectionDestination } from '../src/engine/globalDestinations'
import { confirmGlobalPath, globalStateDir } from '../src/engine/globalPaths'
import {
  listGlobalVariants,
  mergeGlobalVariants,
  readDeliveries,
  writeDeliveries,
  type DeliveryRecord
} from '../src/engine/globalVariants'
import { findScopeOverlap } from '../src/engine/project/ownership'
import {
  forgetProjectDelivery,
  readProjectDeliveries,
  writeProjectDeliveries
} from '../src/engine/project/state'
import type { ProjectDeliveryRecord } from '../src/engine/project/types'
import { seedRawVariant, projectWorkspace, put, snapshot } from './lib/projectFixture'

function globalRecord(destination: string, over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    destination,
    tool: 'codex',
    kind: 'rule',
    variantId: 'rule-global',
    variantRevision: 'r',
    deliveredDigest: 'd',
    at: '2026-10-06T10:00:00.000Z',
    operationId: 'op-global',
    ...over
  }
}

function projectRecord(
  destination: string,
  project: string,
  over: Partial<ProjectDeliveryRecord> = {}
): ProjectDeliveryRecord {
  return {
    version: 1,
    id: `pd-${Math.random().toString(36).slice(2)}`,
    scope: 'project',
    project: { path: project, chain: [] },
    target: { physicalKey: 'id:0:0' },
    destination,
    kind: 'rule',
    recipients: ['codex', 'opencode'],
    variantId: 'rule-project',
    variantRevision: 'r',
    deliveredDigest: 'd',
    digestAlgorithm: 'sha256-v1',
    operationId: 'pop-1',
    at: '2026-10-06T10:00:00.000Z',
    ...over
  }
}

test('project_ownership_is_separate_and_bidirectional', () => {
  const { home, root } = projectWorkspace()
  const B = join(root, 'B')
  put(B, 'AGENTS.md', '# b\n')
  mkdirSync(join(B, '.agents', 'skills', 'caveman'), { recursive: true })
  // Legacy global state, read and written by the project store without a byte changing
  writeDeliveries(home, [globalRecord(join(home, '.codex', 'AGENTS.md'))])
  put(globalStateDir(home), 'choices.json', '{"version":1,"choices":[]}\n')
  const globalStateBefore = snapshot(globalStateDir(home))

  assert.deepEqual(readProjectDeliveries(home), [])
  const rec = projectRecord(join(B, 'AGENTS.md'), B)
  writeProjectDeliveries(home, [rec])
  assert.deepEqual(readProjectDeliveries(home), [rec])
  assert.ok(existsSync(join(globalStateDir(home), 'project', 'deliveries.json')))
  const globalStateAfter = snapshot(globalStateDir(home))
  delete globalStateAfter['./project']
  delete globalStateAfter['./project/deliveries.json']
  assert.deepEqual(globalStateAfter, globalStateBefore)
  assert.equal(readDeliveries(home).length, 1, 'global records keep their own file and meaning')

  // Project → global: a project whole file holding a global managed section, in either scope's spelling
  writeDeliveries(home, [globalRecord(sectionDestination(join(B, 'AGENTS.md'), 'caveman'))])
  const fromProject = findScopeOverlap(home, join(B, 'AGENTS.md'), 'project')
  assert.equal(fromProject?.scope, 'global')
  // Global → project: a global section inside a file a project delivery owns as a whole
  const fromGlobal = findScopeOverlap(home, sectionDestination(join(B, 'AGENTS.md'), 'x'), 'global')
  assert.equal(fromGlobal?.scope, 'project')
  assert.equal(fromGlobal?.recordId, rec.id)

  // Folders containing one another: a global skill folder target and a project skill, both directions
  writeDeliveries(home, [globalRecord(join(B, '.agents'), { kind: 'skill' })])
  assert.equal(
    findScopeOverlap(home, join(B, '.agents', 'skills', 'caveman'), 'project')?.scope,
    'global'
  )
  writeProjectDeliveries(home, [
    projectRecord(join(B, '.agents', 'skills', 'caveman'), B, { kind: 'skill' })
  ])
  assert.equal(findScopeOverlap(home, join(B, '.agents'), 'global')?.scope, 'project')
  assert.equal(
    findScopeOverlap(home, join(B, '.agents', 'skills', 'caveman', 'x'), 'global')?.scope,
    'project'
  )
  // Unrelated paths do not overlap
  writeDeliveries(home, [])
  assert.equal(findScopeOverlap(home, join(B, 'CLAUDE.md'), 'project'), null)
  assert.equal(findScopeOverlap(home, join(home, '.codex', 'AGENTS.md'), 'global'), null)

  // A project destination inside a confirmed global tool root
  confirmGlobalPath(home, 'codex', B)
  const inRoot = findScopeOverlap(home, join(B, '.agents', 'skills', 'other'), 'project')
  assert.equal(inRoot?.scope, 'global')
  assert.equal(inRoot?.reason, 'globalRoot')

  // Forgetting a project delivery drops only that record
  writeProjectDeliveries(home, [rec, projectRecord(join(B, 'CLAUDE.md'), B)])
  forgetProjectDelivery(home, rec.id)
  assert.deepEqual(
    readProjectDeliveries(home).map((r) => r.destination),
    [join(B, 'CLAUDE.md')]
  )
  assert.throws(() => forgetProjectDelivery(home, rec.id), { code: 'notFound' })
  // A corrupt project state is refused, never read as empty
  put(globalStateDir(home), 'project/deliveries.json', '{"version":2}')
  assert.throws(() => readProjectDeliveries(home))
  assert.equal(
    readFileSync(join(globalStateDir(home), 'choices.json'), 'utf8'),
    '{"version":1,"choices":[]}\n'
  )
})

test('an explicit library merge refuses a variant an active project delivery names', () => {
  const { home, root } = projectWorkspace()
  const a = seedRawVariant(home, { kind: 'rule', name: 'a.md', content: 'same\n', origins: [] })
  const b = seedRawVariant(home, { kind: 'rule', name: 'a.md', content: 'same\n', origins: [] })
  const rev = listGlobalVariants(home)[0].revision
  writeProjectDeliveries(home, [
    projectRecord(join(root, 'B', 'AGENTS.md'), join(root, 'B'), { variantId: b.id })
  ])
  assert.deepEqual(mergeGlobalVariants(home, [a.id, b.id], rev), { ok: false, code: 'inUse' })
  // Not managed by a project delivery: the explicit merge works with mixed or empty provenance
  writeProjectDeliveries(home, [])
  assert.deepEqual(mergeGlobalVariants(home, [a.id, b.id], rev), { ok: true, id: a.id })
})
