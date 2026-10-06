/**
 * Project census, Task 2 (spec 2026-10-06 criteria 3, 5, 6, 7, 9): bounded reads of the covered paths of the selected
 * projects only, whole-tree observations, links reported without reading their targets, incomplete outcomes kept
 * apart from absence, read limits, cancellation. Synthetic trees and a synthetic global profile only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { discoverProjects } from '../src/engine/census/paths'
import { scanProjects, type ScanOptions } from '../src/engine/census/scan'
import type {
  CensusItem,
  CensusProgress,
  CensusSnapshot,
  DiscoveryHandle
} from '../src/engine/census/types'
import {
  censusBase,
  codeOf,
  errno,
  fmt,
  inside,
  isContent,
  isWrite,
  linkDir,
  observeFs,
  put,
  samePath,
  snapshot,
  syntheticGlobalState,
  type FsCall,
  type ObserveOptions
} from './lib/censusFixture'
import { denyRead } from './lib/globalFixture'

const WIN = process.platform === 'win32'
const MiB = 1024 * 1024
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: test\n---\nbody\n`
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')

const idOf = (d: DiscoveryHandle, name: string): string => {
  const c = d.view.candidates.find((x) => x.name === name)
  assert.ok(c, `candidate ${name}`)
  return c.id
}

function scan(
  d: DiscoveryHandle,
  names: string[],
  extra: Partial<ScanOptions> = {}
): Promise<CensusSnapshot> {
  return scanProjects(
    d,
    names.map((n) => idOf(d, n)),
    { signal: new AbortController().signal, onProgress: () => {}, ...extra }
  )
}

async function observedScan(
  root: string,
  names: string[],
  observe: ObserveOptions = {},
  extra: Partial<ScanOptions> = {}
): Promise<{ s: CensusSnapshot; calls: FsCall[] }> {
  const d = await discoverProjects(root)
  const r = await observeFs(() => scan(d, names, extra), observe)
  assert.equal(r.error, undefined)
  return { s: r.value!, calls: r.calls }
}

const projectItems = (s: CensusSnapshot, project: string): CensusItem[] => {
  const p = s.projects.find((x) => x.name === project)
  assert.ok(p, `project ${project}`)
  return s.items.filter((i) => i.projectId === p.candidateId)
}
const rows = (s: CensusSnapshot, project: string): unknown[][] =>
  projectItems(s, project).map((i) => [
    i.kind,
    i.name,
    i.relativePath,
    i.consumers.join('+'),
    i.outcome,
    i.reason ?? null
  ])
const linkRows = (s: CensusSnapshot, project: string): unknown[][] =>
  projectItems(s, project).map((i) => [
    i.kind,
    i.relativePath,
    i.outcome,
    i.reason ?? null,
    i.problemPath ?? null,
    i.linkText ?? null
  ])
const outcomes = (s: CensusSnapshot, project: string): unknown[][] =>
  projectItems(s, project).map((i) => [i.relativePath, i.outcome, i.reason ?? null])
const itemAt = (s: CensusSnapshot, project: string, rel: string): CensusItem => {
  const i = projectItems(s, project).find((x) => x.relativePath === rel)
  assert.ok(i, `${project}: ${rel}`)
  return i
}
/** Files opened or read whole, by any fs API */
const opened = (calls: FsCall[]): string[] =>
  calls
    .filter((c) => /^(promises\.)?(open|readFile)(Sync)?$/.test(c.fn))
    .map((c) => c.path)
    .sort()
const touching = (calls: FsCall[], dir: string): string[] =>
  calls.filter((c) => samePath(c.path, dir) || inside(c.path, dir)).map(fmt)

interface Full {
  base: string
  root: string
  full: string
  other: string
  home: string
}

/** A root project, a project with every covered path (and uncovered look-alikes), an empty and an unselected one */
function fullWorkspace(): Full {
  const base = censusBase()
  const root = join(base, 'projects ö')
  put(root, 'AGENTS.md', '# root\n')
  put(root, 'notes.md', 'not covered\n')
  const full = join(root, 'full proj ä')
  const files: Record<string, string | Buffer> = {
    'AGENTS.md': '# agents\n',
    'AGENTS.override.md': '# override\n',
    'CLAUDE.md': '# claude\n',
    'CLAUDE.local.md': '# local\n',
    '.claude/CLAUDE.md': '# dot claude\n',
    '.claude/rules/style.md': '# style\n',
    '.claude/rules/nested/deep.md': '# deep\n',
    '.claude/rules/readme.txt': 'not a rule\n',
    '.claude/skills/alpha/SKILL.md': SKILL('alpha'),
    '.claude/skills/alpha/assets/logo.png': PNG,
    '.claude/skills/notes.md': 'a file in a skills folder is not a skill\n',
    '.claude/skills/noskill/readme.md': 'no SKILL.md here\n',
    '.agents/skills/beta/SKILL.md': SKILL('beta'),
    '.opencode/skills/gamma/SKILL.md': SKILL('gamma'),
    'src/AGENTS.md': '# nested source instruction\n',
    'src/.claude/rules/x.md': '# nested rules\n'
  }
  for (const [rel, body] of Object.entries(files)) put(full, rel, body)
  mkdirSync(join(root, 'empty'))
  put(root, 'other/AGENTS.md', '# unselected\n')
  return { base, root, full, other: join(root, 'other'), home: syntheticGlobalState(base) }
}

test('positive control: a production scan opens exactly the covered files of the selected projects, and writes nothing', async () => {
  const ws = fullWorkspace()
  const before = snapshot(ws.base)
  const { calls } = await observedScan(ws.root, ['projects ö', 'full proj ä', 'empty'])
  const covered = [
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    'CLAUDE.local.md',
    '.claude/CLAUDE.md',
    '.claude/rules/nested/deep.md',
    '.claude/rules/style.md',
    '.claude/skills/alpha/SKILL.md',
    '.claude/skills/alpha/assets/logo.png',
    '.agents/skills/beta/SKILL.md',
    '.opencode/skills/gamma/SKILL.md'
  ]
  assert.deepEqual(
    opened(calls),
    [join(ws.root, 'AGENTS.md'), ...covered.map((r) => join(ws.full, r))].sort()
  )
  // Unselected projects and arbitrary nested sources are not even examined; a folder without SKILL.md is not listed
  assert.deepEqual(touching(calls, ws.other), [])
  assert.deepEqual(touching(calls, join(ws.full, 'src')), [])
  const noskill = join(ws.full, '.claude/skills/noskill')
  assert.deepEqual(
    calls
      .filter((c) => isContent(c) && (samePath(c.path, noskill) || inside(c.path, noskill)))
      .map(fmt),
    []
  )
  // No write of any kind: fixtures, global tool folders, library and delivery state are unchanged
  assert.deepEqual(calls.filter(isWrite).map(fmt), [])
  assert.deepEqual(snapshot(ws.base), before)
})

test('every covered path is inventoried once, with its potential consumers; empty projects stay empty', async () => {
  const ws = fullWorkspace()
  const d = await discoverProjects(ws.root)
  const s = await scan(d, ['full proj ä', 'empty', 'projects ö'])
  assert.deepEqual(s.coverage, [
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    'CLAUDE.local.md',
    '.claude/CLAUDE.md',
    '.claude/rules/**/*.md',
    '.claude/skills/<folder>/',
    '.agents/skills/<folder>/',
    '.opencode/skills/<folder>/'
  ])
  assert.deepEqual(rows(s, 'projects ö'), [
    ['rule', 'AGENTS.md', 'AGENTS.md', 'codex+opencode', 'complete', null]
  ])
  assert.deepEqual(rows(s, 'full proj ä'), [
    ['rule', 'AGENTS.md', 'AGENTS.md', 'codex+opencode', 'complete', null],
    ['rule', 'AGENTS.override.md', 'AGENTS.override.md', 'codex', 'complete', null],
    ['rule', 'CLAUDE.md', 'CLAUDE.md', 'claude+opencode', 'complete', null],
    ['rule', 'CLAUDE.local.md', 'CLAUDE.local.md', 'claude', 'complete', null],
    ['rule', '.claude/CLAUDE.md', '.claude/CLAUDE.md', 'claude', 'complete', null],
    [
      'rule',
      '.claude/rules/nested/deep.md',
      '.claude/rules/nested/deep.md',
      'claude',
      'complete',
      null
    ],
    ['rule', '.claude/rules/style.md', '.claude/rules/style.md', 'claude', 'complete', null],
    ['skill', 'alpha', '.claude/skills/alpha', 'claude+opencode', 'complete', null],
    ['skill', 'noskill', '.claude/skills/noskill', 'claude+opencode', 'unsupported', 'notASkill'],
    ['skill', 'beta', '.agents/skills/beta', 'codex+opencode', 'complete', null],
    ['skill', 'gamma', '.opencode/skills/gamma', 'opencode', 'complete', null]
  ])
  assert.deepEqual(rows(s, 'empty'), [])
  assert.deepEqual(
    s.projects.map((p) => [p.name, p.isRoot, p.status, p.rules, p.skills, p.incomplete, p.empty]),
    [
      ['projects ö', true, 'scanned', 1, 0, 0, false],
      ['empty', false, 'scanned', 0, 0, 0, true],
      ['full proj ä', false, 'scanned', 7, 3, 1, false]
    ]
  )
  const agents = itemAt(s, 'full proj ä', 'AGENTS.md')
  assert.deepEqual([agents.digest, agents.bytes], [sha('# agents\n'), 9])
  assert.deepEqual(itemAt(s, 'full proj ä', '.claude/skills/alpha').manifest, [
    { path: 'SKILL.md', kind: 'file', bytes: SKILL('alpha').length, digest: sha(SKILL('alpha')) },
    { path: 'assets', kind: 'dir' },
    { path: 'assets/logo.png', kind: 'file', bytes: PNG.length, digest: sha(PNG) }
  ])
  const noskill = itemAt(s, 'full proj ä', '.claude/skills/noskill')
  assert.deepEqual([noskill.digest, noskill.manifest], [undefined, undefined])
  assert.equal(s.root, ws.root)
  assert.ok(s.startedAt <= s.finishedAt)
})

test('links and junctions in containers, ancestors, rules and skill trees are reported, their targets never read', async () => {
  const base = censusBase()
  const root = join(base, 'links ö')
  const t1 = join(base, 'target claude')
  put(t1, 'CLAUDE.md', '# behind\n')
  put(t1, 'rules/x.md', '# behind\n')
  put(t1, 'skills/s/SKILL.md', SKILL('s'))
  const t2 = join(base, 'target skill')
  put(t2, 'SKILL.md', SKILL('linked'))
  const t3 = join(base, 'target assets')
  put(t3, 'logo.png', PNG)
  const t4 = join(base, 'target opencode skills')
  put(t4, 'o/SKILL.md', SKILL('o'))
  const t5 = join(base, 'target rules')
  put(t5, 'shared.md', '# shared\n')
  const p = join(root, 'p')
  mkdirSync(join(p, '.opencode'), { recursive: true })
  linkDir(t1, join(p, '.claude'))
  put(p, '.agents/skills/res/SKILL.md', SKILL('res'))
  linkDir(t3, join(p, '.agents/skills/res/assets'))
  linkDir(t2, join(p, '.agents/skills/linked'))
  linkDir(t4, join(p, '.opencode/skills'))
  const q = join(root, 'q')
  put(q, '.claude/rules/own.md', '# own\n')
  linkDir(t5, join(q, '.claude/rules/shared'))
  const { s, calls } = await observedScan(root, ['p', 'q'])
  assert.deepEqual(linkRows(s, 'p'), [
    ['rule', '.claude/CLAUDE.md', 'linked', 'linkedAncestor', '.claude', t1],
    ['rule', '.claude/rules', 'linked', 'linkedAncestor', '.claude', t1],
    ['skill', '.claude/skills', 'linked', 'linkedAncestor', '.claude', t1],
    ['skill', '.agents/skills/linked', 'linked', 'link', null, t2],
    ['skill', '.agents/skills/res', 'linked', 'linkInside', '.agents/skills/res/assets', t3],
    ['skill', '.opencode/skills', 'linked', 'link', null, t4]
  ])
  assert.deepEqual(linkRows(s, 'q'), [
    ['rule', '.claude/rules/own.md', 'complete', null, null, null],
    ['rule', '.claude/rules/shared', 'linked', 'link', null, t5]
  ])
  for (const t of [t1, t2, t3, t4, t5]) assert.deepEqual(touching(calls, t), [], t)
  // A skill with a linked entry is incomplete as a whole: no digest, no partial manifest
  for (const i of s.items.filter((x) => x.outcome !== 'complete'))
    assert.deepEqual([i.digest, i.manifest], [undefined, undefined], i.relativePath)
  assert.equal(s.projects.find((x) => x.name === 'p')!.incomplete, 6)
})

test('a linked instruction or rule file is reported, neither it nor its target is opened', async (t) => {
  const base = censusBase()
  const target = put(base, 'real AGENTS.md', '# real\n')
  const p = join(base, 'file links', 'p')
  mkdirSync(join(p, '.claude/rules'), { recursive: true })
  try {
    symlinkSync(target, join(p, 'AGENTS.md'), 'file')
    symlinkSync(target, join(p, '.claude/rules/r.md'), 'file')
  } catch (e) {
    return t.skip(`file symlinks need Developer Mode here (${codeOf(e)})`)
  }
  const { s, calls } = await observedScan(join(base, 'file links'), ['p'])
  assert.deepEqual(linkRows(s, 'p'), [
    ['rule', 'AGENTS.md', 'linked', 'link', null, target],
    ['rule', '.claude/rules/r.md', 'linked', 'link', null, target]
  ])
  assert.deepEqual(opened(calls), [])
})

test('a project replaced after discovery is refused before any read, even with identical contents', async () => {
  const ws = fullWorkspace()
  const d = await discoverProjects(ws.root)
  renameSync(ws.full, join(ws.base, 'full old'))
  put(ws.full, 'AGENTS.md', '# agents\n')
  put(ws.full, 'CLAUDE.md', '# claude\n')
  const r = await observeFs(() => scan(d, ['empty', 'full proj ä']))
  assert.equal(codeOf(r.error), 'projectChanged')
  assert.deepEqual(r.calls.filter(isContent).map(fmt), [])
})

test('unreadable items are incomplete, not absent; one failure keeps every other result', async () => {
  const base = censusBase()
  const root = join(base, 'errors ö')
  mkdirSync(join(root, 'a empty'), { recursive: true })
  const b = join(root, 'b')
  put(b, 'AGENTS.md', '# ok\n')
  const claude = put(b, 'CLAUDE.md', '# denied\n')
  put(b, '.claude/skills/s1/SKILL.md', SKILL('s1'))
  const data = put(b, '.claude/skills/s1/data.bin', PNG)
  put(b, '.claude/skills/s2/SKILL.md', SKILL('s2'))
  const fail = (c: FsCall): NodeJS.ErrnoException | undefined =>
    c.fn === 'promises.open' && (samePath(c.path, claude) || samePath(c.path, data))
      ? errno('EACCES')
      : undefined
  const { s } = await observedScan(root, ['a empty', 'b'], { fail })
  assert.deepEqual(linkRows(s, 'b'), [
    ['rule', 'AGENTS.md', 'complete', null, null, null],
    ['rule', 'CLAUDE.md', 'unreadable', 'EACCES', null, null],
    ['skill', '.claude/skills/s1', 'unreadable', 'EACCES', '.claude/skills/s1/data.bin', null],
    ['skill', '.claude/skills/s2', 'complete', null, null, null]
  ])
  assert.deepEqual(
    s.projects.map((p) => [p.name, p.rules, p.skills, p.incomplete, p.empty]),
    [
      ['a empty', 0, 0, 0, true],
      ['b', 1, 1, 2, false]
    ]
  )
  const id = (rel: string): string => itemAt(s, 'b', rel).id
  assert.deepEqual(s.uniqueItemIds.sort(), [id('AGENTS.md'), id('.claude/skills/s2')].sort())
  assert.equal(itemAt(s, 'b', '.claude/skills/s1').digest, undefined)
})

test('Windows: a file denied by its ACL is unreadable, other items survive', async (t) => {
  if (!WIN) return t.skip('ACL denial is exercised with icacls')
  const root = join(censusBase(), 'acl ö')
  const p = join(root, 'p')
  put(p, 'AGENTS.md', '# ok\n')
  const denied = put(p, 'CLAUDE.local.md', '# denied\n')
  const undo = denyRead(denied)
  try {
    const { s } = await observedScan(root, ['p'])
    const row = outcomes(s, 'p')
    assert.deepEqual(row[0], ['AGENTS.md', 'complete', null])
    assert.equal(row.length, 2)
    assert.equal(row[1][0], 'CLAUDE.local.md')
    assert.equal(row[1][1], 'unreadable')
    assert.ok(['EPERM', 'EACCES'].includes(row[1][2] as string), String(row[1][2]))
  } finally {
    undo()
  }
})

const BIG = { fileBytes: 1e9, skillBytes: 1e9, skillEntries: 1e6, depth: 1000 }

test('limits: at each threshold the item is complete, above it limitExceeded, and nothing over a limit is opened', async () => {
  const base = censusBase()
  const root = join(base, 'limits ö')
  const s10 = 'x'.repeat(10)
  const cases: {
    limit: Partial<typeof BIG>
    files: Record<string, string>
    want: [string, string, string | null][]
    unopened: string[]
  }[] = [
    {
      limit: { fileBytes: 10 },
      files: {
        '.claude/rules/at.md': s10,
        '.claude/rules/over.md': s10 + 'x',
        '.claude/skills/s-at/SKILL.md': s10,
        '.claude/skills/s-over/SKILL.md': s10,
        '.claude/skills/s-over/big.txt': s10 + 'x'
      },
      want: [
        ['.claude/rules/at.md', 'complete', null],
        ['.claude/rules/over.md', 'limitExceeded', 'fileBytes'],
        ['.claude/skills/s-at', 'complete', null],
        ['.claude/skills/s-over', 'limitExceeded', 'fileBytes']
      ],
      unopened: ['.claude/rules/over.md', '.claude/skills/s-over']
    },
    {
      limit: { skillBytes: 20 },
      files: {
        '.claude/skills/s-at/SKILL.md': s10,
        '.claude/skills/s-at/r.txt': s10,
        '.claude/skills/s-over/SKILL.md': s10,
        '.claude/skills/s-over/r.txt': s10 + 'x'
      },
      want: [
        ['.claude/skills/s-at', 'complete', null],
        ['.claude/skills/s-over', 'limitExceeded', 'skillBytes']
      ],
      unopened: ['.claude/skills/s-over']
    },
    {
      // Entries: the skill folder itself is not counted; directories are
      limit: { skillEntries: 3 },
      files: {
        '.claude/skills/s-at/SKILL.md': 's',
        '.claude/skills/s-at/a/x': 'x',
        '.claude/skills/s-over/SKILL.md': 's',
        '.claude/skills/s-over/a/x': 'x',
        '.claude/skills/s-over/a/y': 'y',
        // Same first entries as s-over, different afterwards: truncation must not make them equal
        '.claude/skills/s-over2/SKILL.md': 's',
        '.claude/skills/s-over2/a/x': 'x',
        '.claude/skills/s-over2/a/z': 'z'
      },
      want: [
        ['.claude/skills/s-at', 'complete', null],
        ['.claude/skills/s-over', 'limitExceeded', 'skillEntries'],
        ['.claude/skills/s-over2', 'limitExceeded', 'skillEntries']
      ],
      unopened: ['.claude/skills/s-over', '.claude/skills/s-over2']
    },
    {
      // Depth: an entry directly in the tree is at depth 1
      limit: { depth: 2 },
      files: {
        '.claude/rules/a/b.md': 'b',
        '.claude/rules/deep/b/c.md': 'c',
        '.claude/skills/s-at/SKILL.md': 's',
        '.claude/skills/s-at/a/b.txt': 'b',
        '.claude/skills/s-over/SKILL.md': 's',
        '.claude/skills/s-over/a/b/c.txt': 'c'
      },
      want: [
        ['.claude/rules/a/b.md', 'complete', null],
        ['.claude/rules/deep/b', 'limitExceeded', 'depth'],
        ['.claude/skills/s-at', 'complete', null],
        ['.claude/skills/s-over', 'limitExceeded', 'depth']
      ],
      unopened: ['.claude/rules/deep', '.claude/skills/s-over']
    }
  ]
  for (const [n, c] of cases.entries()) {
    const name = `p${n}`
    const p = join(root, name)
    for (const [rel, body] of Object.entries(c.files)) put(p, rel, body)
    const { s, calls } = await observedScan(root, [name], {}, { limits: { ...BIG, ...c.limit } })
    const label = JSON.stringify(c.limit)
    assert.deepEqual(outcomes(s, name), c.want, label)
    for (const rel of c.unopened) {
      const abs = join(p, rel)
      assert.deepEqual(
        opened(calls).filter((x) => samePath(x, abs) || inside(x, abs)),
        [],
        `${label} ${rel}`
      )
    }
    for (const i of s.items.filter((x) => x.outcome !== 'complete'))
      assert.deepEqual([i.digest, i.manifest], [undefined, undefined], `${label} ${i.relativePath}`)
    assert.deepEqual(s.equalGroups, [], label)
  }
})

test('default limits: 64 MiB per file, 256 MiB and 10,000 entries per skill, 64 levels', async () => {
  const base = censusBase()
  const root = join(base, 'defaults ö')
  const p = join(root, 'p')
  /** A file of the given length whose bytes are zeros (extended, not written) */
  const sized = (rel: string, bytes: number): void => {
    put(p, rel, '')
    truncateSync(join(p, rel), bytes)
  }
  try {
    sized('.claude/rules/at.md', 64 * MiB)
    sized('.claude/rules/over.md', 64 * MiB + 1)
    put(p, '.claude/skills/bytes-at/SKILL.md', '')
    put(p, '.claude/skills/bytes-over/SKILL.md', 's')
    for (let i = 0; i < 4; i++) {
      sized(`.claude/skills/bytes-at/part${i}.bin`, 64 * MiB)
      sized(`.claude/skills/bytes-over/part${i}.bin`, 64 * MiB)
    }
    put(p, `.agents/skills/deep-at/SKILL.md`, 's')
    put(p, `.agents/skills/deep-at/${'d/'.repeat(63)}leaf.txt`, 'leaf at depth 64\n')
    put(p, `.agents/skills/deep-over/SKILL.md`, 's')
    put(p, `.agents/skills/deep-over/${'d/'.repeat(64)}leaf.txt`, 'leaf at depth 65\n')
    put(p, '.opencode/skills/many-at/SKILL.md', 's')
    put(p, '.opencode/skills/many-over/SKILL.md', 's')
    for (let i = 0; i < 9999; i++) writeFileSync(join(p, '.opencode/skills/many-at', `f${i}`), '')
    for (let i = 0; i < 10000; i++)
      writeFileSync(join(p, '.opencode/skills/many-over', `f${i}`), '')
    const { s, calls } = await observedScan(root, ['p'])
    assert.deepEqual(outcomes(s, 'p'), [
      ['.claude/rules/at.md', 'complete', null],
      ['.claude/rules/over.md', 'limitExceeded', 'fileBytes'],
      ['.claude/skills/bytes-at', 'complete', null],
      ['.claude/skills/bytes-over', 'limitExceeded', 'skillBytes'],
      ['.agents/skills/deep-at', 'complete', null],
      ['.agents/skills/deep-over', 'limitExceeded', 'depth'],
      ['.opencode/skills/many-at', 'complete', null],
      ['.opencode/skills/many-over', 'limitExceeded', 'skillEntries']
    ])
    assert.equal(itemAt(s, 'p', '.claude/rules/at.md').digest, sha(Buffer.alloc(64 * MiB)))
    assert.equal(itemAt(s, 'p', '.opencode/skills/many-at').manifest!.length, 10000)
    for (const rel of ['.claude/rules/over.md', '.claude/skills/bytes-over'])
      assert.deepEqual(
        opened(calls).filter((x) => samePath(x, join(p, rel)) || inside(x, join(p, rel))),
        [],
        rel
      )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a file or skill changed while it is read is marked changed, not compared', async () => {
  const root = join(censusBase(), 'changing ö')
  const p = join(root, 'p')
  const rule = put(p, 'CLAUDE.md', '# before\n')
  const skillMd = put(p, '.claude/skills/s/SKILL.md', SKILL('s'))
  put(p, '.claude/skills/s/r.txt', 'r\n')
  put(p, '.claude/skills/t/SKILL.md', SKILL('t'))
  const hold = (c: FsCall): undefined => {
    if (c.fn !== 'promises.open') return undefined
    if (samePath(c.path, rule)) appendFileSync(rule, 'edited during the read\n')
    if (samePath(c.path, skillMd)) writeFileSync(join(p, '.claude/skills/s/new.txt'), 'new\n')
    return undefined
  }
  const { s } = await observedScan(root, ['p'], { hold })
  assert.deepEqual(outcomes(s, 'p'), [
    ['CLAUDE.md', 'changed', 'changedDuringRead'],
    ['.claude/skills/s', 'changed', 'changedDuringRead'],
    ['.claude/skills/t', 'complete', null]
  ])
  assert.deepEqual(
    s.items.filter((i) => i.outcome === 'changed').map((i) => i.digest),
    [undefined, undefined]
  )
})

test('cancellation: an aborted signal prevents the next queued read', async () => {
  const root = join(censusBase(), 'cancel ö')
  const first = put(root, 'AGENTS.md', '# first\n')
  put(root, 'CLAUDE.md', '# second\n')
  put(root, '.claude/skills/s/SKILL.md', SKILL('s'))
  const d = await discoverProjects(root)
  const ctrl = new AbortController()
  const hold = (c: FsCall): undefined => {
    if (c.fn === 'promises.open' && samePath(c.path, first)) ctrl.abort()
    return undefined
  }
  const r = await observeFs(() => scan(d, ['cancel ö'], { signal: ctrl.signal }), { hold })
  assert.equal((r.error as Error | undefined)?.name, 'AbortError')
  // The open already under way completes; nothing after it is opened or listed
  assert.deepEqual(opened(r.calls), [first])
  assert.deepEqual(r.calls.filter((c) => c.fn === 'promises.readdir').map(fmt), [])
  // Aborted before the start: no filesystem access at all
  const pre = new AbortController()
  pre.abort()
  const early = await observeFs(() => scan(d, ['cancel ö'], { signal: pre.signal }))
  assert.equal((early.error as Error | undefined)?.name, 'AbortError')
  assert.deepEqual(early.calls.map(fmt), [])
})

test('progress counts completed projects and items and names the path being read', async () => {
  const ws = fullWorkspace()
  const d = await discoverProjects(ws.root)
  const seen: CensusProgress[] = []
  const s = await scan(d, ['projects ö', 'full proj ä'], {
    onProgress: (p) => seen.push({ ...p })
  })
  const last = seen[seen.length - 1]
  assert.deepEqual([last.projectsCompleted, last.projectsTotal], [2, 2])
  assert.equal(last.itemsCompleted, s.items.length)
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i].itemsCompleted >= seen[i - 1].itemsCompleted)
  assert.ok(
    seen.some(
      (p) => p.currentProject === 'full proj ä' && p.currentPath === '.claude/rules/style.md'
    )
  )
})
