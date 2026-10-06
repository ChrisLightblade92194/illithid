/**
 * Project census, Task 1 (spec 2026-10-06 criteria 1, 2, 6): candidates are the chosen root and its immediate folders,
 * discovered from metadata only; a selection is accepted only for bound, available candidates whose identity and
 * ancestors are unchanged. Synthetic trees only; Windows junction and case-sensitivity proofs are skipped elsewhere.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverProjects, validateSelection } from '../src/engine/census/paths'
import type { CensusCandidate, DiscoveryHandle } from '../src/engine/census/types'
import {
  censusBase,
  codeOf,
  errno,
  fmt,
  inside,
  isContent,
  linkDir,
  observeFs,
  put,
  samePath,
  snapshot,
  type FsCall
} from './lib/censusFixture'

const WIN = process.platform === 'win32'

interface Workspace {
  base: string
  /** <base>/parent ä — an ancestor of the root that a test can swap for a junction */
  parent: string
  root: string
  alpha: string
  beta: string
  linked: string
  denied: string
  /** Real folder the linked child points to (outside the root) */
  outside: string
}

/** Root with two non-Git projects (one with a grandchild), a linked project and one whose metadata a test can deny */
function workspace(): Workspace {
  const base = censusBase()
  const parent = join(base, 'parent ä')
  const root = join(parent, 'work space ö')
  put(root, 'AGENTS.md', '# root rules\n')
  put(root, 'notes.txt', 'a file is not a candidate\n')
  const alpha = join(root, 'alpha')
  put(alpha, 'AGENTS.md', '# alpha\n')
  put(alpha, 'deep/AGENTS.md', '# grandchild, never a candidate\n')
  const beta = join(root, 'Bëta proj')
  put(beta, '.claude/skills/s/SKILL.md', '---\nname: s\n---\nbody\n')
  const outside = join(base, 'outside target')
  put(outside, 'CLAUDE.md', '# behind a link\n')
  const linked = join(root, 'linked')
  linkDir(outside, linked)
  const denied = join(root, 'zz denied')
  put(denied, 'CLAUDE.md', '# denied\n')
  return { base, parent, root, alpha, beta, linked, denied, outside }
}

const row = (c: CensusCandidate): unknown[] => [
  c.name,
  c.path,
  c.isRoot,
  c.status,
  c.reason ?? null,
  c.linkText ?? null
]
const idOf = (d: DiscoveryHandle, name: string): string => {
  const c = d.view.candidates.find((x) => x.name === name)
  assert.ok(c, `candidate ${name}`)
  return c.id
}
const denyLstat =
  (path: string) =>
  (c: FsCall): NodeJS.ErrnoException | undefined =>
    c.fn === 'promises.lstat' && samePath(c.path, path) ? errno('EACCES') : undefined

test('discovery: the root and its immediate folders, linked and unreadable ones visible with a reason, in a stable order', async () => {
  const ws = workspace()
  const { value: d, error } = await observeFs(() => discoverProjects(ws.root), {
    fail: denyLstat(ws.denied)
  })
  assert.equal(error, undefined)
  assert.ok(d)
  assert.deepEqual(
    d.view.candidates.map((c) => c.isRoot),
    [true, false, false, false, false]
  )
  assert.deepEqual(d.view.candidates.map(row), [
    ['work space ö', resolve(ws.root), true, 'available', null, null],
    ['alpha', ws.alpha, false, 'available', null, null],
    ['Bëta proj', ws.beta, false, 'available', null, null],
    ['linked', ws.linked, false, 'linked', 'link', ws.outside],
    ['zz denied', ws.denied, false, 'unreadable', 'EACCES', null]
  ])
  assert.equal(d.view.root, resolve(ws.root))
  assert.ok(!d.view.candidates.some((c) => c.path.includes('deep')))
  // Same tree, same order; new discovery ids
  const again = await discoverProjects(ws.root)
  assert.deepEqual(
    again.view.candidates.map((c) => c.path),
    d.view.candidates.map((c) => c.path)
  )
  assert.notEqual(again.view.id, d.view.id)
  const ids = [...d.view.candidates, ...again.view.candidates].map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('discovery reads metadata only: it enumerates the root, never a candidate folder or a file', async () => {
  const ws = workspace()
  const before = snapshot(ws.base)
  const { value: d, calls } = await observeFs(() => discoverProjects(ws.root))
  assert.ok(d)
  // Positive control: the observer sees the production enumeration of the root
  assert.ok(
    calls.some((c) => isContent(c) && samePath(c.path, ws.root)),
    calls.map(fmt).join('\n')
  )
  assert.deepEqual(calls.filter((c) => isContent(c) && !samePath(c.path, ws.root)).map(fmt), [])
  // Nothing inside a candidate or behind the link is touched, not even its metadata
  const folders = [ws.alpha, ws.beta, ws.linked, ws.denied, ws.outside]
  assert.deepEqual(
    calls
      .filter((c) => folders.some((f) => inside(c.path, f)) || samePath(c.path, ws.outside))
      .map(fmt),
    []
  )
  assert.deepEqual(snapshot(ws.base), before)
})

test('selection: bad, unknown, foreign, duplicate or unavailable ids are refused before any filesystem access', async () => {
  const ws = workspace()
  const d = await discoverProjects(ws.root)
  const withDenied = await observeFs(() => discoverProjects(ws.root), {
    fail: denyLstat(ws.denied)
  })
  const other = await discoverProjects(ws.root)
  const cases: [string, DiscoveryHandle, unknown[]][] = [
    ['empty', d, []],
    ['unknown', d, ['nope']],
    ['duplicate', d, [idOf(d, 'alpha'), idOf(d, 'alpha')]],
    ['another discovery', d, [idOf(other, 'alpha')]],
    ['not a string', d, [42]],
    ['linked', d, [idOf(d, 'linked')]],
    ['unreadable', withDenied.value!, [idOf(withDenied.value!, 'zz denied')]]
  ]
  for (const [label, h, ids] of cases) {
    const r = await observeFs(() => validateSelection(h, ids as string[]))
    assert.equal(codeOf(r.error), 'invalid', label)
    assert.deepEqual(r.calls.map(fmt), [], label)
  }
  const ok = await observeFs(() =>
    validateSelection(d, [idOf(d, 'Bëta proj'), idOf(d, 'work space ö')])
  )
  assert.equal(ok.error, undefined)
  // In discovery order; identities are rechecked (metadata), nothing is enumerated or read
  assert.deepEqual(
    ok.value!.map((c) => c.path),
    [resolve(ws.root), ws.beta]
  )
  assert.ok(ok.calls.some((c) => c.fn === 'promises.lstat' && samePath(c.path, ws.beta)))
  assert.deepEqual(ok.calls.filter(isContent).map(fmt), [])
})

test('selection: a project or root recreated with identical contents is refused before reading', async () => {
  const ws = workspace()
  const d = await discoverProjects(ws.root)
  renameSync(ws.alpha, join(ws.base, 'alpha old'))
  put(ws.alpha, 'AGENTS.md', '# alpha\n')
  put(ws.alpha, 'deep/AGENTS.md', '# grandchild, never a candidate\n')
  const r = await observeFs(() => validateSelection(d, [idOf(d, 'alpha')]))
  assert.equal(codeOf(r.error), 'projectChanged')
  assert.deepEqual(r.calls.filter(isContent).map(fmt), [])
  // The untouched sibling is still bound
  assert.equal((await validateSelection(d, [idOf(d, 'Bëta proj')])).length, 1)
  // The root itself recreated: every candidate below it is refused
  renameSync(ws.root, join(ws.parent, 'root old'))
  put(ws.beta, '.claude/skills/s/SKILL.md', '---\nname: s\n---\nbody\n')
  const all = await observeFs(() => validateSelection(d, [idOf(d, 'Bëta proj')]))
  assert.equal(codeOf(all.error), 'projectChanged')
  assert.deepEqual(all.calls.filter(isContent).map(fmt), [])
})

test(
  'Windows: a project or an ancestor replaced by a junction to the same folder or contents is refused',
  { skip: !WIN && 'junctions are a Windows feature' },
  async () => {
    const ws = workspace()
    const d = await discoverProjects(ws.root)
    // The project becomes a junction to an identical copy
    const copy = join(ws.base, 'alpha copy')
    put(copy, 'AGENTS.md', '# alpha\n')
    put(copy, 'deep/AGENTS.md', '# grandchild, never a candidate\n')
    renameSync(ws.alpha, join(ws.base, 'alpha old'))
    linkDir(copy, ws.alpha)
    const r = await observeFs(() => validateSelection(d, [idOf(d, 'alpha')]))
    assert.equal(codeOf(r.error), 'projectChanged')
    assert.deepEqual(r.calls.filter(isContent).map(fmt), [])
    // An ancestor becomes a junction to the very same folder: the root keeps its identity through it
    const rootIno = lstatSync(ws.root, { bigint: true }).ino
    const moved = join(ws.base, 'parent moved')
    renameSync(ws.parent, moved)
    linkDir(moved, ws.parent)
    assert.equal(lstatSync(ws.root, { bigint: true }).ino, rootIno)
    const a = await observeFs(() => validateSelection(d, [idOf(d, 'Bëta proj')]))
    assert.equal(codeOf(a.error), 'projectChanged')
    assert.deepEqual(a.calls.filter(isContent).map(fmt), [])
    // Discovering below the linked ancestor shows the root as linked and enumerates nothing
    const again = await observeFs(() => discoverProjects(ws.root))
    assert.deepEqual(again.value!.view.candidates.map(row), [
      ['work space ö', resolve(ws.root), true, 'linked', 'linkedAncestor', moved]
    ])
    assert.deepEqual(again.calls.filter(isContent).map(fmt), [])
  }
)

test('a linked root is shown as linked and not enumerated', async () => {
  const ws = workspace()
  const { value: d, calls } = await observeFs(() => discoverProjects(ws.linked))
  assert.deepEqual(d!.view.candidates.map(row), [
    ['linked', ws.linked, true, 'linked', 'link', ws.outside]
  ])
  assert.deepEqual(d!.bindings.size, 0)
  assert.deepEqual(calls.filter(isContent).map(fmt), [])
  assert.deepEqual(calls.filter((c) => inside(c.path, ws.outside)).map(fmt), [])
})

test('the root must be an existing local absolute folder', async () => {
  const ws = workspace()
  const refused: [string, string][] = [
    ['relative folder', 'unsupportedPath'],
    [join(ws.root, 'missing'), 'notFound'],
    [join(ws.root, 'notes.txt'), 'notADirectory']
  ]
  if (WIN)
    refused.push(
      ['\\\\illithid-test.invalid\\share\\projects', 'unsupportedPath'],
      ['\\\\?\\C:\\projects', 'unsupportedPath'],
      ['\\\\.\\C:\\projects', 'unsupportedPath']
    )
  for (const [root, code] of refused) {
    const r = await observeFs(() => discoverProjects(root))
    assert.equal(codeOf(r.error), code, root)
    if (code === 'unsupportedPath') assert.deepEqual(r.calls.map(fmt), [], root)
  }
})

test('Windows: in a case-sensitive folder, Proj and proj are distinct candidates bound separately', async (t) => {
  if (!WIN) return t.skip('per-folder case sensitivity is a Windows feature')
  const root = join(censusBase(), 'case root')
  mkdirSync(root)
  const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', root, 'enable'])
  if (r.status !== 0) return t.skip(`fsutil setCaseSensitiveInfo unavailable (${r.status})`)
  put(root, 'Proj/AGENTS.md', 'upper\n')
  put(root, 'proj/AGENTS.md', 'lower\n')
  const d = await discoverProjects(root)
  assert.deepEqual(
    d.view.candidates.map((c) => c.name),
    ['case root', 'Proj', 'proj']
  )
  // Replacing Proj leaves proj bound, and the other way round is refused
  renameSync(join(root, 'Proj'), join(root, 'Proj old'))
  mkdirSync(join(root, 'Proj'))
  assert.deepEqual(
    (await validateSelection(d, [idOf(d, 'proj')])).map((c) => c.path),
    [join(root, 'proj')]
  )
  const upper = await observeFs(() => validateSelection(d, [idOf(d, 'Proj')]))
  assert.equal(codeOf(upper.error), 'projectChanged')
})
