/**
 * Project import/delivery, Tasks 3 and 7 (spec 2026-10-06 project delivery §Preview, Apply and restore guarantees,
 * §Integration and UI boundaries): exact request schemas, backend-issued ids only, refusals before any source read,
 * Windows only, and jobs whose results stay pollable after a cancellation. Synthetic projects only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createCensusService } from '../src/main/censusIpc'
import { projectHandlers } from '../src/main/projectIpc'
import type { CensusDiscovery, CensusItem, CensusRunView } from '../src/engine/census/types'
import { listGlobalVariants } from '../src/engine/globalVariants'
import type { ProjectJobView } from '../src/engine/project/types'
import { PROJECT_CHANNELS, type GlobalResult } from '../src/shared/api'
import { inside, observeFs, projectWorkspace, put, samePath, SKILL } from './lib/projectFixture'

const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

type Refusal = { ok: false; code: string; message: string }
const ok = <T>(r: unknown): T => {
  const x = r as GlobalResult<T>
  assert.equal(x.ok, true, JSON.stringify(x))
  return (x as { ok: true; value: T }).value
}
const code = (r: unknown): string | undefined =>
  (r as Refusal).ok === false ? (r as Refusal).code : 'accepted'

async function setup(): Promise<{
  root: string
  home: string
  a: string
  b: string
  s: ReturnType<typeof createCensusService>
  runId: string
  items: CensusItem[]
  discovery: CensusDiscovery
}> {
  const { root, home } = projectWorkspace()
  const a = join(root, 'A')
  put(a, '.claude/skills/caveman/SKILL.md', SKILL('caveman'))
  put(a, '.claude/skills/caveman/assets/x.bin', Buffer.from([1, 2]))
  put(a, 'AGENTS.md', '# a\n')
  const b = join(root, 'B')
  put(b, '.agents/skills/caveman/SKILL.md', SKILL('caveman'))
  put(b, 'CLAUDE.md', '# b\n')
  const s = createCensusService('win32')
  const discovery = ok<CensusDiscovery>(await s.handlers.censusDiscover({ root }))
  const { runId } = ok<{ runId: string }>(
    await s.handlers.censusStart({
      discoveryId: discovery.id,
      candidateIds: discovery.candidates.filter((c) => !c.isRoot).map((c) => c.id)
    })
  )
  for (let i = 0; i < 400; i++) {
    const v = ok<CensusRunView>(await s.handlers.censusPoll({ runId }))
    if (v.status === 'completed')
      return { root, home, a, b, s, runId, items: v.snapshot!.items, discovery }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('census did not complete')
}

const itemAt = (
  x: { items: CensusItem[]; discovery: CensusDiscovery },
  project: string,
  rel: string
): CensusItem => {
  const cand = x.discovery.candidates.find((c) => samePath(c.path, project))!
  return x.items.find((i) => i.projectId === cand.id && i.relativePath === rel)!
}

async function settle(
  h: ReturnType<typeof projectHandlers>,
  jobId: string
): Promise<ProjectJobView> {
  for (let i = 0; i < 400; i++) {
    const v = ok<ProjectJobView>(await h.projectPoll({ jobId }))
    if (v.status !== 'running') return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('job did not settle')
}

test('project_ipc_rejects_schema_widening', async () => {
  const x = await setup()
  const h = projectHandlers(x.home, x.s.access, 'win32')
  const id = itemAt(x, x.a, '.claude/skills/caveman').id
  const widenedRequest = (await h.projectImportStart({
    runId: x.runId,
    itemIds: [id],
    sourcePath: join(x.a, 'AGENTS.md')
  })) as GlobalResult<unknown>
  assert.equal(widenedRequest.ok, false)
  const observed = await observeFs(async () => {
    const out: (string | undefined)[] = []
    for (const args of [
      [],
      [{ runId: x.runId, itemIds: [id] }, {}],
      [[x.runId, [id]]],
      [{ runId: x.runId, itemIds: [id], allowLinks: true }],
      [{ runId: x.runId, itemIds: [id], path: x.a }],
      [{ runId: x.runId }],
      [{ runId: x.runId, itemIds: [] }],
      [{ runId: x.runId, itemIds: [id, id] }],
      [{ runId: x.runId, itemIds: ['foreign-id'] }],
      [{ runId: x.runId, itemIds: [join(x.a, '.claude', 'skills', 'caveman')] }],
      [{ runId: x.runId, itemIds: [id, 7] }],
      [{ runId: 12, itemIds: [id] }],
      [{ runId: 'another-run', itemIds: [id] }]
    ] as unknown[][])
      out.push(code(await h.projectImportStart(...args)))
    out.push(code(await h.projectPoll({ jobId: 'job-unknown' })))
    out.push(code(await h.projectPoll({ jobId: 'job-unknown', extra: 1 })))
    out.push(code(await h.projectCancel({})))
    return out
  })
  assert.deepEqual(observed.value, [
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'stale',
    'notFound',
    'invalid',
    'invalid'
  ])
  const refusedSourceReads = observed.calls.filter(
    (c) => inside(c.path, x.root) || samePath(c.path, x.root)
  )
  assert.equal(refusedSourceReads.length, 0)
  assert.deepEqual(observed.calls, [])
  assert.equal(listGlobalVariants(x.home).length, 0)

  // Every project channel refuses on other platforms, before any filesystem access
  const linux = projectHandlers(x.home, x.s.access, 'linux')
  const none = await observeFs(async () =>
    Promise.all(
      PROJECT_CHANNELS.map(async (c) => code(await linux[c]({ runId: x.runId, itemIds: [id] })))
    )
  )
  const nonWindows = { code: none.value![0] }
  assert.equal(nonWindows.code, 'unsupportedPlatform')
  assert.deepEqual(
    none.value,
    PROJECT_CHANNELS.map(() => 'unsupportedPlatform')
  )
  assert.deepEqual(none.calls, [])
})

test('project import jobs report per-item outcomes and keep their result after a cancellation', async () => {
  const x = await setup()
  const h = projectHandlers(x.home, x.s.access, 'win32')
  const skillA = itemAt(x, x.a, '.claude/skills/caveman')
  const ruleB = itemAt(x, x.b, 'CLAUDE.md')
  const { jobId } = ok<{ jobId: string }>(
    await h.projectImportStart({ runId: x.runId, itemIds: [ruleB.id, skillA.id] })
  )
  const done = await settle(h, jobId)
  assert.equal(done.kind, 'import')
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.progress, { done: 2, total: 2 })
  const r = done.result as { items: { itemId: string; status: string }[]; variantIds: string[] }
  assert.deepEqual(
    r.items.map((i) => [i.itemId, i.status]),
    [
      [ruleB.id, 'imported'],
      [skillA.id, 'imported']
    ]
  )
  assert.equal(r.variantIds.length, 2)
  // Still pollable later
  assert.deepEqual(ok<ProjectJobView>(await h.projectPoll({ jobId })), done)

  // Cancelled while the second item is read: the first stays imported and the job says so
  const y = await setup()
  const hy = projectHandlers(y.home, y.s.access, 'win32')
  const first = itemAt(y, y.b, 'CLAUDE.md')
  const second = itemAt(y, y.a, '.claude/skills/caveman')
  let release: () => void = () => {}
  let held = false
  let jobY = ''
  const pending = observeFs(
    async () => {
      jobY = ok<{ jobId: string }>(
        await hy.projectImportStart({ runId: y.runId, itemIds: [first.id, second.id] })
      ).jobId
      for (let i = 0; i < 400 && !held; i++) await new Promise((r) => setTimeout(r, 10))
      const cancelled = ok<ProjectJobView>(await hy.projectCancel({ jobId: jobY }))
      assert.equal(cancelled.cancelRequested, true)
      release()
      return settle(hy, jobY)
    },
    {
      hold: (c) => {
        if (
          !held &&
          c.fn === 'promises.open' &&
          samePath(c.path, join(y.a, '.claude/skills/caveman/SKILL.md'))
        ) {
          held = true
          return new Promise<void>((r) => (release = r))
        }
        return undefined
      }
    }
  )
  const settled = (await pending).value as ProjectJobView
  assert.ok(held)
  assert.equal(settled.status, 'cancelled')
  const ry = settled.result as { items: { status: string }[]; variantIds: string[] }
  assert.deepEqual(
    ry.items.map((i) => i.status),
    ['imported', 'notAttempted']
  )
  assert.equal(listGlobalVariants(y.home).length, 1)
  assert.deepEqual(ok<ProjectJobView>(await hy.projectPoll({ jobId: jobY })), settled)
})

test('no unhandled rejection in the project IPC tests', () => {
  assert.deepEqual(unhandled, [])
})
