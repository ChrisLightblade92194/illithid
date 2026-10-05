/**
 * Task 7 (engine side of the UI) — confirmed paths, recipient states and backend-computed choices
 * (spec 2026-10-04 §3, §6, §7, §11). Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { confirmGlobalPath, effectiveGlobalPaths, globalPathsView } from '../src/engine/globalPaths'
import { importGlobalItems, listGlobalImportables } from '../src/engine/globalImport'
import { readGlobalChoices } from '../src/engine/globalVariants'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import {
  acceptRecipient,
  globalLibraryView,
  inspectRecipient,
  leaveUnmanaged,
  setRecipient
} from '../src/engine/globalView'
import { put, snapshot, syntheticHome } from './lib/globalFixture'

const env = {}

function confirmAll(home: string): void {
  for (const p of globalPathsView(home, env))
    if (p.detected.status === 'resolved') confirmGlobalPath(home, p.tool, p.detected.paths[0])
}

test('paths must be confirmed before they are used; a confirmation can be withdrawn', () => {
  const home = syntheticHome()
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  assert.deepEqual(
    effectiveGlobalPaths(home, env).map((p) => [p.tool, p.status, p.reason]),
    [
      ['claude', 'unavailable', 'notConfirmed'],
      ['codex', 'unavailable', 'notConfirmed'],
      ['opencode', 'unavailable', 'notFound']
    ]
  )
  assert.deepEqual(confirmGlobalPath(home, 'claude', join(home, 'missing')), {
    ok: false,
    code: 'notADirectory'
  })
  assert.deepEqual(confirmGlobalPath(home, 'claude', join(home, '.claude')), { ok: true })
  assert.deepEqual(effectiveGlobalPaths(home, env)[0], {
    tool: 'claude',
    paths: [join(home, '.claude')],
    status: 'resolved'
  })
  assert.equal(globalPathsView(home, env)[0].confirmed, join(home, '.claude'))
  assert.deepEqual(confirmGlobalPath(home, 'claude', null), { ok: true })
  assert.equal(effectiveGlobalPaths(home, env)[0].status, 'unavailable')
  // A confirmed folder that disappears stops being used
  confirmGlobalPath(home, 'codex', join(home, '.codex'))
  rmSync(join(home, '.codex'), { recursive: true })
  assert.deepEqual(effectiveGlobalPaths(home, env)[1].reason, 'overrideMissing')
})

test('recipients: unmanaged by default; the backend computes destinations; states follow the plan', () => {
  const home = syntheticHome()
  put(home, '.claude/skills/pdf/SKILL.md', '---\nname: pdf\n---\nclaude\n')
  put(home, '.codex/skills/pdf/SKILL.md', '---\nname: pdf\n---\ncodex\n')
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  confirmAll(home)
  const paths = effectiveGlobalPaths(home, env)
  importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  let view = globalLibraryView(home, env)
  const group = view.groups.find((g) => g.kind === 'skill' && g.name === 'pdf')!
  assert.equal(group.variantIds.length, 2)
  assert.deepEqual(
    group.recipients.map((r) => [r.tool, r.status]),
    [
      ['claude', 'unmanaged'],
      ['codex', 'unmanaged'],
      ['opencode', 'unmanaged']
    ]
  )
  const claudeVariant = view.variants.find((v) => v.origins[0].tool === 'claude')!
  const codexVariant = view.variants.find((v) => v.origins[0].tool === 'codex')!
  const before = snapshot(home)
  setRecipient(
    home,
    { kind: 'skill', name: 'pdf', tool: 'opencode', variantId: claudeVariant.id },
    env
  )
  setRecipient(home, { kind: 'skill', name: 'pdf', tool: 'codex', variantId: codexVariant.id }, env)
  view = globalLibraryView(home, env)
  const rec = (tool: string): (typeof group.recipients)[number] =>
    view.groups.find((g) => g.name === 'pdf')!.recipients.find((r) => r.tool === tool)!
  assert.equal(rec('opencode').status, 'toApply')
  assert.equal(rec('opencode').destination, join(home, '.config/opencode/skills/pdf'))
  assert.equal(rec('codex').status, 'conflict')
  assert.equal(rec('codex').conflict?.type, 'unmanagedDestination')
  // Inspecting a conflict shows both contents, bound to the digest the decision will carry
  const seen = inspectRecipient(home, { kind: 'skill', name: 'pdf', tool: 'codex' })
  assert.match(seen.destination.text ?? '', /codex/)
  assert.match(seen.variant.text ?? '', /codex/)
  assert.deepEqual(
    acceptRecipient(home, {
      kind: 'skill',
      name: 'pdf',
      tool: 'codex',
      expectedDestinationDigest: 'stale'
    }),
    { ok: false, code: 'changedSinceCheck' }
  )
  assert.deepEqual(
    acceptRecipient(home, {
      kind: 'skill',
      name: 'pdf',
      tool: 'codex',
      expectedDestinationDigest: seen.destination.digest
    }),
    { ok: true }
  )
  assert.equal(globalLibraryView(home, env).groups[0].recipients[1].status, 'toApply')
  // Choosing never writes a tool folder (only the global state changes)
  const after = snapshot(home)
  for (const k of Object.keys(before).filter((k) => !k.includes('.config/illithid')))
    assert.equal(after[k], before[k], k)
  // Applied → synced; leaving unmanaged drops the choice and the delivery, files stay
  const plan = planGlobalSync(home, readGlobalChoices(home), {
    paths: effectiveGlobalPaths(home, env)
  })
  assert.equal(applyGlobalSync(home, plan).status, 'completed')
  assert.equal(globalLibraryView(home, env).groups[0].recipients[2].status, 'synced')
  const files = snapshot(join(home, '.config/opencode'))
  assert.deepEqual(leaveUnmanaged(home, { kind: 'skill', name: 'pdf', tool: 'opencode' }), {
    ok: true
  })
  assert.equal(globalLibraryView(home, env).groups[0].recipients[2].status, 'unmanaged')
  assert.deepEqual(snapshot(join(home, '.config/opencode')), files)
})

test('an unsupported delivery is shown as such, with its reason', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/inc.md', 'See @~/notes/x.md\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  confirmAll(home)
  const paths = effectiveGlobalPaths(home, env)
  importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  const v = globalLibraryView(home, env).variants[0]
  setRecipient(home, { kind: 'rule', name: 'inc.md', tool: 'codex', variantId: v.id }, env)
  const r = globalLibraryView(home, env).groups[0].recipients.find((x) => x.tool === 'codex')!
  assert.deepEqual([r.status, r.reason], ['unsupported', 'includeNotSupported'])
})

test('a variant chosen for the tool it came from targets its original file, not a second copy', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/style.md', '# style\n')
  put(home, '.codex/AGENTS.md', 'codex text\n')
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  confirmAll(home)
  const paths = effectiveGlobalPaths(home, env)
  importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  const vs = globalLibraryView(home, env).variants
  const style = vs.find((v) => v.name === 'style.md')!
  const agents = vs.find((v) => v.name === 'AGENTS.md')!
  setRecipient(home, { kind: 'rule', name: 'style.md', tool: 'claude', variantId: style.id }, env)
  setRecipient(home, { kind: 'rule', name: 'AGENTS.md', tool: 'codex', variantId: agents.id }, env)
  setRecipient(home, { kind: 'rule', name: 'style.md', tool: 'codex', variantId: style.id }, env)
  const view = globalLibraryView(home, env)
  const rec = (name: string, tool: string): (typeof view.groups)[number]['recipients'][number] =>
    view.groups.find((g) => g.name === name)!.recipients.find((r) => r.tool === tool)!
  assert.equal(rec('style.md', 'claude').destination, join(home, '.claude/rules/style.md'))
  assert.equal(rec('AGENTS.md', 'codex').destination, join(home, '.codex/AGENTS.md'))
  // Another tool still gets the native default form
  assert.equal(rec('style.md', 'codex').destination, join(home, '.codex/AGENTS.md') + '::style.md')
  // The original is unmanaged until the user decides; identical content is then adopted without a write
  assert.equal(rec('style.md', 'claude').status, 'conflict')
  const seen = inspectRecipient(home, { kind: 'rule', name: 'style.md', tool: 'claude' })
  acceptRecipient(home, {
    kind: 'rule',
    name: 'style.md',
    tool: 'claude',
    expectedDestinationDigest: seen.destination.digest
  })
  const after = globalLibraryView(home, env).groups.find((g) => g.name === 'style.md')!
    .recipients[0]
  assert.deepEqual([after.status, after.op], ['toApply', 'adopt'])
})
