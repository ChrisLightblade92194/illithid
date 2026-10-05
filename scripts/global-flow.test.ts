/**
 * Checkpoint after Task 6 — the whole engine path on one synthetic profile (spec 2026-10-04 §6–§10):
 * import → variants/conflicts → preview → apply → second sync → local edit → restore.
 * Synthetic profile only; file equality here says nothing about what the tools load.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalPaths, type GlobalTool } from '../src/engine/globalPaths'
import {
  importGlobalItems,
  importLocalChange,
  listGlobalImportables
} from '../src/engine/globalImport'
import {
  listGlobalVariants,
  mergeGlobalVariants,
  readDeliveries,
  readGlobalChoices,
  type DeliveryChoice,
  type VariantRecord
} from '../src/engine/globalVariants'
import { defaultDestination, readDestination } from '../src/engine/globalDestinations'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import { applyGlobalRestore, planGlobalRestore } from '../src/engine/globalRestore'
import { contentSnapshot, put, snapshot, syntheticHome } from './lib/globalFixture'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))
const contentTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, contentSnapshot(join(home, d))]))

test('checkpoint: import → variants/conflicts → preview → apply → second sync → local edit → restore', () => {
  const home = syntheticHome()
  const pdfClaude = {
    'SKILL.md': '---\nname: pdf\ndescription: d\n---\nclaude pdf\n',
    'scripts/x.py': 'print(1)\r\n'
  }
  put(home, '.claude/CLAUDE.md', 'claude global\r\n')
  put(home, '.claude/rules/style.md', '# style\n')
  for (const [f, b] of Object.entries(pdfClaude)) put(home, `.claude/skills/pdf/${f}`, b)
  put(home, '.codex/AGENTS.md', 'codex global\n')
  put(home, '.codex/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: d\n---\ncodex pdf\n')
  put(home, '.config/opencode/AGENTS.md', 'opencode global')
  for (const [f, b] of Object.entries(pdfClaude)) put(home, `.config/opencode/skills/pdf/${f}`, b)
  const original = snapTools(home)
  const originalContent = contentTools(home)

  // 1. Paths and selective import: originals untouched
  const paths = resolveGlobalPaths(home, {}, {})
  assert.deepEqual(
    paths.map((p) => p.status),
    ['resolved', 'resolved', 'resolved']
  )
  const root = Object.fromEntries(paths.map((p) => [p.tool, p.paths[0]])) as Record<
    GlobalTool,
    string
  >
  const listing = listGlobalImportables(home, paths)
  assert.deepEqual(listing.errors, [])
  assert.equal(listing.items.length, 7)
  const selected = listing.items.filter((i) => !(i.tool === 'opencode' && i.kind === 'rule'))
  const imported = importGlobalItems(home, selected, paths)
  assert.deepEqual(imported.errors, [])
  assert.equal(imported.items.length, 6)
  assert.deepEqual(snapTools(home), original)

  // 2. Same-name variants kept apart; identical content only suggested for merging; no decision inferred
  let pdfs = listGlobalVariants(home).filter((v) => v.name === 'pdf')
  assert.equal(pdfs.length, 3)
  const byTool = (t: GlobalTool): VariantRecord =>
    pdfs.find((v) => v.origins.some((o) => o.tool === t))!
  assert.deepEqual(byTool('claude').sameContentAs, [byTool('opencode').id])
  assert.deepEqual(byTool('codex').sameContentAs, [])
  assert.deepEqual(readGlobalChoices(home), [])
  const merged = mergeGlobalVariants(
    home,
    [byTool('claude').id, byTool('opencode').id],
    byTool('claude').revision
  )
  assert.equal(merged.ok, true)
  pdfs = listGlobalVariants(home).filter((v) => v.name === 'pdf')
  assert.equal(pdfs.length, 2)
  const shared = pdfs.find((v) => v.origins.length === 2)!
  const codexPdf = pdfs.find((v) => v.origins.length === 1)!
  const style = listGlobalVariants(home).find((v) => v.name === 'style.md')!

  // 3. Choices: a different pdf variant per tool, one rule for two tools; existing originals need a decision
  const ch = (
    v: VariantRecord,
    tool: GlobalTool,
    dest: string,
    expected: string | null = null
  ): DeliveryChoice => ({
    variantId: v.id,
    variantRevision: v.revision,
    tool,
    destination: dest,
    expectedDestinationDigest: expected
  })
  const pdfDest = (t: GlobalTool): string => defaultDestination(root[t], t, 'skill', 'pdf')
  const undecided = planGlobalSync(home, [ch(shared, 'claude', pdfDest('claude'))], { paths })
  assert.deepEqual(undecided.changes, [])
  assert.deepEqual(
    undecided.conflicts.map((c) => c.type),
    ['unmanagedDestination']
  )
  const shown = (t: GlobalTool): string => readDestination(pdfDest(t), 'skill').digest!
  const choices = [
    ch(shared, 'claude', pdfDest('claude'), shown('claude')),
    ch(shared, 'opencode', pdfDest('opencode'), shown('opencode')),
    ch(codexPdf, 'codex', pdfDest('codex'), shown('codex')),
    ch(style, 'codex', defaultDestination(root.codex, 'codex', 'rule', 'style.md')),
    ch(style, 'opencode', defaultDestination(root.opencode, 'opencode', 'rule', 'style.md'))
  ]

  // 4. Preview: read-only, describes the writes
  const preview = planGlobalSync(home, choices, { paths })
  assert.deepEqual(snapTools(home), original)
  assert.deepEqual(preview.conflicts, [])
  assert.deepEqual(preview.excluded, [])
  assert.deepEqual(
    preview.changes.map((c) => c.op),
    ['adopt', 'adopt', 'adopt', 'create', 'create']
  )

  // 5. Apply
  const applied = applyGlobalSync(home, preview)
  assert.equal(applied.status, 'completed')
  assert.equal(
    readFileSync(join(root.codex, 'AGENTS.md'), 'utf8'),
    'codex global\n\n<!-- BEGIN illithid-global: style.md -->\n# style\n<!-- END illithid-global: style.md -->\n'
  )
  assert.ok(
    readFileSync(join(root.opencode, 'AGENTS.md'), 'utf8').startsWith(
      'opencode global\n\n<!-- BEGIN'
    )
  )
  assert.equal(readDeliveries(home).length, 5)
  assert.deepEqual(contentSnapshot(join(home, '.claude')), originalContent['.claude'])

  // 6. Second sync without changes rewrites nothing
  const settled = snapTools(home)
  const again = planGlobalSync(
    home,
    choices.map((c) => ({ ...c, expectedDestinationDigest: null })),
    { paths }
  )
  assert.deepEqual(
    again.changes.map((c) => c.op),
    ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']
  )
  assert.equal(applyGlobalSync(home, again).status, 'completed')
  assert.deepEqual(snapTools(home), settled)

  // 7. A local edit to a delivered section is a conflict and stays until the user decides
  const codexSection = defaultDestination(root.codex, 'codex', 'rule', 'style.md')
  writeFileSync(
    join(root.codex, 'AGENTS.md'),
    readFileSync(join(root.codex, 'AGENTS.md'), 'utf8').replace(
      '# style\n',
      '# style, edited in Codex\n'
    )
  )
  const afterEdit = planGlobalSync(
    home,
    again.changes.map((c) => c.choice),
    { paths }
  )
  assert.deepEqual(
    afterEdit.conflicts.map((c) => [c.type, c.destination]),
    [['destinationChanged', codexSection]]
  )
  assert.equal(afterEdit.changes.length, 4)
  const kept = importLocalChange(
    home,
    'codex',
    codexSection,
    'rule',
    readDestination(codexSection, 'rule').digest!
  )
  assert.equal(kept.ok, true)
  assert.equal(listGlobalVariants(home).filter((v) => v.name === 'style.md').length, 2)

  // 8. Restore of the apply: its own preview; the edited destination is not overwritten without a decision
  const restore = planGlobalRestore(home, applied.operationId, { paths })
  assert.deepEqual(
    restore.conflicts.map((c) => c.destination),
    [codexSection]
  )
  assert.deepEqual(
    restore.changes.map((c) => c.op),
    ['remove']
  )
  assert.equal(applyGlobalRestore(home, restore).status, 'completed')
  assert.equal(readFileSync(join(root.opencode, 'AGENTS.md'), 'utf8'), 'opencode global')
  assert.ok(
    readFileSync(join(root.codex, 'AGENTS.md'), 'utf8').includes('# style, edited in Codex\n')
  )
  // Originals of all three tools are still there, byte for byte
  for (const d of ['.claude', '.config/opencode'] as const)
    assert.deepEqual(contentSnapshot(join(home, d)), originalContent[d], d)
  assert.equal(existsSync(join(home, '.config/illithid/state.json')), false)
})
