/**
 * Task 3 — variants, conflicts and decisions bound to revisions and destinations (spec 2026-10-04 §5, §7;
 * §12 criteria 3, 4, 11). Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { globalLibraryDir, resolveGlobalPaths, type GlobalTool } from '../src/engine/globalPaths'
import {
  importGlobalItems,
  importLocalChange,
  listGlobalImportables
} from '../src/engine/globalImport'
import {
  listGlobalVariants,
  mergeGlobalVariants,
  readGlobalChoices,
  renameGlobalVariant,
  writeDeliveries,
  writeGlobalChoices,
  choiceValidity,
  forgetDelivery,
  readDeliveries,
  type DeliveryChoice,
  type VariantRecord
} from '../src/engine/globalVariants'
import { detectGlobalConflicts } from '../src/engine/globalConflicts'
import { defaultDestination, readDestination } from '../src/engine/globalDestinations'
import { put, snapshot, syntheticHome } from './lib/globalFixture'

function importAll(home: string): VariantRecord[] {
  const paths = resolveGlobalPaths(home, {}, {})
  const r = importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  assert.deepEqual(r.errors, [])
  return listGlobalVariants(home)
}

const root = (home: string, tool: GlobalTool): string =>
  resolveGlobalPaths(home, {}, {}).find((p) => p.tool === tool)!.paths[0]

function choice(
  v: VariantRecord,
  tool: GlobalTool,
  destination: string,
  expectedDestinationDigest: string | null = null
): DeliveryChoice {
  return {
    variantId: v.id,
    variantRevision: v.revision,
    tool,
    destination,
    expectedDestinationDigest
  }
}

test('same_name_different_content_keeps_both', () => {
  const home = syntheticHome()
  put(home, '.codex/AGENTS.md', 'codex text\n')
  put(home, '.config/opencode/AGENTS.md', 'opencode text\n')
  const records = importAll(home)
  assert.equal(records.length, 2)
  assert.notEqual(records[0].id, records[1].id)
  assert.deepEqual(
    records.map((r) => r.name),
    ['AGENTS.md', 'AGENTS.md']
  )
  assert.deepEqual(records.map((r) => r.origins.map((o) => o.tool)).sort(), [
    ['codex'],
    ['opencode']
  ])
  assert.notEqual(records[0].revision, records[1].revision)
  // No decision is inferred from name, date or order
  assert.deepEqual(readGlobalChoices(home), [])
})

test('same_name_same_content_requires_merge_choice', () => {
  const home = syntheticHome()
  put(home, '.codex/AGENTS.md', 'same\n')
  put(home, '.config/opencode/AGENTS.md', 'same\n')
  put(home, '.claude/rules/AGENTS.md', 'other\n')
  const records = importAll(home)
  assert.equal(records.length, 3)
  const same = records.filter((r) => r.origins[0].tool !== 'claude')
  assert.deepEqual(same[0].sameContentAs, [same[1].id])
  assert.deepEqual(same[1].sameContentAs, [same[0].id])
  const other = records.find((r) => r.origins[0].tool === 'claude')!
  assert.deepEqual(mergeGlobalVariants(home, [same[0].id, other.id], same[0].revision), {
    ok: false,
    code: 'contentDiffers'
  })
  assert.deepEqual(mergeGlobalVariants(home, [same[0].id, same[1].id], 'stale'), {
    ok: false,
    code: 'changedSinceCheck'
  })
  assert.equal(listGlobalVariants(home).length, 3)
  const merged = mergeGlobalVariants(home, [same[0].id, same[1].id], same[0].revision)
  assert.deepEqual(merged, { ok: true, id: same[0].id })
  const after = listGlobalVariants(home)
  assert.equal(after.length, 2)
  const kept = after.find((r) => r.id === same[0].id)!
  assert.deepEqual(kept.origins.map((o) => o.tool).sort(), ['codex', 'opencode'])
  assert.equal(readFileSync(kept.contentPath, 'utf8'), 'same\n')
})

test('case_collision_blocks_destination: Skill and skill, or an existing differently-cased folder', () => {
  const home = syntheticHome()
  put(home, '.claude/skills/Skill/SKILL.md', '---\nname: Skill\n---\nA\n')
  put(home, '.codex/skills/skill/SKILL.md', '---\nname: skill\n---\nB\n')
  put(home, '.codex/skills/report/SKILL.md', '---\nname: report\n---\nR\n')
  mkdirSync(join(home, '.claude/skills/Report'))
  const records = importAll(home)
  const a = records.find((r) => r.name === 'Skill')!
  const b = records.find((r) => r.name === 'skill')!
  const rep = records.find((r) => r.name === 'report')!
  const claudeRoot = root(home, 'claude')
  const before = snapshot(join(claudeRoot, 'skills'))
  const conflicts = detectGlobalConflicts(home, [
    choice(
      a,
      'claude',
      join(claudeRoot, 'skills/Skill'),
      readDestination(join(claudeRoot, 'skills/Skill'), 'skill').digest
    ),
    choice(b, 'claude', join(claudeRoot, 'skills/skill')),
    choice(rep, 'claude', join(claudeRoot, 'skills/report'))
  ])
  const collisions = conflicts.filter((c) => c.type === 'nameCollision')
  assert.deepEqual(
    collisions.map((c) => c.destination).sort(),
    [
      join(claudeRoot, 'skills/Skill'),
      join(claudeRoot, 'skills/report'),
      join(claudeRoot, 'skills/skill')
    ].sort()
  )
  assert.deepEqual(snapshot(join(claudeRoot, 'skills')), before)
})

test('different variants per tool and one variant for several tools: no conflict, choices round-trip', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/AGENTS.md', 'claude flavour\n')
  put(home, '.codex/AGENTS.md', 'codex flavour\n')
  put(home, '.config/opencode/skills/shared/SKILL.md', '---\nname: shared\n---\n')
  const records = importAll(home)
  const cl = records.find((r) => r.origins[0].tool === 'claude')!
  const cx = records.find((r) => r.origins[0].tool === 'codex')!
  const sk = records.find((r) => r.kind === 'skill')!
  const choices = [
    choice(cl, 'claude', defaultDestination(root(home, 'claude'), 'claude', 'rule', cl.name)),
    choice(cx, 'codex', defaultDestination(root(home, 'codex'), 'codex', 'rule', 'AGENTS.md')),
    choice(cl, 'opencode', defaultDestination(root(home, 'opencode'), 'opencode', 'rule', cl.name)),
    choice(sk, 'claude', defaultDestination(root(home, 'claude'), 'claude', 'skill', 'shared')),
    choice(sk, 'codex', defaultDestination(root(home, 'codex'), 'codex', 'skill', 'shared'))
  ]
  // the OpenCode skill destination already holds the original (unmanaged): shown, not assigned here
  assert.deepEqual(detectGlobalConflicts(home, choices), [])
  writeGlobalChoices(home, choices)
  assert.deepEqual(readGlobalChoices(home), choices)
  assert.deepEqual(
    choiceValidity(home, choices).map((x) => x.status),
    ['valid', 'valid', 'valid', 'valid', 'valid']
  )
})

test('two different variants at one destination conflict (variantsDiffer)', () => {
  const home = syntheticHome()
  put(home, '.codex/AGENTS.md', 'one\n')
  put(home, '.config/opencode/AGENTS.md', 'two\n')
  const [x, y] = importAll(home)
  const dest = defaultDestination(root(home, 'codex'), 'codex', 'rule', 'AGENTS.md')
  const c = detectGlobalConflicts(home, [choice(x, 'codex', dest), choice(y, 'codex', dest)])
  assert.deepEqual(
    c.map((k) => [k.type, k.variantIds.sort()]),
    [['variantsDiffer', [x.id, y.id].sort()]]
  )
})

test('an existing unmanaged destination needs a decision bound to the content shown', () => {
  const home = syntheticHome()
  put(home, '.codex/skills/tool/SKILL.md', '---\nname: tool\n---\nlibrary\n')
  const [v] = importAll(home)
  const dest = put(home, '.claude/skills/tool/SKILL.md', '---\nname: tool\n---\nuser copy\n')
  const destDir = join(root(home, 'claude'), 'skills/tool')
  const blocked = detectGlobalConflicts(home, [choice(v, 'claude', destDir)])
  assert.deepEqual(
    blocked.map((c) => c.type),
    ['unmanagedDestination']
  )
  const shown = readDestination(destDir, 'skill').digest
  assert.ok(shown)
  assert.deepEqual(detectGlobalConflicts(home, [choice(v, 'claude', destDir, shown)]), [])
  // The destination changes after the user saw it: the decision no longer applies
  writeFileSync(dest, '---\nname: tool\n---\nedited again\n')
  const stale = detectGlobalConflicts(home, [choice(v, 'claude', destDir, shown)])
  assert.deepEqual(
    stale.map((c) => c.type),
    ['destinationChanged']
  )
})

test('a managed destination edited since the last delivery conflicts until a decision on the new content', () => {
  const home = syntheticHome()
  put(home, '.codex/rules-src.md', 'unused')
  put(home, '.claude/rules/r.md', 'library rule\n')
  const [v] = importAll(home)
  const dest = defaultDestination(root(home, 'codex'), 'codex', 'rule', 'r.md')
  put(
    home,
    '.codex/AGENTS.md',
    `user intro\n<!-- BEGIN illithid-global: r.md -->\nlibrary rule\n<!-- END illithid-global: r.md -->\nuser outro\n`
  )
  const delivered = readDestination(dest, 'rule').digest
  writeDeliveries(home, [
    {
      destination: dest,
      tool: 'codex',
      kind: 'rule',
      variantId: v.id,
      variantRevision: v.revision,
      deliveredDigest: delivered!,
      at: new Date().toISOString(),
      operationId: 'op-test'
    }
  ])
  assert.deepEqual(detectGlobalConflicts(home, [choice(v, 'codex', dest)]), [])
  writeFileSync(
    join(home, '.codex/AGENTS.md'),
    `user intro\n<!-- BEGIN illithid-global: r.md -->\nlocal edit\n<!-- END illithid-global: r.md -->\nuser outro\n`
  )
  const c = detectGlobalConflicts(home, [choice(v, 'codex', dest)])
  assert.deepEqual(
    c.map((k) => k.type),
    ['destinationChanged']
  )
  assert.equal(c[0].digests.delivered, delivered)
  const now = readDestination(dest, 'rule').digest
  assert.deepEqual(detectGlobalConflicts(home, [choice(v, 'codex', dest, now)]), [])
})

test('a decision is invalidated when the variant revision changes', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/r.md', 'v1\n')
  const [v] = importAll(home)
  const c = choice(v, 'codex', defaultDestination(root(home, 'claude'), 'claude', 'rule', 'r.md'))
  assert.deepEqual(
    choiceValidity(home, [c]).map((x) => x.status),
    ['valid']
  )
  writeFileSync(v.contentPath, 'v2\n')
  assert.deepEqual(
    choiceValidity(home, [c]).map((x) => x.status),
    ['staleRevision']
  )
  assert.deepEqual(
    choiceValidity(home, [{ ...c, variantId: 'rule-missing' }]).map((x) => x.status),
    ['unknownVariant']
  )
})

test('renaming a variant changes no content, frontmatter or reference', () => {
  const home = syntheticHome()
  const body = '---\nname: report\ndescription: d\n---\nSee [x](ref/x.md)\n'
  put(home, '.claude/skills/report/SKILL.md', body)
  put(home, '.claude/skills/report/ref/x.md', 'x')
  const [v] = importAll(home)
  assert.deepEqual(renameGlobalVariant(home, v.id, 'report v2'), { ok: true })
  const [after] = listGlobalVariants(home)
  assert.equal(after.name, 'report v2')
  assert.equal(after.revision, v.revision)
  assert.equal(readFileSync(join(after.contentPath, 'SKILL.md'), 'utf8'), body)
  assert.deepEqual(renameGlobalVariant(home, v.id, '../escape'), { ok: false, code: 'invalidName' })
  for (const bad of ['a\u0001b', 'con', 'trailing.', 'a:b'])
    assert.deepEqual(renameGlobalVariant(home, v.id, bad), { ok: false, code: 'invalidName' }, bad)
})

test('a link or a malformed managed section at the destination is never treated as writable', () => {
  const home = syntheticHome()
  put(home, '.codex/skills/s/SKILL.md', '---\nname: s\n---\n')
  put(home, '.claude/rules/r.md', 'rule\n')
  const records = importAll(home)
  const s = records.find((r) => r.kind === 'skill')!
  const r = records.find((x) => x.kind === 'rule')!
  const target = join(home, 'elsewhere')
  mkdirSync(target)
  mkdirSync(join(root(home, 'claude'), 'skills'), { recursive: true })
  const linkDest = join(root(home, 'claude'), 'skills/s')
  symlinkSync(target, linkDest, 'junction')
  const linkState = readDestination(linkDest, 'skill')
  const c1 = detectGlobalConflicts(home, [choice(s, 'claude', linkDest, linkState.digest)])
  assert.deepEqual(
    c1.map((c) => [c.type, c.reason]),
    [['unmanagedDestination', 'link']]
  )
  put(home, '.codex/AGENTS.md', '<!-- BEGIN illithid-global: r.md -->\nno end marker\n')
  const sec = defaultDestination(root(home, 'codex'), 'codex', 'rule', 'r.md')
  const c2 = detectGlobalConflicts(home, [
    choice(r, 'codex', sec, readDestination(sec, 'rule').digest)
  ])
  assert.deepEqual(
    c2.map((c) => [c.type, c.reason]),
    [['unmanagedDestination', 'malformedSection']]
  )
  assert.equal(existsSync(join(target, 'SKILL.md')), false)
  assert.equal(readdirSync(globalLibraryDir(home)).length, 2)
})

test('a local edit at a managed destination can become a new variant; the destination stays as it is', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/r.md', 'library\n')
  const [v] = importAll(home)
  mkdirSync(join(home, '.codex'), { recursive: true })
  const sec = defaultDestination(join(home, '.codex'), 'codex', 'rule', 'r.md')
  put(
    home,
    '.codex/AGENTS.md',
    'intro\n<!-- BEGIN illithid-global: r.md -->\nlocal edit\n<!-- END illithid-global: r.md -->\n'
  )
  writeDeliveries(home, [
    {
      destination: sec,
      tool: 'codex',
      kind: 'rule',
      variantId: v.id,
      variantRevision: v.revision,
      deliveredDigest: 'delivered-before-the-edit',
      at: '2026-10-04T00:00:00.000Z',
      operationId: 'op-x'
    }
  ])
  const before = snapshot(join(home, '.codex'))
  const shown = readDestination(sec, 'rule').digest!
  assert.deepEqual(importLocalChange(home, 'codex', sec, 'rule', 'stale'), {
    ok: false,
    code: 'changedSinceCheck'
  })
  const r = importLocalChange(home, 'codex', sec, 'rule', shown)
  assert.ok(r.ok)
  const nv = listGlobalVariants(home).find((x) => x.id === (r.ok ? r.item.id : ''))!
  assert.equal(readFileSync(nv.contentPath, 'utf8'), 'local edit\n')
  assert.equal(nv.name, 'r.md')
  assert.deepEqual(
    nv.origins.map((o) => [o.tool, o.path]),
    [['codex', sec]]
  )
  assert.deepEqual(snapshot(join(home, '.codex')), before)
  // Choosing the new variant for that destination, bound to the content shown, clears the conflict
  assert.deepEqual(
    detectGlobalConflicts(home, [choice(v, 'codex', sec)]).map((c) => c.type),
    ['destinationChanged']
  )
  assert.deepEqual(detectGlobalConflicts(home, [choice(nv, 'codex', sec, shown)]), [])
})

test('leaving a destination unmanaged forgets the delivery and touches no file', () => {
  const home = syntheticHome()
  put(home, '.claude/skills/s/SKILL.md', '---\nname: s\n---\n')
  const [v] = importAll(home)
  const dest = join(root(home, 'claude'), 'skills/s')
  writeDeliveries(home, [
    {
      destination: dest,
      tool: 'claude',
      kind: 'skill',
      variantId: v.id,
      variantRevision: v.revision,
      deliveredDigest: readDestination(dest, 'skill').digest!,
      at: '2026-10-04T00:00:00.000Z',
      operationId: 'op-x'
    }
  ])
  const before = snapshot(join(home, '.claude'))
  assert.deepEqual(forgetDelivery(home, dest), { ok: true })
  assert.deepEqual(readDeliveries(home), [])
  assert.deepEqual(snapshot(join(home, '.claude')), before)
  assert.deepEqual(
    detectGlobalConflicts(home, [choice(v, 'claude', dest)]).map((c) => c.type),
    ['unmanagedDestination']
  )
  assert.deepEqual(forgetDelivery(home, dest), { ok: false, code: 'notManaged' })
})

test('review F5: a refused local-change import leaves no provisional folder in the library', () => {
  const home = syntheticHome()
  put(home, '.codex/skills/s/SKILL.md', '---\nname: s\n---\n')
  importAll(home)
  const libBefore = readdirSync(globalLibraryDir(home)).sort()
  // The tool copy of the skill now holds a junction to a folder outside it
  const dest = join(root(home, 'codex'), 'skills/s')
  const outside = join(home, 'outside')
  put(outside, 'x.md', 'x\n')
  symlinkSync(outside, join(dest, 'linked'), 'junction')
  const shown = readDestination(dest, 'skill').digest!
  const r = importLocalChange(home, 'codex', dest, 'skill', shown)
  assert.deepEqual(r, { ok: false, code: 'externalLink' })
  assert.deepEqual(readdirSync(globalLibraryDir(home)).sort(), libBefore)
  // A section that disappears before the copy is refused the same way, without leftovers
  put(
    home,
    '.codex/AGENTS.md',
    '<!-- BEGIN illithid-global: r.md -->\nbody\n<!-- END illithid-global: r.md -->\n'
  )
  const sec = defaultDestination(root(home, 'codex'), 'codex', 'rule', 'r.md')
  assert.deepEqual(importLocalChange(home, 'codex', sec, 'rule', 'not-the-shown-digest'), {
    ok: false,
    code: 'changedSinceCheck'
  })
  assert.deepEqual(readdirSync(globalLibraryDir(home)).sort(), libBefore)
})
