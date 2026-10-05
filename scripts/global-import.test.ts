/**
 * Task 2 — global paths and conservative import (spec 2026-10-04 §6, §8, §12 criteria 2, 11, 12).
 * Synthetic profiles only (scripts/lib/globalFixture.ts).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
// The default export is the fs module object other modules call: spies must patch it, not a namespace copy
import fs from 'node:fs'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { globalLibraryDir, resolveGlobalPaths } from '../src/engine/globalPaths'
import {
  importGlobalItems,
  listGlobalImportables,
  type GlobalImportable
} from '../src/engine/globalImport'
import { denyRead, put, snapshot, syntheticHome } from './lib/globalFixture'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const sel = (i: GlobalImportable): GlobalImportable => i
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))

test('resolveGlobalPaths: default roots resolve, a missing tool is unavailable', () => {
  const home = syntheticHome()
  put(home, '.claude/CLAUDE.md', 'x')
  put(home, '.codex/AGENTS.md', 'y')
  const r = resolveGlobalPaths(home, {}, {})
  assert.deepEqual(
    r.map((x) => [x.tool, x.status, x.paths]),
    [
      ['claude', 'resolved', [join(home, '.claude')]],
      ['codex', 'resolved', [join(home, '.codex')]],
      ['opencode', 'unavailable', []]
    ]
  )
})

test('resolveGlobalPaths: an environment override elsewhere is ambiguous until the user confirms a path', () => {
  const home = syntheticHome()
  put(home, '.codex/AGENTS.md', 'default')
  const other = join(home, 'codex elsewhere')
  put(other, 'AGENTS.md', 'env')
  const amb = resolveGlobalPaths(home, {}, { CODEX_HOME: other }).find((x) => x.tool === 'codex')!
  assert.equal(amb.status, 'ambiguous')
  assert.deepEqual([...amb.paths].sort(), [join(home, '.codex'), other].sort())
  const ok = resolveGlobalPaths(home, { codex: other }, { CODEX_HOME: other }).find(
    (x) => x.tool === 'codex'
  )!
  assert.deepEqual([ok.status, ok.paths], ['resolved', [other]])
  const missing = resolveGlobalPaths(home, { claude: join(home, 'nope') }, {}).find(
    (x) => x.tool === 'claude'
  )!
  assert.equal(missing.status, 'unavailable')
})

test('resolveGlobalPaths: a linked default root is not followed without a choice', () => {
  const home = syntheticHome()
  const real = join(home, 'real claude')
  put(real, 'CLAUDE.md', 'x')
  symlinkSync(real, join(home, '.claude'), 'junction')
  const r = resolveGlobalPaths(home, {}, {}).find((x) => x.tool === 'claude')!
  assert.equal(r.status, 'ambiguous')
})

test('import_preserves_originals: bytes, mtimes and trees of the tool folders are unchanged', () => {
  const home = syntheticHome()
  put(home, '.claude/CLAUDE.md', 'global\r\nCRLF kept\r\n')
  put(home, '.claude/rules/style.md', '# style\n')
  put(home, '.claude/skills/pdf tools/SKILL.md', '---\nname: pdf tools\n---\nbody\n')
  put(home, '.codex/AGENTS.md', 'codex rules\n')
  put(home, '.config/opencode/AGENTS.md', 'opencode rules\n')
  const before = snapTools(home)
  const paths = resolveGlobalPaths(home, {}, {})
  const listing = listGlobalImportables(home, paths)
  assert.deepEqual(listing.errors, [])
  assert.equal(listing.items.length, 5)
  const r = importGlobalItems(home, listing.items.map(sel), paths)
  assert.deepEqual(r.errors, [])
  assert.equal(r.items.length, 5)
  assert.deepEqual(snapTools(home), before)
  const rule = r.items.find((i) => i.name === 'CLAUDE.md')!
  assert.deepEqual(readFileSync(rule.storedPath), Buffer.from('global\r\nCRLF kept\r\n'))
  assert.ok(resolve(rule.storedPath).startsWith(globalLibraryDir(home)))
  assert.equal(rule.origin.tool, 'claude')
  assert.equal(rule.origin.path, join(home, '.claude/CLAUDE.md'))
  // No upstream state (pendingRetire) is created by the Windows import
  assert.equal(existsSync(join(home, '.config/illithid/state.json')), false)
  assert.equal(new Set(r.items.map((i) => i.id)).size, 5)
})

test('import_includes_skill_resources: every file of the skill tree is copied byte for byte', () => {
  const home = syntheticHome()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a, 0x1a])
  put(home, '.claude/skills/report/SKILL.md', '---\nname: report\n---\nUse scripts/run.py\n')
  put(home, '.claude/skills/report/scripts/run.py', 'print("ok")\r\n')
  put(home, '.claude/skills/report/assets/logo.png', png)
  put(home, '.claude/skills/report/ref/notes ü.md', 'notes\n')
  const paths = resolveGlobalPaths(home, {}, {})
  const listing = listGlobalImportables(home, paths)
  const r = importGlobalItems(home, listing.items.map(sel), paths)
  assert.deepEqual(r.errors, [])
  const s = r.items.find((i) => i.kind === 'skill')!
  assert.deepEqual(readFileSync(join(s.storedPath, 'assets/logo.png')), png)
  assert.equal(readFileSync(join(s.storedPath, 'scripts/run.py'), 'utf8'), 'print("ok")\r\n')
  assert.equal(readFileSync(join(s.storedPath, 'ref/notes ü.md'), 'utf8'), 'notes\n')
  assert.deepEqual(readdirSync(s.storedPath).sort(), ['SKILL.md', 'assets', 'ref', 'scripts'])
})

test('import_refuses_external_junction: no read or write inside the external target, visible error', () => {
  const home = syntheticHome()
  const outside = join(home, 'outside shared')
  put(outside, 'secret.md', 'do not read\n')
  put(home, '.claude/skills/linked-res/SKILL.md', '---\nname: linked-res\n---\n')
  symlinkSync(outside, join(home, '.claude/skills/linked-res/shared'), 'junction')
  symlinkSync(outside, join(home, '.claude/skills/whole-link'), 'junction')
  const outsideBefore = snapshot(outside)
  const touched: string[] = []
  const o = resolve(outside).toLowerCase()
  const spy = ['readdirSync', 'readFileSync', 'openSync', 'opendirSync', 'copyFileSync', 'cpSync']
  const fsm = fs as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = spy.map((k) => fsm[k])
  spy.forEach((k, i) => {
    fsm[k] = (...a: unknown[]): unknown => {
      if (typeof a[0] === 'string' && resolve(a[0]).toLowerCase().startsWith(o)) touched.push(k)
      return saved[i](...a)
    }
  })
  let listing: ReturnType<typeof listGlobalImportables>
  let r: ReturnType<typeof importGlobalItems>
  try {
    const paths = resolveGlobalPaths(home, {}, {})
    listing = listGlobalImportables(home, paths)
    r = importGlobalItems(
      home,
      [
        {
          tool: 'claude',
          kind: 'skill',
          name: 'linked-res',
          sourcePath: join(home, '.claude/skills/linked-res'),
          sourceDigest: 'forged'
        }
      ],
      paths
    )
  } finally {
    spy.forEach((k, i) => (fsm[k] = saved[i]))
  }
  assert.deepEqual(touched, [])
  assert.equal(listing.items.length, 0)
  const codes = listing.errors.map((e) => [e.path, e.code])
  assert.ok(
    codes.some(
      ([p, c]) => p === join(home, '.claude/skills/linked-res/shared') && c === 'externalLink'
    )
  )
  // A whole linked skill folder is only offered for the guided import: its target is shown, never read here
  assert.ok(!codes.some(([p]) => p === join(home, '.claude/skills/whole-link')))
  assert.deepEqual(
    listing.linked.map((l) => [l.linkPath, l.targetPath]),
    [[join(home, '.claude/skills/whole-link'), realpathSync.native(outside)]]
  )
  assert.equal(r.items.length, 0)
  assert.deepEqual(
    r.errors.map((e) => e.code),
    ['notListed']
  )
  assert.deepEqual(snapshot(outside), outsideBefore)
  assert.equal(
    existsSync(globalLibraryDir(home)) ? readdirSync(globalLibraryDir(home)).length : 0,
    0
  )
})

test('access denied is reported and yields no item, even for one resource of a skill', () => {
  const home = syntheticHome()
  const locked = put(home, '.claude/rules/locked.md', 'secret\n')
  put(home, '.claude/rules/open.md', 'open\n')
  put(home, '.codex/skills/partial/SKILL.md', '---\nname: partial\n---\n')
  const res = put(home, '.codex/skills/partial/data.bin', 'x')
  const undo = [denyRead(locked), denyRead(res)]
  try {
    const paths = resolveGlobalPaths(home, {}, {})
    const listing = listGlobalImportables(home, paths)
    assert.deepEqual(
      listing.items.map((i) => i.name),
      ['open.md']
    )
    assert.deepEqual(
      listing.errors.map((e) => [e.path, e.code]).sort(),
      [
        [locked, 'EPERM'],
        [res, 'EPERM']
      ].sort()
    )
  } finally {
    undo.forEach((u) => u())
  }
})

test('only global rules and skills are listed: no MCP, secrets, settings or project data', () => {
  const home = syntheticHome()
  put(home, '.claude/CLAUDE.md', 'rules')
  put(home, '.claude/settings.json', '{"permissions":{"allow":["Bash"]}}')
  put(home, '.claude.json', '{"mcpServers":{"x":{"command":"y"}}}')
  put(home, '.claude/projects/p/memory/MEMORY.md', 'memory')
  put(home, '.claude/agents/a.md', 'agent')
  put(home, '.codex/config.toml', '[mcp_servers.x]\ncommand = "y"\n')
  put(home, '.codex/auth.json', '{"token":"t"}')
  put(home, '.codex/rules/default.rules', 'prefix_rule()')
  put(home, '.codex/skills/.system/builtin/SKILL.md', 'builtin')
  put(home, '.config/opencode/opencode.json', '{"mcp":{}}')
  put(home, 'project/AGENTS.md', 'project rules')
  const listing = listGlobalImportables(home, resolveGlobalPaths(home, {}, {}))
  assert.deepEqual(
    listing.items.map((i) => i.sourcePath),
    [join(home, '.claude/CLAUDE.md')]
  )
})

test('a source changed after the listing is refused and nothing is copied', () => {
  const home = syntheticHome()
  const p = put(home, '.claude/rules/a.md', 'v1\n')
  const paths = resolveGlobalPaths(home, {}, {})
  const listing = listGlobalImportables(home, paths)
  writeFileSync(p, 'v2\n')
  const r = importGlobalItems(home, listing.items.map(sel), paths)
  assert.deepEqual(
    r.errors.map((e) => [e.path, e.code]),
    [[p, 'changedSinceListing']]
  )
  assert.equal(r.items.length, 0)
})

test('rule includes and skill references leaving the skill are recorded with their resolution', () => {
  const home = syntheticHome()
  put(home, 'notes/present.md', 'x')
  put(
    home,
    '.claude/CLAUDE.md',
    'See @~/notes/present.md and @~/notes/missing.md\n```\n@not/an/include.md\n```\n'
  )
  put(
    home,
    '.claude/skills/refs/SKILL.md',
    'Read [shared](../shared/guide.md) and [local](ref/a.md)\n'
  )
  put(home, '.claude/skills/refs/ref/a.md', 'a')
  const listing = listGlobalImportables(home, resolveGlobalPaths(home, {}, {}))
  const rule = listing.items.find((i) => i.kind === 'rule')!
  assert.deepEqual(rule.references, [
    { ref: '~/notes/present.md', resolved: true, external: true },
    { ref: '~/notes/missing.md', resolved: false, external: true }
  ])
  const skill = listing.items.find((i) => i.kind === 'skill')!
  assert.deepEqual(skill.references, [
    { ref: '../shared/guide.md', resolved: false, external: true }
  ])
})

test('importing the same source twice does not create a duplicate variant', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/a.md', 'v1\n')
  const paths = resolveGlobalPaths(home, {}, {})
  const first = importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  assert.equal(first.items.length, 1)
  const again = importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  assert.deepEqual(
    again.errors.map((e) => e.code),
    ['alreadyImported']
  )
  assert.equal(readdirSync(globalLibraryDir(home)).length, 1)
})

/** Runs fn while recording the fs reads/copies whose path lies under one of the given folders */
function readsUnder<T>(dirs: string[], fn: () => T): { value: T; touched: string[] } {
  const roots = dirs.map((d) => resolve(d).toLowerCase())
  const touched: string[] = []
  const spy = ['readdirSync', 'readFileSync', 'openSync', 'opendirSync', 'copyFileSync', 'cpSync']
  const fsm = fs as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = spy.map((k) => fsm[k])
  spy.forEach((k, i) => {
    fsm[k] = (...a: unknown[]): unknown => {
      if (
        typeof a[0] === 'string' &&
        roots.some((r) =>
          resolve(a[0] as string)
            .toLowerCase()
            .startsWith(r)
        )
      )
        touched.push(`${k} ${a[0]}`)
      return saved[i](...a)
    }
  })
  try {
    return { value: fn(), touched }
  } finally {
    spy.forEach((k, i) => (fsm[k] = saved[i]))
  }
}

test('review F2a: linked rules and skills containers are reported and never scanned', () => {
  const home = syntheticHome()
  const extRules = join(home, 'external rules')
  const extSkills = join(home, 'external skills')
  put(extRules, 'x.md', 'external rule\n')
  put(extSkills, 'ext/SKILL.md', '---\nname: ext\n---\n')
  put(home, '.claude/CLAUDE.md', 'own\n')
  symlinkSync(extRules, join(home, '.claude/rules'), 'junction')
  symlinkSync(extSkills, join(home, '.claude/skills'), 'junction')
  const paths = resolveGlobalPaths(home, {}, {})
  const watched = [extRules, extSkills, join(home, '.claude/rules'), join(home, '.claude/skills')]
  const { value: listing, touched } = readsUnder(watched, () => listGlobalImportables(home, paths))
  assert.deepEqual(touched, [])
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ['CLAUDE.md']
  )
  assert.deepEqual(
    listing.errors.map((e) => [e.path, e.code]).sort(),
    [
      [join(home, '.claude/rules'), 'linkedSource'],
      [join(home, '.claude/skills'), 'linkedSource']
    ].sort()
  )
})

test('review F2b: a source whose folder became a link after the listing is not copied', () => {
  const home = syntheticHome()
  put(home, '.claude/rules/r.md', 'rule\n')
  put(home, '.claude/skills/kit/SKILL.md', '---\nname: kit\n---\n')
  const paths = resolveGlobalPaths(home, {}, {})
  const listing = listGlobalImportables(home, paths)
  assert.equal(listing.items.length, 2)
  // Same content, now reached through junctions: the copy would leave the selected source
  const movedRules = join(home, 'moved rules')
  const movedSkills = join(home, 'moved skills')
  renameSync(join(home, '.claude/rules'), movedRules)
  renameSync(join(home, '.claude/skills'), movedSkills)
  symlinkSync(movedRules, join(home, '.claude/rules'), 'junction')
  symlinkSync(movedSkills, join(home, '.claude/skills'), 'junction')
  const watched = [
    movedRules,
    movedSkills,
    join(home, '.claude/rules'),
    join(home, '.claude/skills')
  ]
  const { value: r, touched } = readsUnder(watched, () =>
    importGlobalItems(home, listing.items, paths)
  )
  assert.equal(r.items.length, 0)
  assert.deepEqual(
    r.errors.map((e) => e.code),
    ['linkedSource', 'linkedSource']
  )
  assert.deepEqual(touched, [])
  assert.equal(
    existsSync(globalLibraryDir(home)) ? readdirSync(globalLibraryDir(home)).length : 0,
    0
  )
})
