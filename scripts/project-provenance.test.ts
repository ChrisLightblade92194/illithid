/**
 * Project import/delivery, Task 1 (spec 2026-10-06 project delivery §Content, provenance; criterion 3): a project
 * origin lives beside legacy global origins without a `tool` owner, legacy records are read without being rewritten,
 * origin keys never equate a project origin with a global one, and equal variants stay separate until an explicit
 * merge. Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { originKey, type VariantOrigin } from '../src/engine/globalImport'
import { listGlobalVariants, mergeGlobalVariants } from '../src/engine/globalVariants'
import { globalLibraryView } from '../src/engine/globalView'
import type { ProjectOrigin } from '../src/engine/project/types'
import { variantLabel } from '../src/renderer/src/windows/globalUi'
import { seedVariants } from './lib/globalFixture'
import { seedRawVariant } from './lib/projectFixture'
import { createHash } from 'node:crypto'
import { projectWorkspace } from './lib/projectFixture'

const sha = (b: string): string => createHash('sha256').update(b).digest('hex')

function projectOrigin(over: Partial<ProjectOrigin> = {}): ProjectOrigin {
  return {
    scope: 'project',
    projectRoot: 'C:\\p\\A',
    relativePath: '.claude/rules/a.md',
    path: 'C:\\p\\A\\.claude\\rules\\a.md',
    consumers: ['claude'],
    importedAt: '2026-10-06T10:00:00.000Z',
    digest: sha('same\n'),
    digestAlgorithm: 'sha256-v1',
    ...over
  }
}

test('project_origin_coexists_with_legacy_origin', async () => {
  const { home } = projectWorkspace()
  const [legacy] = await seedVariants(home, { 'rules/a.md': 'same\n' })
  const legacyFile = join(home, '.illithid', 'global', 'variants', legacy.id, 'variant.json')
  const legacyJsonBefore = readFileSync(legacyFile)
  const project = seedRawVariant(home, {
    kind: 'rule',
    name: 'a.md',
    content: 'same\n',
    origins: [projectOrigin()]
  })

  const variants = listGlobalVariants(home)
  const p = variants.find((v) => v.id === project.id)!
  const g = variants.find((v) => v.id === legacy.id)!
  const projectOriginRead = p.origins[0] as VariantOrigin
  assert.equal(projectOriginRead.tool, undefined)
  assert.equal((projectOriginRead as ProjectOrigin).scope, 'project')
  // Equal content and name: a merge suggestion, never an implicit merge
  assert.deepEqual(p.sameContentAs, [g.id])
  assert.deepEqual(g.sameContentAs, [p.id])
  assert.equal(variants.length, 2)

  // The library view (the global UI's source) accepts a project-only origin; legacy files are not rewritten
  const view = globalLibraryView(home, {})
  assert.ok(view.variants.some((v) => v.id === project.id))
  const legacyJsonAfter = readFileSync(legacyFile)
  assert.deepEqual(legacyJsonAfter, legacyJsonBefore)

  // Origin keys carry scope, path and digest format
  const a = projectOrigin()
  const b = projectOrigin({ digestAlgorithm: 'census-skill-v1' })
  assert.notEqual(originKey(a), originKey(b))
  assert.notEqual(originKey(a), originKey(g.origins[0]))
  assert.notEqual(
    originKey(projectOrigin({ path: g.origins[0].path, digest: g.origins[0].digest })),
    originKey(g.origins[0])
  )
  assert.equal(originKey(g.origins[0]), originKey({ ...g.origins[0] }))

  // Labels tell a project origin apart from a tool origin
  const label = variantLabel(p)
  assert.match(label, /project/i)
  assert.match(label, /\.claude\/rules\/a\.md/)
  assert.doesNotMatch(label, /undefined/)
  assert.match(variantLabel(g), /Claude Code/)

  // Explicit merge of mixed provenance keeps both origins, the project one still without a tool
  const merged = mergeGlobalVariants(home, [g.id, p.id], g.revision)
  assert.deepEqual(merged, { ok: true, id: g.id })
  const after = listGlobalVariants(home)
  assert.equal(after.length, 1)
  assert.equal(after[0].origins.length, 2)
  const kept = after[0].origins.find((o) => (o as ProjectOrigin).scope === 'project')!
  assert.equal(kept.tool, undefined)
  assert.equal((kept as ProjectOrigin).relativePath, '.claude/rules/a.md')
})

test('project_origins_are_deduplicated_by_their_own_key_on_merge', () => {
  const { home } = projectWorkspace()
  // Two project variants recorded from the same path and digest value but different digest formats
  const one = seedRawVariant(home, {
    kind: 'rule',
    name: 'a.md',
    content: 'same\n',
    origins: [projectOrigin()]
  })
  const two = seedRawVariant(home, {
    kind: 'rule',
    name: 'a.md',
    content: 'same\n',
    origins: [projectOrigin({ digestAlgorithm: 'census-skill-v1' })]
  })
  const v = listGlobalVariants(home)
  const r = mergeGlobalVariants(home, [one.id, two.id], v[0].revision)
  assert.equal(r.ok, true)
  assert.equal(listGlobalVariants(home)[0].origins.length, 2)
})
