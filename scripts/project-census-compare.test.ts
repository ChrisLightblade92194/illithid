/**
 * Project census, Task 2 (spec 2026-10-06 §Comparison model, criteria 4, 5): exact bytes for rules, complete manifests
 * for skills, equal-content groups across names and projects, same-name differences, incomplete items never compared.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { diffManifests, groupItems } from '../src/engine/census/compare'
import { discoverProjects } from '../src/engine/census/paths'
import { scanProjects } from '../src/engine/census/scan'
import type {
  CensusEntry,
  CensusItem,
  CensusSnapshot,
  ItemOutcome
} from '../src/engine/census/types'
import { censusBase, observeFs, put, type FsCall } from './lib/censusFixture'

const rule = (
  id: string,
  projectId: string,
  name: string,
  digest: string,
  outcome: ItemOutcome = 'complete'
): CensusItem => ({
  id,
  projectId,
  kind: 'rule',
  name,
  relativePath: name,
  consumers: ['claude'],
  outcome,
  digest
})
const M1: CensusEntry[] = [{ path: 'SKILL.md', kind: 'file', bytes: 3, digest: 'a' }]
const M2: CensusEntry[] = [{ path: 'SKILL.md', kind: 'file', bytes: 3, digest: 'b' }]
const skill = (
  id: string,
  projectId: string,
  name: string,
  digest: string,
  manifest: CensusEntry[]
): CensusItem => ({
  id,
  projectId,
  kind: 'skill',
  name,
  relativePath: `.claude/skills/${name}`,
  consumers: ['claude'],
  outcome: 'complete',
  digest,
  manifest
})
const shape = (g: { kind: string; itemIds: string[] }[]): [string, string[]][] =>
  g.map((x) => [x.kind, x.itemIds])

test('equal content groups across names and projects; incomplete items and other kinds never join', () => {
  const g = groupItems([
    rule('r1', 'p1', 'AGENTS.md', 'd1'),
    rule('r2', 'p2', '.claude/rules/x.md', 'd1'),
    rule('r3', 'p2', 'CLAUDE.md', 'd2'),
    skill('s1', 'p1', 'tool', 'd1', M1),
    // A digest on an incomplete item (it should have none) still never makes it comparable
    rule('r4', 'p3', 'AGENTS.md', 'd1', 'changed')
  ])
  assert.deepEqual(shape(g.equalGroups), [['rule', ['r1', 'r2']]])
  assert.deepEqual(g.uniqueItemIds, ['r3', 's1'])
  assert.deepEqual(g.sameNameDifferences, [])
})

test('same-name differences use a case-insensitive name and need two different complete contents', () => {
  const g = groupItems([
    rule('r1', 'p1', 'CLAUDE.md', 'd1'),
    rule('r2', 'p2', 'claude.md', 'd2'),
    rule('r3', 'p3', 'CLAUDE.md', 'd1'),
    rule('r4', 'p1', '.claude/CLAUDE.md', 'd1'),
    skill('s1', 'p1', 'Tool', 'k1', M1),
    skill('s2', 'p2', 'tool', 'k2', M2),
    skill('s3', 'p1', 'same', 'k1', M1),
    skill('s4', 'p2', 'Same', 'k1', M1)
  ])
  assert.deepEqual(shape(g.sameNameDifferences), [
    ['rule', ['r1', 'r2', 'r3']],
    ['skill', ['s1', 's2']]
  ])
  // .claude/CLAUDE.md is another name, but the same content as CLAUDE.md
  assert.deepEqual(shape(g.equalGroups), [
    ['rule', ['r1', 'r3', 'r4']],
    ['skill', ['s1', 's3', 's4']]
  ])
  assert.deepEqual(g.uniqueItemIds, ['r2', 's2'])
})

test('skills are equal only when their complete manifests match, not on a digest alone', () => {
  const g = groupItems([
    skill('s1', 'p1', 'a', 'same digest', M1),
    skill('s2', 'p2', 'b', 'same digest', M2),
    skill('s3', 'p3', 'c', 'same digest', M1)
  ])
  assert.deepEqual(shape(g.equalGroups), [['skill', ['s1', 's3']]])
  assert.deepEqual(g.uniqueItemIds, ['s2'])
})

test('manifest differences: added, removed and changed paths, whatever the order', () => {
  const left: CensusEntry[] = [
    { path: 'SKILL.md', kind: 'file', bytes: 5, digest: 'a' },
    { path: 'assets', kind: 'dir' },
    { path: 'assets/a.png', kind: 'file', bytes: 3, digest: 'b' },
    { path: 'old.txt', kind: 'file', bytes: 1, digest: 'c' },
    { path: 'x', kind: 'file', bytes: 1, digest: 'd' }
  ]
  const right: CensusEntry[] = [
    { path: 'SKILL.md', kind: 'file', bytes: 5, digest: 'a2' },
    { path: 'assets', kind: 'dir' },
    { path: 'assets/a.png', kind: 'file', bytes: 3, digest: 'b' },
    { path: 'new', kind: 'dir' },
    { path: 'x', kind: 'dir' }
  ]
  const want = { added: ['new'], removed: ['old.txt'], changed: ['SKILL.md', 'x'] }
  assert.deepEqual(diffManifests(left, right), want)
  assert.deepEqual(diffManifests([...left].reverse(), [...right].reverse()), want)
})

/** Projects for the end-to-end comparisons; returns the root */
function compareWorkspace(): string {
  const root = join(censusBase(), 'compare ö')
  const S = '---\nname: s\n---\nsame skill\n'
  const base = (p: string, rel: string, resource = 'resource\n'): void => {
    put(p, `${rel}/SKILL.md`, S)
    put(p, `${rel}/r.txt`, resource)
  }
  const p1 = join(root, 'p1')
  put(p1, 'CLAUDE.md', 'a\nb\n')
  put(p1, 'AGENTS.md', 'same bytes\n')
  put(p1, '.claude/skills/tool/SKILL.md', S)
  put(p1, '.claude/skills/tool/assets/x.bin', Buffer.from([1]))
  base(p1, '.claude/skills/foo', 'foo or bar\n')
  const p2 = join(root, 'p2')
  put(p2, 'CLAUDE.md', 'a\r\nb\r\n')
  put(p2, '.claude/rules/other name.md', 'same bytes\n')
  put(p2, '.claude/skills/tool/SKILL.md', S)
  put(p2, '.claude/skills/tool/assets/x.bin', Buffer.from([2]))
  base(p2, '.agents/skills/bar', 'foo or bar\n')
  const p3 = join(root, 'p3')
  base(p3, '.claude/skills/base')
  base(p3, '.agents/skills/base-emptydir')
  mkdirSync(join(p3, '.agents/skills/base-emptydir/extra'))
  base(p3, '.opencode/skills/base-hidden')
  put(p3, '.opencode/skills/base-hidden/.hidden', 'hidden\n')
  const p4 = join(root, 'p4')
  base(p4, '.claude/skills/base-ds')
  put(p4, '.claude/skills/base-ds/.DS_Store/payload.bin', Buffer.from([0]))
  base(p4, '.agents/skills/base-copy')
  return root
}

async function compareScan(
  transform?: (c: FsCall, r: unknown) => unknown
): Promise<CensusSnapshot> {
  const root = compareWorkspace()
  const d = await discoverProjects(root)
  const ids = ['p1', 'p2', 'p3', 'p4'].map((n) => d.view.candidates.find((c) => c.name === n)!.id)
  const r = await observeFs(
    () => scanProjects(d, ids, { signal: new AbortController().signal, onProgress: () => {} }),
    { transform }
  )
  assert.equal(r.error, undefined)
  return r.value!
}

/** Groups as sorted `project:relativePath` lists */
function named(s: CensusSnapshot, groups: { itemIds: string[] }[]): string[][] {
  const where = (id: string): string => {
    const i = s.items.find((x) => x.id === id)!
    return `${s.projects.find((p) => p.candidateId === i.projectId)!.name}:${i.relativePath}`
  }
  return groups.map((g) => g.itemIds.map(where).sort()).sort()
}

test('end to end: bytes, line endings, resources, empty folders, hidden entries and .DS_Store all count', async () => {
  const s = await compareScan()
  assert.deepEqual(named(s, s.equalGroups), [
    ['p1:.claude/skills/foo', 'p2:.agents/skills/bar'],
    ['p1:AGENTS.md', 'p2:.claude/rules/other name.md'],
    ['p3:.claude/skills/base', 'p4:.agents/skills/base-copy']
  ])
  assert.deepEqual(named(s, s.sameNameDifferences), [
    ['p1:.claude/skills/tool', 'p2:.claude/skills/tool'],
    ['p1:CLAUDE.md', 'p2:CLAUDE.md']
  ])
  const at = (project: string, rel: string): CensusItem =>
    s.items.find(
      (i) =>
        i.relativePath === rel &&
        s.projects.find((p) => p.candidateId === i.projectId)!.name === project
    )!
  const plain = at('p3', '.claude/skills/base').manifest!
  assert.deepEqual(diffManifests(plain, at('p3', '.agents/skills/base-emptydir').manifest!), {
    added: ['extra'],
    removed: [],
    changed: []
  })
  assert.deepEqual(diffManifests(plain, at('p3', '.opencode/skills/base-hidden').manifest!), {
    added: ['.hidden'],
    removed: [],
    changed: []
  })
  assert.deepEqual(diffManifests(plain, at('p4', '.claude/skills/base-ds').manifest!), {
    added: ['.DS_Store', '.DS_Store/payload.bin'],
    removed: [],
    changed: []
  })
  assert.deepEqual(
    diffManifests(
      at('p1', '.claude/skills/tool').manifest!,
      at('p2', '.claude/skills/tool').manifest!
    ),
    { added: [], removed: [], changed: ['assets/x.bin'] }
  )
})

test('end to end: equality does not depend on the order the filesystem lists entries', async () => {
  const straight = await compareScan()
  let reversals = 0
  const reversed = await compareScan((c, r) => {
    if (c.fn !== 'promises.readdir' || !Array.isArray(r) || r.length < 2) return r
    reversals++
    return [...r].reverse()
  })
  // Not vacuous: listings were really reversed, and there is something to compare
  assert.ok(reversals > 5, `reversed listings: ${reversals}`)
  assert.equal(straight.equalGroups.length, 3)
  const digests = (s: CensusSnapshot): string[] =>
    s.items.map((i) => `${i.relativePath} ${i.digest}`).sort()
  assert.deepEqual(digests(reversed), digests(straight))
  assert.deepEqual(named(reversed, reversed.equalGroups), named(straight, straight.equalGroups))
  assert.deepEqual(
    named(reversed, reversed.sameNameDifferences),
    named(straight, straight.sameNameDifferences)
  )
})
