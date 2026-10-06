/**
 * Project import/delivery, Task 5 (spec 2026-10-06 project delivery §Physical collisions and existing content,
 * §Preview, Apply and restore guarantees; criteria 4–7): concrete delivery previews bound by the backend. Absent →
 * Create, equal → Unchanged (no adoption), different → Skip by default even when managed; one physical AGENTS.md is one
 * change; differing incoming variants need a choice; stale or widened requests are refused before any write.
 * Synthetic projects and libraries only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverProjects } from '../src/engine/census/paths'
import type { DiscoveryHandle } from '../src/engine/census/types'
import { globalLibraryDir } from '../src/engine/globalPaths'
import { computeGlobalPlan } from '../src/engine/globalManualSync'
import { renameGlobalVariant, listGlobalVariants } from '../src/engine/globalVariants'
import { resolveGlobalPaths } from '../src/engine/globalPaths'
import {
  decideProjectPlan,
  discardProjectPlan,
  planProjectDelivery,
  readProjectPlan
} from '../src/engine/project/plan'
import { readProjectDeliveries, writeProjectDeliveries } from '../src/engine/project/state'
import type {
  ProjectDeliveryRecord,
  ProjectPlanView,
  ProjectSelection
} from '../src/engine/project/types'
import {
  inside,
  isContent,
  isWrite,
  observeFs,
  projectWorkspace,
  put,
  samePath,
  seedRawVariant,
  SKILL,
  snapshot
} from './lib/projectFixture'

const ctx = (home: string): { home: string; signal: AbortSignal } => ({
  home,
  signal: new AbortController().signal
})
const D = { type: 'default' } as const

interface Ws {
  home: string
  root: string
  d: DiscoveryHandle
  cid: (name: string) => string
  rule: string
  rule2: string
  skill: string
}

/** Library: rule R, rule R2 (other content), skill caveman. Projects B (empty), C (AGENTS.md = R), E (AGENTS.md ≠ R) */
async function workspace(): Promise<Ws> {
  const { home, root } = projectWorkspace()
  const rule = seedRawVariant(home, {
    kind: 'rule',
    name: 'shared.md',
    content: '# shared\r\n@docs/x.md\n',
    origins: []
  }).id
  const rule2 = seedRawVariant(home, {
    kind: 'rule',
    name: 'shared.md',
    content: '# other\n',
    origins: []
  }).id
  const skill = seedRawVariant(home, {
    kind: 'skill',
    name: 'caveman',
    content: {
      'SKILL.md': SKILL('caveman'),
      'assets/x.bin': Buffer.from([1, 2]),
      '.DS_Store': 'x'
    },
    origins: []
  }).id
  mkdirSync(join(root, 'B'))
  put(root, 'B/CLAUDE.md', '# unselected\n')
  put(root, 'C/AGENTS.md', '# shared\r\n@docs/x.md\n')
  put(root, 'E/AGENTS.md', '# edited locally\n')
  put(root, 'F/.agents/skills/unrelated/SKILL.md', SKILL('unrelated'))
  const d = await discoverProjects(root)
  const cid = (name: string): string => d.view.candidates.find((c) => c.name === name)!.id
  return { home, root, d, cid, rule, rule2, skill }
}

const sel = (
  candidateId: string,
  variantId: string,
  tool: 'claude' | 'codex' | 'opencode',
  slot: ProjectSelection['slot'] = D
): ProjectSelection => ({ candidateId, variantId, tool, slot })

const change = (
  p: ProjectPlanView,
  project: string,
  rel: string
): ProjectPlanView['changes'][number] | undefined =>
  p.changes.find((c) => c.project.name === project && c.relativePath === rel)

test('project_plan_defaults_to_skip', async () => {
  const w = await workspace()
  const before = snapshot(w.root)
  // E's AGENTS.md was delivered by Illithid earlier, then edited: still Skip by default
  const managed: ProjectDeliveryRecord = {
    version: 1,
    id: 'pd-old',
    scope: 'project',
    project: w.d.bindings.get(w.cid('E'))!,
    target: { physicalKey: 'id:0:0' },
    destination: join(w.root, 'E', 'AGENTS.md'),
    kind: 'rule',
    recipients: ['codex'],
    variantId: w.rule,
    variantRevision: 'r',
    deliveredDigest: 'd',
    digestAlgorithm: 'sha256-v1',
    operationId: 'pop-old',
    at: '2026-10-06T09:00:00.000Z'
  }
  writeProjectDeliveries(w.home, [managed])
  const run = await observeFs(() =>
    planProjectDelivery(ctx(w.home), w.d, [
      sel(w.cid('B'), w.rule, 'codex'),
      sel(w.cid('C'), w.rule, 'codex'),
      sel(w.cid('E'), w.rule, 'codex'),
      sel(w.cid('B'), w.skill, 'codex')
    ])
  )
  assert.equal(run.error, undefined, String(run.error))
  const plan = run.value!
  const created = change(plan, 'B', 'AGENTS.md')!
  assert.equal(created.action, 'create')
  assert.equal(created.beforeDigest, null)
  const equal = change(plan, 'C', 'AGENTS.md')!
  assert.equal(equal.action, 'unchanged')
  assert.equal(equal.owner, null, 'identical unmanaged content is not adopted')
  const different = { changes: [change(plan, 'E', 'AGENTS.md')!] }
  assert.equal(different.changes[0].action, 'skip')
  assert.equal(different.changes[0].owner?.id, 'pd-old')
  assert.match(different.changes[0].preview.before ?? '', /edited locally/)
  assert.match(different.changes[0].preview.after ?? '', /# shared/)
  const skill = change(plan, 'B', '.agents/skills/caveman')!
  assert.equal(skill.action, 'create')
  assert.deepEqual(
    skill.preview.files!.map((f) => [f.path, f.change]),
    [
      ['.DS_Store', 'added'],
      ['SKILL.md', 'added'],
      ['assets', 'added'],
      ['assets/x.bin', 'added']
    ]
  )
  assert.equal(plan.collisions.length, 0)
  assert.equal(plan.kind, 'sync')
  // A preview writes nothing in the projects and reads nothing it was not asked about
  const recipientWrites = run.calls.filter((c) => isWrite(c) && inside(c.path, w.root))
  assert.equal(recipientWrites.length, 0)
  assert.deepEqual(snapshot(w.root), before)
  const unselected = run.calls.filter(
    (c) =>
      isContent(c) &&
      (samePath(c.path, join(w.root, 'B', 'CLAUDE.md')) || inside(c.path, join(w.root, 'F')))
  )
  assert.deepEqual(unselected, [])
  assert.deepEqual(readProjectDeliveries(w.home), [managed])
  assert.ok(readProjectPlan(w.home, plan.id), 'the backend stored the plan')
  assert.equal(readProjectPlan(w.home, 'pplan-forged'), null)
})

test('shared_agents_is_one_physical_change', async () => {
  const w = await workspace()
  const shared = await planProjectDelivery(ctx(w.home), w.d, [
    sel(w.cid('B'), w.rule, 'codex'),
    sel(w.cid('B'), w.rule, 'opencode')
  ])
  assert.equal(shared.changes.length, 1)
  assert.deepEqual(shared.changes[0].recipients.sort(), ['codex', 'opencode'])
  assert.equal(shared.changes[0].incoming.length, 1)
  assert.equal(shared.changes[0].action, 'create')
  assert.equal(shared.applicable, true)
  // The OpenCode CLAUDE.md slot and Claude's default name the same physical file
  const claude = await planProjectDelivery(ctx(w.home), w.d, [
    sel(w.cid('B'), w.rule, 'claude'),
    sel(w.cid('B'), w.rule, 'opencode', { type: 'opencodeClaude' })
  ])
  assert.equal(claude.changes.length, 1)
  assert.equal(claude.changes[0].relativePath, 'CLAUDE.md')
  assert.deepEqual(claude.changes[0].recipients.sort(), ['claude', 'opencode'])
  // Omitted combinations stay out: only the selected tool and project appear
  const omitted = await planProjectDelivery(ctx(w.home), w.d, [sel(w.cid('B'), w.skill, 'codex')])
  assert.deepEqual(
    omitted.changes.map((c) => `${c.project.name}:${c.relativePath}`),
    ['B:.agents/skills/caveman']
  )
})

test('incoming_collision_requires_choice', async () => {
  const w = await workspace()
  const before = snapshot(w.root)
  const run = await observeFs(() =>
    planProjectDelivery(ctx(w.home), w.d, [
      sel(w.cid('B'), w.rule, 'codex'),
      sel(w.cid('B'), w.rule2, 'opencode')
    ])
  )
  const conflicting = run.value!
  assert.equal(conflicting.changes.length, 1)
  assert.equal(conflicting.collisions.length, 1)
  assert.deepEqual(conflicting.collisions[0].variantIds.sort(), [w.rule, w.rule2].sort())
  const c = conflicting.changes[0]
  assert.equal(c.selectedVariantId, null)
  assert.equal(c.action, 'skip')
  assert.equal(conflicting.applicable, false)
  const recipientWrites = run.calls.filter((x) => isWrite(x) && inside(x.path, w.root))
  assert.equal(recipientWrites.length, 0)

  // Inconsistent or widened decisions are refused
  for (const bad of [
    [{ destinationId: c.destinationId, variantId: w.rule2, action: 'replace' }],
    [{ destinationId: c.destinationId, variantId: w.skill, action: 'create' }],
    [{ destinationId: c.destinationId, variantId: null, action: 'create' }],
    [{ destinationId: 'd-unknown', variantId: w.rule2, action: 'create' }],
    [
      { destinationId: c.destinationId, variantId: w.rule2, action: 'create' },
      { destinationId: c.destinationId, variantId: w.rule, action: 'create' }
    ],
    [{ destinationId: c.destinationId, variantId: w.rule2, action: 'create', path: 'C:\\x' }],
    [{ destinationId: c.destinationId, action: 'restore' }]
  ])
    await assert.rejects(decideProjectPlan(ctx(w.home), conflicting.id, bad as never), {
      code: 'invalid'
    })
  // An explicit choice resolves the collision in a newly bound plan; the old plan is spent
  const chosen = await decideProjectPlan(ctx(w.home), conflicting.id, [
    { destinationId: c.destinationId, variantId: w.rule2, action: 'create' }
  ])
  assert.notEqual(chosen.id, conflicting.id)
  assert.equal(chosen.collisions.length, 0)
  assert.equal(chosen.changes[0].selectedVariantId, w.rule2)
  assert.equal(chosen.changes[0].action, 'create')
  assert.equal(chosen.applicable, true)
  await assert.rejects(
    decideProjectPlan(ctx(w.home), conflicting.id, [
      { destinationId: c.destinationId, variantId: w.rule, action: 'create' }
    ]),
    { code: 'planAlreadyApplied' }
  )
  // Choosing to skip the destination also resolves it, with nothing to write
  const skipped = await decideProjectPlan(ctx(w.home), chosen.id, [
    { destinationId: c.destinationId, variantId: null, action: 'skip' }
  ])
  assert.equal(skipped.collisions.length, 0)
  assert.equal(skipped.changes[0].action, 'skip')
  assert.equal(skipped.applicable, false)
  discardProjectPlan(w.home, skipped.id)
  await assert.rejects(
    decideProjectPlan(ctx(w.home), skipped.id, [
      { destinationId: c.destinationId, variantId: w.rule, action: 'create' }
    ]),
    { code: 'planAlreadyApplied' }
  )
  assert.deepEqual(snapshot(w.root), before)
})

test('project_plan_rejects_stale_or_widened_decisions', async () => {
  const w = await workspace()
  // Requests are checked before any content read
  const refused = await observeFs(async () => {
    const out: string[] = []
    for (const s of [
      [],
      [sel(w.cid('B'), w.rule, 'codex'), sel(w.cid('B'), w.rule, 'codex')],
      [{ ...sel(w.cid('B'), w.rule, 'codex'), destination: join(w.root, 'B', 'x.md') }],
      [sel('not-a-candidate', w.rule, 'codex')],
      [sel(w.cid('B'), 'rule-0000000000000000', 'codex')],
      [sel(w.cid('B'), w.rule, 'gemini' as 'codex')],
      [sel(w.cid('B'), w.rule, 'codex', { type: 'default', extra: 1 } as never)],
      [sel(w.cid('B'), w.skill, 'codex', { type: 'codexOverride' })]
    ] as ProjectSelection[][])
      try {
        await planProjectDelivery(ctx(w.home), w.d, s)
        out.push('accepted')
      } catch (e) {
        out.push((e as { code?: string }).code ?? 'error')
      }
    return out
  })
  assert.deepEqual(refused.value, Array(8).fill('invalid'))
  assert.deepEqual(
    refused.calls.filter((c) => isContent(c) && inside(c.path, w.root)),
    [],
    'no project content read for a refused request'
  )

  // Corrupt variant metadata pointing outside the library: refused without reading outside
  const corrupt = seedRawVariant(w.home, {
    kind: 'rule',
    name: 'evil.md',
    content: 'x\n',
    origins: []
  })
  const outside = join(w.root, '..', 'outside.md')
  writeFileSync(outside, 'secret\n')
  const meta = join(corrupt.dir, 'variant.json')
  writeFileSync(
    meta,
    JSON.stringify({
      version: 1,
      id: corrupt.id,
      kind: 'rule',
      name: 'evil.md',
      content: '../../../../outside.md',
      origins: [],
      references: []
    })
  )
  const c1 = await observeFs(() =>
    planProjectDelivery(ctx(w.home), w.d, [sel(w.cid('B'), corrupt.id, 'codex')])
  )
  assert.equal(c1.error, undefined, String(c1.error))
  assert.deepEqual(c1.value!.changes, [])
  assert.equal(c1.value!.excluded[0].reason, 'variantCorrupt')
  assert.deepEqual(
    c1.calls.filter((c) => samePath(c.path, outside)),
    []
  )
  // The same escape spelled with Windows separators inside the file name
  writeFileSync(
    meta,
    JSON.stringify({
      version: 1,
      id: corrupt.id,
      kind: 'rule',
      name: 'evil.md',
      content: 'content/..\\..\\..\\..\\outside.md',
      origins: [],
      references: []
    })
  )
  const c2 = await observeFs(() =>
    planProjectDelivery(ctx(w.home), w.d, [sel(w.cid('B'), corrupt.id, 'codex')])
  )
  assert.equal(c2.error, undefined, String(c2.error))
  assert.equal(c2.value!.excluded[0]?.reason, 'variantCorrupt')
  assert.deepEqual(
    c2.calls.filter((c) => samePath(c.path, outside)),
    []
  )

  // After the preview, each kind of change makes the dependent plan stale instead of using new content silently
  const plan = async (): Promise<ProjectPlanView> =>
    planProjectDelivery(ctx(w.home), w.d, [
      sel(w.cid('E'), w.rule, 'codex'),
      sel(w.cid('B'), w.skill, 'claude')
    ])
  const decide = (p: ProjectPlanView): Promise<ProjectPlanView> =>
    decideProjectPlan(ctx(w.home), p.id, [
      {
        destinationId: change(p, 'E', 'AGENTS.md')!.destinationId,
        variantId: w.rule,
        action: 'replace'
      }
    ])
  const staleAfter = async (what: string, mutate: () => void, undo?: () => void): Promise<void> => {
    const p = await plan()
    mutate()
    await assert.rejects(decide(p), { code: 'stale' }, what)
    undo?.()
  }
  // A decision on unchanged state is accepted
  const fine = await decide(await plan())
  assert.equal(change(fine, 'E', 'AGENTS.md')!.action, 'replace')
  await staleAfter(
    'destination bytes',
    () => writeFileSync(join(w.root, 'E', 'AGENTS.md'), '# edited again\n'),
    () => writeFileSync(join(w.root, 'E', 'AGENTS.md'), '# edited locally\n')
  )
  await staleAfter(
    'variant content',
    () =>
      writeFileSync(join(globalLibraryDir(w.home), w.skill, 'content', 'assets', 'new.txt'), 'n'),
    () =>
      renameSync(
        join(globalLibraryDir(w.home), w.skill, 'content', 'assets', 'new.txt'),
        join(w.root, 'moved.txt')
      )
  )
  await staleAfter(
    'variant renamed',
    () => renameGlobalVariant(w.home, w.skill, 'caveman2'),
    () => renameGlobalVariant(w.home, w.skill, 'caveman')
  )
  const rec: ProjectDeliveryRecord = {
    version: 1,
    id: 'pd-x',
    scope: 'project',
    project: w.d.bindings.get(w.cid('E'))!,
    target: { physicalKey: 'id:0:0' },
    destination: join(w.root, 'E', 'AGENTS.md'),
    kind: 'rule',
    recipients: ['codex'],
    variantId: w.rule,
    variantRevision: 'r',
    deliveredDigest: 'd',
    digestAlgorithm: 'sha256-v1',
    operationId: 'pop-x',
    at: '2026-10-06T09:00:00.000Z'
  }
  await staleAfter(
    'ownership recorded',
    () => writeProjectDeliveries(w.home, [rec]),
    () => writeProjectDeliveries(w.home, [])
  )
  writeProjectDeliveries(w.home, [rec])
  await staleAfter('ownership forgotten', () => writeProjectDeliveries(w.home, []))
  writeProjectDeliveries(w.home, [rec])
  await staleAfter('ownership replaced', () =>
    writeProjectDeliveries(w.home, [{ ...rec, id: 'pd-y', operationId: 'pop-y' }])
  )
  writeProjectDeliveries(w.home, [])
  await staleAfter('project folder replaced', () => {
    renameSync(join(w.root, 'E'), join(w.root, 'E-old'))
    put(w.root, 'E/AGENTS.md', '# edited locally\n')
  })
  assert.ok(listGlobalVariants(w.home).length >= 3)
  assert.ok(readdirSync(w.root).includes('E-old'))
})

test('the global preview leaves out a destination a project delivery owns', async () => {
  const w = await workspace()
  // A global Codex root that is also a project folder with a delivered AGENTS.md
  const B = join(w.root, 'B')
  put(B, 'AGENTS.md', '# delivered\n')
  writeProjectDeliveries(w.home, [
    {
      version: 1,
      id: 'pd-b',
      scope: 'project',
      project: w.d.bindings.get(w.cid('B'))!,
      target: { physicalKey: 'id:0:0' },
      destination: join(B, 'AGENTS.md'),
      kind: 'rule',
      recipients: ['codex'],
      variantId: w.rule,
      variantRevision: 'r',
      deliveredDigest: 'd',
      digestAlgorithm: 'sha256-v1',
      operationId: 'pop-b',
      at: '2026-10-06T09:00:00.000Z'
    }
  ])
  const paths = resolveGlobalPaths(w.home, { codex: B }, {})
  const v = listGlobalVariants(w.home).find((x) => x.id === w.rule)!
  const plan = computeGlobalPlan(
    w.home,
    [
      {
        variantId: v.id,
        variantRevision: v.revision,
        tool: 'codex',
        destination: `${join(B, 'AGENTS.md')}::shared.md`,
        expectedDestinationDigest: null
      }
    ],
    { paths }
  )
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.excluded[0].reason, 'projectOwnership')
})
