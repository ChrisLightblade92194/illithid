/**
 * Task 4 — native delivery forms and a read-only plan (spec 2026-10-04 §6, §8, §9; §12 criteria 4, 5, 8).
 * Synthetic profiles only. File equality shown by the plan does not prove that a tool loads the instructions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalPaths, globalStateDir, type GlobalTool } from '../src/engine/globalPaths'
import {
  listGlobalVariants,
  writeDeliveries,
  type DeliveryChoice
} from '../src/engine/globalVariants'
import {
  defaultDestination,
  readDestination,
  sectionDestination
} from '../src/engine/globalDestinations'
import { planGlobalSync, type GlobalSyncPlan } from '../src/engine/globalManualSync'
import { put, seedVariants, snapshot, syntheticHome } from './lib/globalFixture'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))

function toolHome(home: string): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
}
const roots = (home: string): Record<GlobalTool, string> =>
  Object.fromEntries(resolveGlobalPaths(home, {}, {}).map((p) => [p.tool, p.paths[0]])) as Record<
    GlobalTool,
    string
  >

function pick(home: string, name: string, tool?: GlobalTool): { id: string; revision: string } {
  const v = listGlobalVariants(home).find(
    (x) => x.name === name && (!tool || x.origins[0].tool === tool)
  )
  assert.ok(v, `variant ${name}`)
  return v
}
function ch(
  v: { id: string; revision: string },
  tool: GlobalTool,
  destination: string,
  expected: string | null = null
): DeliveryChoice {
  return {
    variantId: v.id,
    variantRevision: v.revision,
    tool,
    destination,
    expectedDestinationDigest: expected
  }
}
const plan = (home: string, choices: DeliveryChoice[]): GlobalSyncPlan =>
  planGlobalSync(home, choices, { paths: resolveGlobalPaths(home, {}, {}) })

test('plan_is_read_only: tool folders keep every byte and mtime; the plan is stored by the backend', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, {
    'rules/style.md': '# style\n',
    'skills/report/SKILL.md': '---\nname: report\n---\n',
    'skills/report/data.bin': Buffer.from([0, 1, 2])
  })
  put(home, '.codex/AGENTS.md', 'user codex text\n')
  put(home, '.claude/skills/report/SKILL.md', 'user copy\n')
  const r = roots(home)
  const style = pick(home, 'style.md')
  const report = pick(home, 'report')
  const shown = readDestination(join(r.claude, 'skills/report'), 'skill').digest
  const before = snapTools(home)
  const p = plan(home, [
    ch(style, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'style.md')),
    ch(style, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'style.md')),
    ch(style, 'opencode', defaultDestination(r.opencode, 'opencode', 'rule', 'style.md')),
    ch(report, 'claude', join(r.claude, 'skills/report'), shown),
    ch(report, 'codex', join(r.codex, 'skills/report'))
  ])
  assert.deepEqual(snapTools(home), before)
  assert.deepEqual(
    p.changes.map((c) => [c.tool, c.kind, c.op]),
    [
      ['claude', 'rule', 'create'],
      ['codex', 'rule', 'create'],
      ['opencode', 'rule', 'create'],
      ['claude', 'skill', 'replace'],
      ['codex', 'skill', 'create']
    ]
  )
  assert.deepEqual(p.conflicts, [])
  assert.ok(existsSync(join(globalStateDir(home), 'plans', `${p.id}.json`)))
})

test('plan_preserves_unmanaged_regions: the planned file keeps all text outside the managed section', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, { 'rules/a.md': 'rule A v2\n', 'rules/b.md': 'rule B\n' })
  const r = roots(home)
  const file = join(r.codex, 'AGENTS.md')
  const head = 'User intro ü\r\nkeep CRLF\r\n\r\n'
  const mid = '\nuser middle text\n'
  const tail = 'user tail without final newline'
  put(
    home,
    '.codex/AGENTS.md',
    `${head}<!-- BEGIN illithid-global: a.md -->\nrule A v1\n<!-- END illithid-global: a.md -->\n${mid}${tail}`
  )
  const a = pick(home, 'a.md')
  const b = pick(home, 'b.md')
  const destA = sectionDestination(file, 'a.md')
  writeDeliveries(home, [
    {
      destination: destA,
      tool: 'codex',
      kind: 'rule',
      variantId: a.id,
      variantRevision: 'old',
      deliveredDigest: readDestination(destA, 'rule').digest!,
      at: '2026-10-04T00:00:00.000Z',
      operationId: 'op-old'
    }
  ])
  const p = plan(home, [ch(a, 'codex', destA), ch(b, 'codex', sectionDestination(file, 'b.md'))])
  assert.deepEqual(p.conflicts, [])
  const [ca, cb] = p.changes
  assert.deepEqual([ca.op, cb.op], ['update', 'create'])
  assert.equal(ca.preview.before, 'rule A v1\n')
  assert.equal(ca.preview.after, 'rule A v2\n')
  const afterA = ca.preview.fileAfter!
  assert.ok(afterA.startsWith(head))
  assert.ok(afterA.endsWith(`${mid}${tail}`))
  assert.equal(
    afterA,
    `${head}<!-- BEGIN illithid-global: a.md -->\nrule A v2\n<!-- END illithid-global: a.md -->\n${mid}${tail}`
  )
  // A new section is appended after the existing text, which stays byte for byte
  assert.ok(cb.preview.fileAfter!.startsWith(readFileSync(file, 'utf8')))
})

test('unsupported_include_is_excluded: a recipient that would lose an include is excluded with its reason', async () => {
  const home = syntheticHome()
  toolHome(home)
  put(home, 'notes/x.md', 'note')
  await seedVariants(home, { 'CLAUDE.md': 'Base rules\n@~/notes/x.md\n' })
  const r = roots(home)
  const v = pick(home, 'CLAUDE.md')
  const claudeMd = join(r.claude, 'CLAUDE.md')
  const p = plan(home, [
    ch(v, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'CLAUDE.md')),
    ch(v, 'opencode', defaultDestination(r.opencode, 'opencode', 'rule', 'CLAUDE.md')),
    ch(v, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'CLAUDE.md')),
    ch(v, 'claude', sectionDestination(claudeMd, 'base'))
  ])
  assert.deepEqual(
    p.excluded.map((e) => [e.choice.tool, e.reason]),
    [
      ['codex', 'includeNotSupported'],
      ['opencode', 'includeNotSupported'],
      ['claude', 'includeNotSupported']
    ]
  )
  assert.deepEqual(
    p.changes.map((c) => [c.tool, c.destination, c.op]),
    [['claude', sectionDestination(claudeMd, 'base'), 'create']]
  )
})

test('three native forms: dedicated Claude rule file, Codex/OpenCode sections, skill copies with resources', async () => {
  const home = syntheticHome()
  toolHome(home)
  put(home, '.claude/CLAUDE.md', 'claude user file\n')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255])
  await seedVariants(home, {
    'rules/r.md': 'Rule R',
    'skills/kit/SKILL.md': '---\nname: kit\n---\nbody\n',
    'skills/kit/assets/i.png': png
  })
  const r = roots(home)
  const rule = pick(home, 'r.md')
  const kit = pick(home, 'kit')
  const p = plan(home, [
    ch(rule, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'r.md')),
    ch(rule, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'r.md')),
    ch(rule, 'opencode', defaultDestination(r.opencode, 'opencode', 'rule', 'r.md')),
    ch(kit, 'claude', defaultDestination(r.claude, 'claude', 'skill', 'kit')),
    ch(kit, 'codex', defaultDestination(r.codex, 'codex', 'skill', 'kit')),
    ch(kit, 'opencode', defaultDestination(r.opencode, 'opencode', 'skill', 'kit'))
  ])
  assert.deepEqual(p.excluded, [])
  const byTool = (t: GlobalTool, k: string): GlobalSyncPlan['changes'][number] =>
    p.changes.find((c) => c.tool === t && c.kind === k)!
  assert.equal(byTool('claude', 'rule').destination, join(r.claude, 'rules/illithid/r.md'))
  assert.equal(byTool('claude', 'rule').preview.after, 'Rule R')
  // A section body gets a final line break so the END marker starts its own line
  assert.equal(byTool('codex', 'rule').preview.after, 'Rule R\n')
  assert.equal(
    byTool('codex', 'rule').preview.fileAfter,
    '<!-- BEGIN illithid-global: r.md -->\nRule R\n<!-- END illithid-global: r.md -->\n'
  )
  // Creating OpenCode's global AGENTS.md stops its fallback to ~/.claude/CLAUDE.md: shown, not hidden
  assert.ok(byTool('opencode', 'rule').notes.includes('opencodeStopsClaudeMdFallback'))
  for (const t of ['claude', 'codex', 'opencode'] as const) {
    const s = byTool(t, 'skill')
    assert.equal(s.afterDigest, kit.revision)
    assert.deepEqual(s.preview.files, [
      { path: 'SKILL.md', change: 'added' },
      { path: 'assets/i.png', change: 'added' }
    ])
  }
})

test('the plan is idempotent and limited to the chosen recipients', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, { 'rules/r.md': 'R\n' })
  const r = roots(home)
  const v = pick(home, 'r.md')
  const choices = [ch(v, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'r.md'))]
  const strip = (p: GlobalSyncPlan): unknown => ({ ...p, id: '', createdAt: '' })
  const p1 = plan(home, choices)
  const p2 = plan(home, choices)
  assert.notEqual(p1.id, p2.id)
  assert.deepEqual(strip(p1), strip(p2))
  assert.deepEqual(
    p1.changes.map((c) => c.tool),
    ['claude']
  )
})

test('conflicts and invalid choices are excluded from the applicable subset; independent items stay', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, {
    'rules/ok.md': 'ok\n',
    'rules/busy.md': 'busy\n',
    'rules/old.md': 'old\n'
  })
  put(home, '.claude/rules/illithid/busy.md', 'user owned\n')
  put(home, '.codex/AGENTS.override.md', 'override\n')
  const r = roots(home)
  const ok = pick(home, 'ok.md')
  const busy = pick(home, 'busy.md')
  const old = pick(home, 'old.md')
  const p = plan(home, [
    ch(ok, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'ok.md')),
    ch(busy, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'busy.md')),
    {
      ...ch(old, 'claude', defaultDestination(r.claude, 'claude', 'rule', 'old.md')),
      variantRevision: 'stale'
    },
    ch(ok, 'codex', defaultDestination(r.codex, 'codex', 'rule', 'ok.md')),
    ch(ok, 'claude', join(home, 'outside/ok.md')),
    ch(ok, 'claude', join(r.claude, 'settings.json'))
  ])
  assert.deepEqual(
    p.changes.map((c) => [c.tool, c.destination]),
    [['claude', defaultDestination(r.claude, 'claude', 'rule', 'ok.md')]]
  )
  assert.deepEqual(
    p.conflicts.map((c) => c.type),
    ['unmanagedDestination']
  )
  assert.deepEqual(
    p.excluded.map((e) => e.reason),
    ['staleRevision', 'shadowedByOverride', 'invalidDestination', 'invalidDestination']
  )
})

test('a linked folder between the tool root and the destination is never written through', async () => {
  const home = syntheticHome()
  toolHome(home)
  await seedVariants(home, { 'skills/s/SKILL.md': '---\nname: s\n---\n' })
  const elsewhere = join(home, 'shared skills')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(home, '.claude/skills'), 'junction')
  const r = roots(home)
  const s = pick(home, 's')
  const p = plan(home, [ch(s, 'claude', join(r.claude, 'skills/s'))])
  assert.deepEqual(p.changes, [])
  assert.deepEqual(
    p.excluded.map((e) => e.reason),
    ['linkedAncestor']
  )
})
