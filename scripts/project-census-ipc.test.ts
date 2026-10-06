/**
 * Project census, Task 3 (spec 2026-10-06 §Read boundaries, §Integration boundaries, criteria 2, 7, 8): census IPC
 * requests with exact keys, refusals before any configuration read, asynchronous runs with cancellation and superseded
 * replies, and read-only details bound to inventory item ids. Synthetic trees only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { censusHandlers } from '../src/main/censusIpc'
import { scanProjects, type ScanOptions } from '../src/engine/census/scan'
import type {
  CensusDetails,
  CensusDiscovery,
  CensusItem,
  CensusRunView
} from '../src/engine/census/types'
import { CENSUS_CHANNELS, type GlobalResult } from '../src/shared/api'
import {
  censusBase,
  fmt,
  isContent,
  linkDir,
  observeFs,
  put,
  samePath,
  type FsCall
} from './lib/censusFixture'

type Handlers = ReturnType<typeof censusHandlers>
type Refusal = { ok: false; code: string; message: string }

const SKILL = '---\nname: tool\n---\nbody\n'

interface Ws {
  base: string
  root: string
  p1: string
  p2: string
}

function workspace(): Ws {
  const base = censusBase()
  const root = join(base, 'ipc ö')
  const p1 = join(root, 'p1')
  put(p1, 'CLAUDE.md', 'a\nb\n')
  put(p1, 'AGENTS.md', 'same\n')
  put(p1, '.claude/skills/tool/SKILL.md', SKILL)
  put(p1, '.claude/skills/tool/assets/x.bin', Buffer.from([1]))
  put(p1, '.claude/skills/broken/SKILL.md', SKILL)
  const p2 = join(root, 'p2')
  put(p2, 'CLAUDE.md', 'a\r\nb\r\n')
  put(p2, '.claude/rules/same.md', 'same\n')
  put(p2, '.claude/skills/tool/SKILL.md', SKILL)
  put(p2, '.claude/skills/tool/assets/x.bin', Buffer.from([2]))
  const outside = join(base, 'outside')
  mkdirSync(outside)
  linkDir(outside, join(root, 'zz linked'))
  linkDir(outside, join(p1, '.claude/skills/broken/assets'))
  return { base, root, p1, p2 }
}

const ok = <T>(r: unknown): T => {
  const x = r as GlobalResult<T>
  assert.equal(x.ok, true, JSON.stringify(x))
  return (x as { ok: true; value: T }).value
}
const code = (r: unknown): string | undefined =>
  (r as Refusal).ok === false ? (r as Refusal).code : undefined
const cid = (d: CensusDiscovery, name: string): string => {
  const c = d.candidates.find((x) => x.name === name)
  assert.ok(c, name)
  return c.id
}

async function discover(h: Handlers, root: string): Promise<CensusDiscovery> {
  return ok<CensusDiscovery>(await h.censusDiscover({ root }))
}
async function settle(h: Handlers, runId: string): Promise<CensusRunView> {
  for (let i = 0; i < 400; i++) {
    const v = ok<CensusRunView>(await h.censusPoll({ runId }))
    if (v.status !== 'running') return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('run did not settle')
}
async function completedRun(
  h: Handlers,
  ws: Ws
): Promise<{ d: CensusDiscovery; runId: string; view: CensusRunView }> {
  const d = await discover(h, ws.root)
  const { runId } = ok<{ runId: string }>(
    await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1'), cid(d, 'p2')] })
  )
  const view = await settle(h, runId)
  assert.equal(view.status, 'completed', view.reason)
  return { d, runId, view }
}
const itemOf = (v: CensusRunView, project: string, rel: string): CensusItem => {
  const p = v.snapshot!.projects.find((x) => x.name === project)!
  const i = v.snapshot!.items.find((x) => x.projectId === p.candidateId && x.relativePath === rel)
  assert.ok(i, `${project}:${rel}`)
  return i
}

/** A scanner that runs the real scan, then holds its reply until released; records the options it received */
function heldScan(): {
  scan: typeof scanProjects
  release: () => void
  options: ScanOptions[]
} {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const options: ScanOptions[] = []
  return {
    options,
    release: () => open(),
    scan: async (d, ids, o) => {
      options.push(o)
      const first = options.length === 1
      const s = await scanProjects(d, ids, o)
      if (first) await gate
      return s
    }
  }
}
const ticks = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

test('every census channel refuses non-Windows platforms without filesystem access', async () => {
  const ws = workspace()
  for (const platform of ['linux', 'darwin'] as const) {
    const h = censusHandlers(platform)
    const r = await observeFs(async () => {
      const out: unknown[] = []
      out.push(await h.censusDiscover({ root: ws.root }))
      out.push(await h.censusStart({ discoveryId: 'd', candidateIds: ['c'] }))
      out.push(await h.censusPoll({ runId: 'r' }))
      out.push(await h.censusCancel({ runId: 'r' }))
      out.push(await h.censusInspect({ runId: 'r', leftId: 'a', rightId: 'b' }))
      return out
    })
    assert.deepEqual(r.value!.map(code), Array(5).fill('unsupportedPlatform'), platform)
    assert.deepEqual(r.calls.map(fmt), [], platform)
  }
  assert.deepEqual(Object.keys(censusHandlers('win32')).sort(), [...CENSUS_CHANNELS].sort())
})

test('requests need exactly their keys and types; every refusal comes before any configuration read', async () => {
  const ws = workspace()
  const h = censusHandlers('win32')
  const old = await discover(h, ws.root)
  const d = await discover(h, ws.root)
  const p1 = cid(d, 'p1')
  const cases: [string, keyof Handlers, unknown[], string][] = [
    ['no request', 'censusDiscover', [], 'invalid'],
    ['bare string', 'censusDiscover', [ws.root], 'invalid'],
    ['missing root', 'censusDiscover', [{}], 'invalid'],
    ['root not a string', 'censusDiscover', [{ root: 1 }], 'invalid'],
    ['extra field', 'censusDiscover', [{ root: ws.root, allowLinks: true }], 'invalid'],
    ['extra argument', 'censusDiscover', [{ root: ws.root }, { allowLinks: true }], 'invalid'],
    [
      'allowLinks',
      'censusStart',
      [{ discoveryId: d.id, candidateIds: [p1], allowLinks: true }],
      'invalid'
    ],
    ['empty selection', 'censusStart', [{ discoveryId: d.id, candidateIds: [] }], 'invalid'],
    ['duplicate', 'censusStart', [{ discoveryId: d.id, candidateIds: [p1, p1] }], 'invalid'],
    ['a path as id', 'censusStart', [{ discoveryId: d.id, candidateIds: [ws.p1] }], 'invalid'],
    ['ids not a list', 'censusStart', [{ discoveryId: d.id, candidateIds: p1 }], 'invalid'],
    ['id not a string', 'censusStart', [{ discoveryId: d.id, candidateIds: [7] }], 'invalid'],
    [
      'copied id',
      'censusStart',
      [{ discoveryId: d.id, candidateIds: [cid(old, 'p1')] }],
      'invalid'
    ],
    [
      'linked candidate',
      'censusStart',
      [{ discoveryId: d.id, candidateIds: [cid(d, 'zz linked')] }],
      'invalid'
    ],
    [
      'superseded discovery',
      'censusStart',
      [{ discoveryId: old.id, candidateIds: [cid(old, 'p1')] }],
      'stale'
    ],
    ['unknown discovery', 'censusStart', [{ discoveryId: 'nope', candidateIds: [p1] }], 'stale'],
    ['poll extra', 'censusPoll', [{ runId: 'r', path: ws.p1 }], 'invalid'],
    ['poll number', 'censusPoll', [{ runId: 1 }], 'invalid'],
    ['poll unknown', 'censusPoll', [{ runId: 'nope' }], 'stale'],
    ['cancel unknown', 'censusCancel', [{ runId: 'nope' }], 'stale'],
    [
      'inspect path',
      'censusInspect',
      [{ runId: 'r', leftId: 'a', rightId: 'b', path: ws.p1 }],
      'invalid'
    ],
    ['inspect unknown', 'censusInspect', [{ runId: 'r', leftId: 'a', rightId: 'b' }], 'stale']
  ]
  for (const [label, ch, args, want] of cases) {
    const r = await observeFs(() => h[ch](...args))
    assert.equal(code(r.value), want, label)
    assert.deepEqual(r.calls.map(fmt), [], label)
  }
  // The current discovery is still usable after all these refusals
  const { runId } = ok<{ runId: string }>(
    await h.censusStart({ discoveryId: d.id, candidateIds: [p1] })
  )
  assert.equal((await settle(h, runId)).status, 'completed')
})

test('start rechecks identities: a project recreated after discovery is refused before any read', async () => {
  const ws = workspace()
  const h = censusHandlers('win32')
  const d = await discover(h, ws.root)
  renameSync(ws.p2, join(ws.base, 'p2 old'))
  put(ws.p2, 'CLAUDE.md', 'a\r\nb\r\n')
  const r = await observeFs(() =>
    h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1'), cid(d, 'p2')] })
  )
  assert.equal(code(r.value), 'projectChanged')
  assert.deepEqual(r.calls.filter(isContent).map(fmt), [])
})

test('a run replies promptly, shows progress while the scan is held, then its snapshot', async () => {
  const ws = workspace()
  const held = heldScan()
  const h = censusHandlers('win32', held.scan)
  const d = await discover(h, ws.root)
  const { runId } = ok<{ runId: string }>(
    await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1')] })
  )
  // The real scan finishes while its reply is held: polling shows progress, no snapshot
  let running = ok<CensusRunView>(await h.censusPoll({ runId }))
  for (let i = 0; i < 400 && running.progress.projectsCompleted < 1; i++) {
    await new Promise((r) => setTimeout(r, 10))
    running = ok<CensusRunView>(await h.censusPoll({ runId }))
  }
  assert.equal(running.status, 'running')
  assert.equal(running.snapshot, undefined)
  assert.deepEqual([running.progress.projectsTotal, running.progress.projectsCompleted], [1, 1])
  held.release()
  const done = await settle(h, runId)
  assert.equal(done.status, 'completed')
  assert.deepEqual(
    done.snapshot!.items.map((i) => [i.relativePath, i.outcome]),
    [
      ['AGENTS.md', 'complete'],
      ['CLAUDE.md', 'complete'],
      ['.claude/skills/broken', 'linked'],
      ['.claude/skills/tool', 'complete']
    ]
  )
})

test('cancel: the scanner is signalled and the late reply never restores the cancelled snapshot', async () => {
  const ws = workspace()
  const held = heldScan()
  const h = censusHandlers('win32', held.scan)
  const d = await discover(h, ws.root)
  const { runId } = ok<{ runId: string }>(
    await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1'), cid(d, 'p2')] })
  )
  assert.deepEqual(ok(await h.censusCancel({ runId })), { runId, status: 'cancelled' })
  assert.equal(held.options[0].signal.aborted, true)
  held.release()
  await ticks()
  const v = ok<CensusRunView>(await h.censusPoll({ runId }))
  assert.equal(v.status, 'cancelled')
  assert.equal(v.snapshot, undefined)
  assert.equal(code(await h.censusInspect({ runId, leftId: 'a', rightId: 'b' })), 'stale')
})

test('superseded runs: a new start or a new discovery makes the old run stale, even when its reply arrives later', async () => {
  const ws = workspace()
  for (const supersede of ['start', 'discover'] as const) {
    const held = heldScan()
    const h = censusHandlers('win32', held.scan)
    const d = await discover(h, ws.root)
    const first = ok<{ runId: string }>(
      await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1'), cid(d, 'p2')] })
    ).runId
    let second: string | null = null
    if (supersede === 'start')
      second = ok<{ runId: string }>(
        await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p2')] })
      ).runId
    else await discover(h, ws.root)
    assert.equal(held.options[0].signal.aborted, true, supersede)
    held.release()
    await ticks()
    assert.equal(code(await h.censusPoll({ runId: first })), 'stale', supersede)
    if (second) {
      const v = await settle(h, second)
      assert.deepEqual(
        v.snapshot!.projects.map((p) => p.name),
        ['p2']
      )
    }
  }
})

test('an asynchronous scanner failure becomes a failed run, without an unhandled rejection', async () => {
  const ws = workspace()
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown): void => void unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const h = censusHandlers('win32', async () => {
      await ticks(2)
      throw new Error('scanner exploded')
    })
    const d = await discover(h, ws.root)
    const { runId } = ok<{ runId: string }>(
      await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1')] })
    )
    const v = await settle(h, runId)
    assert.equal(v.status, 'failed')
    assert.match(v.reason ?? '', /scanner exploded/)
    assert.equal(v.snapshot, undefined)
    await ticks()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('inspect accepts only two different complete items of one kind from the completed current run', async () => {
  const ws = workspace()
  const h = censusHandlers('win32')
  const held = heldScan()
  const hh = censusHandlers('win32', held.scan)
  // Not completed yet
  const d0 = await discover(hh, ws.root)
  const pending = ok<{ runId: string }>(
    await hh.censusStart({ discoveryId: d0.id, candidateIds: [cid(d0, 'p1')] })
  ).runId
  assert.equal(code(await hh.censusInspect({ runId: pending, leftId: 'a', rightId: 'b' })), 'stale')
  held.release()
  const { runId, view } = await completedRun(h, ws)
  const claude = itemOf(view, 'p1', 'CLAUDE.md').id
  const skill = itemOf(view, 'p1', '.claude/skills/tool').id
  const broken = itemOf(view, 'p1', '.claude/skills/broken').id
  const cases: [string, unknown, string][] = [
    ['same item twice', { runId, leftId: claude, rightId: claude }, 'invalid'],
    ['unknown item', { runId, leftId: claude, rightId: 'nope' }, 'invalid'],
    ['a path as item', { runId, leftId: claude, rightId: join(ws.p2, 'CLAUDE.md') }, 'invalid'],
    ['rule and skill', { runId, leftId: claude, rightId: skill }, 'invalid'],
    ['incomplete item', { runId, leftId: skill, rightId: broken }, 'invalid']
  ]
  for (const [label, req, want] of cases) {
    const r = await observeFs(() => h.censusInspect(req))
    assert.equal(code(r.value), want, label)
    assert.deepEqual(r.calls.map(fmt), [], label)
  }
  // Items of a previous run are not items of the current one
  const again = await completedRun(h, ws)
  const r = await h.censusInspect({
    runId: again.runId,
    leftId: claude,
    rightId: itemOf(again.view, 'p2', 'CLAUDE.md').id
  })
  assert.equal(code(r), 'invalid')
})

test('rule details: both texts with line endings and encoding; a rule edited or a project replaced since is refused', async () => {
  const ws = workspace()
  const h = censusHandlers('win32')
  const { runId, view } = await completedRun(h, ws)
  const left = itemOf(view, 'p1', 'CLAUDE.md').id
  const right = itemOf(view, 'p2', 'CLAUDE.md').id
  const det = ok<CensusDetails>(await h.censusInspect({ runId, leftId: left, rightId: right }))
  assert.equal(det.kind, 'rule')
  if (det.kind !== 'rule') return
  assert.equal(det.identical, false)
  const side = (s: typeof det.left): unknown[] => [
    s.fullPath,
    s.relativePath,
    s.bytes,
    s.encoding,
    s.lineEndings,
    s.text,
    s.truncated
  ]
  assert.deepEqual(side(det.left), [
    join(ws.p1, 'CLAUDE.md'),
    'CLAUDE.md',
    4,
    'utf-8',
    'lf',
    'a\nb\n',
    false
  ])
  assert.deepEqual(side(det.right), [
    join(ws.p2, 'CLAUDE.md'),
    'CLAUDE.md',
    6,
    'utf-8',
    'crlf',
    'a\r\nb\r\n',
    false
  ])
  // Same length, other bytes: details refuse to mix the census with the file as it is now
  writeFileSync(join(ws.p2, 'CLAUDE.md'), 'a\r\nc\r\n')
  assert.equal(
    code(await h.censusInspect({ runId, leftId: left, rightId: right })),
    'changedSinceCensus'
  )
  renameSync(ws.p1, join(ws.base, 'p1 old'))
  put(ws.p1, 'CLAUDE.md', 'a\nb\n')
  assert.equal(
    code(await h.censusInspect({ runId, leftId: left, rightId: right })),
    'projectChanged'
  )
})

test('rule previews: at most 200 KiB per side, marked truncated, cut on a character; the comparison covers the whole file', async () => {
  const base = censusBase()
  const root = join(base, 'previews ö')
  const KiB = 1024
  const head = 'a'.repeat(200 * KiB - 1) + 'é' // the cut at 200 KiB falls inside é
  put(join(root, 'p1'), 'CLAUDE.md', head + 'tail one\n')
  put(join(root, 'p2'), 'CLAUDE.md', head + 'tail two\n')
  put(join(root, 'p1'), 'AGENTS.md', 'x'.repeat(200 * KiB))
  put(join(root, 'p2'), 'AGENTS.md', 'y'.repeat(200 * KiB))
  put(join(root, 'p1'), 'CLAUDE.local.md', Buffer.from([0xff, 0x00, 0xc3, 0x28]))
  put(join(root, 'p2'), 'CLAUDE.local.md', Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))
  put(join(root, 'p1'), 'AGENTS.override.md', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d]))
  put(join(root, 'p2'), 'AGENTS.override.md', Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x0a]))
  const h = censusHandlers('win32')
  const { runId, view } = await completedRun(h, { base, root, p1: '', p2: '' })
  const rules = async (rel: string): Promise<Extract<CensusDetails, { kind: 'rule' }>> =>
    ok(
      await h.censusInspect({
        runId,
        leftId: itemOf(view, 'p1', rel).id,
        rightId: itemOf(view, 'p2', rel).id
      })
    )
  const long = await rules('CLAUDE.md')
  assert.equal(long.identical, false)
  for (const s of [long.left, long.right]) {
    assert.deepEqual([s.truncated, s.encoding, s.text], [true, 'utf-8', 'a'.repeat(200 * KiB - 1)])
    assert.equal(s.bytes, 200 * KiB + 1 + 9)
  }
  const exact = await rules('AGENTS.md')
  assert.deepEqual(
    [exact.left.truncated, exact.left.text?.length, exact.right.text?.slice(0, 3)],
    [false, 200 * KiB, 'yyy']
  )
  const enc = await rules('CLAUDE.local.md')
  assert.deepEqual([enc.left.encoding, enc.left.text], ['unknown', null])
  assert.deepEqual([enc.right.encoding, enc.right.text], ['utf-16le-bom', 'hi'])
  const bom = await rules('AGENTS.override.md')
  assert.deepEqual(
    [bom.left.encoding, bom.left.text, bom.left.lineEndings],
    ['utf-8-bom', 'hi\r', 'cr']
  )
  assert.deepEqual(
    [bom.right.encoding, bom.right.text, bom.right.lineEndings],
    ['utf-16be-bom', 'h\n', 'lf']
  )
})

test('skill details compare the cached manifests without touching the filesystem', async () => {
  const ws = workspace()
  const h = censusHandlers('win32')
  const { runId, view } = await completedRun(h, ws)
  const r = await observeFs(() =>
    h.censusInspect({
      runId,
      leftId: itemOf(view, 'p1', '.claude/skills/tool').id,
      rightId: itemOf(view, 'p2', '.claude/skills/tool').id
    })
  )
  const det = ok<CensusDetails>(r.value)
  assert.equal(det.kind, 'skill')
  if (det.kind !== 'skill') return
  assert.deepEqual([det.added, det.removed, det.changed], [[], [], ['assets/x.bin']])
  assert.deepEqual(
    [det.left.fullPath, det.right.fullPath],
    [join(ws.p1, '.claude/skills/tool'), join(ws.p2, '.claude/skills/tool')]
  )
  assert.deepEqual(
    r.calls.map((c: FsCall) => fmt(c)),
    []
  )
})

test('rule details stop at Cancel, a new discovery or a new start: no further read, no details returned', async () => {
  for (const by of ['cancel', 'discover', 'start'] as const) {
    const ws = workspace()
    let scans = 0
    // The first census is real; a superseding one never settles and reads nothing
    const h = censusHandlers('win32', (d, ids, o) =>
      scans++ === 0 ? scanProjects(d, ids, o) : new Promise(() => {})
    )
    const { d, runId, view } = await completedRun(h, ws)
    const left = join(ws.p1, 'CLAUDE.md')
    const right = join(ws.p2, 'CLAUDE.md')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const atOpen = new Promise<void>((r) => (reached = r))
    let held = false
    const hold = (c: FsCall): Promise<void> | undefined => {
      if (held || c.fn !== 'promises.open' || !(samePath(c.path, left) || samePath(c.path, right)))
        return undefined
      held = true
      reached()
      return gate
    }
    const pending = observeFs(
      () =>
        h.censusInspect({
          runId,
          leftId: itemOf(view, 'p1', 'CLAUDE.md').id,
          rightId: itemOf(view, 'p2', 'CLAUDE.md').id
        }),
      { hold }
    )
    await atOpen
    if (by === 'cancel')
      assert.deepEqual(ok(await h.censusCancel({ runId })), { runId, status: 'cancelled' })
    if (by === 'discover') await discover(h, ws.root)
    if (by === 'start')
      ok(await h.censusStart({ discoveryId: d.id, candidateIds: [cid(d, 'p1'), cid(d, 'p2')] }))
    // The open already under way completes; nothing queued after it starts, and no details come back
    release()
    const r = await pending
    assert.deepEqual(
      r.calls.filter((c) => c.fn === 'promises.open').map((c) => c.path),
      [left],
      by
    )
    assert.equal(code(r.value), 'stale', by)
  }
})
