/**
 * Project delivery review finding 2 (spec 2026-10-06 project delivery §Integration and UI boundaries: cancellation,
 * new selections, new roots or leaving a view cannot restore obsolete results): a decision is pending while the
 * backend observes the preview again. A discard or a new discovery meanwhile invalidates it; when the decision
 * settles, no successor is registered and the decided preview is not given back, so nothing obsolete can be applied.
 * Real handlers; the decision is held on its own read inside the project (synthetic projects only).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CensusDiscovery } from '../src/engine/census/types'
import { projectPlanUsed } from '../src/engine/project/plan'
import { projectPlansDir } from '../src/engine/project/state'
import type { ProjectJobView, ProjectPlanView } from '../src/engine/project/types'
import { createCensusService } from '../src/main/censusIpc'
import { projectHandlers } from '../src/main/projectIpc'
import type { GlobalResult } from '../src/shared/api'
import { deliveryWorkspace, inside, observeFs, put, snapshot } from './lib/projectFixture'

const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

type Handlers = ReturnType<typeof projectHandlers>
const D = { type: 'default' } as const
const ok = <T>(r: unknown): T => {
  const x = r as GlobalResult<T>
  assert.equal(x.ok, true, JSON.stringify(x))
  return (x as { ok: true; value: T }).value
}
const code = (r: unknown): string =>
  (r as { ok: boolean }).ok ? 'accepted' : (r as { code: string }).code

async function settle(h: Handlers, jobId: string): Promise<ProjectJobView> {
  for (let i = 0; i < 400; i++) {
    const v = ok<ProjectJobView>(await h.projectPoll({ jobId }))
    if (v.status !== 'running') return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('job did not settle')
}

/** Tries to apply what a decision returned (or a plan id): any write it produced shows in the project snapshot */
async function tryApply(h: Handlers, planId: string | null): Promise<string> {
  if (!planId) return 'none'
  const a = await h.projectApplyStart({ planId })
  if ((a as { ok: boolean }).ok) await settle(h, ok<{ jobId: string }>(a).jobId)
  return code(a)
}
const successorOf = (r: unknown): string | null =>
  (r as { ok: boolean }).ok ? ok<ProjectPlanView>(r).id : null

/** Every plan the backend stored is spent: none can be applied, through any session */
function allSpent(home: string): void {
  for (const f of readdirSync(projectPlansDir(home)).filter((n) => n.endsWith('.json')))
    assert.ok(projectPlanUsed(home, f.slice(0, -5)), `${f} is spent`)
}

async function setup(): Promise<{
  w: Awaited<ReturnType<typeof deliveryWorkspace>>
  h: Handlers
  d: CensusDiscovery
  other: string
}> {
  const w = await deliveryWorkspace()
  const h = projectHandlers(w.home, createCensusService('win32').access, 'win32')
  const d = ok<CensusDiscovery>(await h.projectDiscover({ root: w.root }))
  const other = join(w.base, 'other root')
  put(other, 'X/AGENTS.md', '# x\n')
  return { w, h, d, other }
}

/** A preview of E's AGENTS.md (different content: Skip by default) and the decision replacing it */
async function replacePreview(
  x: Awaited<ReturnType<typeof setup>>
): Promise<{ p0: ProjectPlanView; decisions: unknown[] }> {
  const E = x.d.candidates.find((c) => c.name === 'E')!.id
  const p0 = ok<ProjectPlanView>(
    await x.h.projectPreview({
      discoveryId: x.d.id,
      selections: [{ candidateId: E, variantId: x.w.rule, tool: 'codex', slot: D }]
    })
  )
  assert.equal(p0.changes[0].action, 'skip')
  return {
    p0,
    decisions: [
      { destinationId: p0.changes[0].destinationId, variantId: x.w.rule, action: 'replace' }
    ]
  }
}

/** The real projectDecide, held on its first read inside project E while `during` runs */
async function decideHeld(
  x: Awaited<ReturnType<typeof setup>>,
  planId: string,
  decisions: unknown[],
  during: () => Promise<void>
): Promise<unknown> {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let reached!: () => void
  const atHold = new Promise<void>((r) => (reached = r))
  let held = false
  const run = await observeFs(
    async () => {
      const pending = x.h.projectDecide({ planId, decisions })
      await Promise.race([
        atHold,
        pending.then(() => {
          throw new Error('the decision settled before its read was held')
        })
      ])
      await during()
      release()
      return pending
    },
    {
      hold: (c) => {
        if (!held && inside(c.path, join(x.w.root, 'E'))) {
          held = true
          reached()
          return gate
        }
        return undefined
      }
    }
  )
  if (run.error) throw run.error
  return run.value
}

test('a preview discarded while its decision is pending yields no applicable successor', async () => {
  const x = await setup()
  const { p0, decisions } = await replacePreview(x)
  const before = snapshot(x.w.root)
  let discard: unknown
  const r = await decideHeld(x, p0.id, decisions, async () => {
    discard = await x.h.projectDiscardPlan({ planId: p0.id })
  })
  const applied = await tryApply(x.h, successorOf(r))
  assert.deepEqual(snapshot(x.w.root), before, 'no obsolete successor wrote anything')
  assert.equal(applied, 'none')
  assert.equal(code(r), 'stale')
  assert.deepEqual(ok(discard), { planId: p0.id }, 'the pending preview is discarded')
  assert.equal(await tryApply(x.h, p0.id), 'stale')
  allSpent(x.w.home)
})

test('a new discovery of another root while a decision is pending yields no applicable successor', async () => {
  const x = await setup()
  const { p0, decisions } = await replacePreview(x)
  const before = snapshot(x.w.root)
  let d2: CensusDiscovery | undefined
  const r = await decideHeld(x, p0.id, decisions, async () => {
    d2 = ok<CensusDiscovery>(await x.h.projectDiscover({ root: x.other }))
  })
  const applied = await tryApply(x.h, successorOf(r))
  assert.deepEqual(snapshot(x.w.root), before, 'nothing written into the old root')
  assert.equal(applied, 'none')
  assert.equal(code(r), 'stale')
  assert.equal(await tryApply(x.h, p0.id), 'stale')
  allSpent(x.w.home)
  // The new listing works as usual
  const X = d2!.candidates.find((c) => c.name === 'X')!.id
  const p = ok<ProjectPlanView>(
    await x.h.projectPreview({
      discoveryId: d2!.id,
      selections: [{ candidateId: X, variantId: x.w.rule, tool: 'codex', slot: D }]
    })
  )
  assert.equal(p.changes[0].project.name, 'X')
})

test('an invalid decision gives the preview back only while it is still valid', async () => {
  const x = await setup()
  const B = x.d.candidates.find((c) => c.name === 'B')!.id
  const preview = async (): Promise<ProjectPlanView> =>
    ok<ProjectPlanView>(
      await x.h.projectPreview({
        discoveryId: x.d.id,
        selections: [{ candidateId: B, variantId: x.w.rule, tool: 'codex', slot: D }]
      })
    )
  const invalid = (p: ProjectPlanView): unknown[] => [
    {
      destinationId: p.changes[0].destinationId,
      variantId: 'rule-0000000000000000',
      action: 'replace'
    }
  ]
  const before = snapshot(x.w.root)

  // Unchanged: alone, an invalid decision leaves the preview usable
  const p1 = await preview()
  assert.equal(code(await x.h.projectDecide({ planId: p1.id, decisions: invalid(p1) })), 'invalid')
  assert.deepEqual(ok(await x.h.projectDiscardPlan({ planId: p1.id })), { planId: p1.id })

  // Discarded while the invalid decision is pending: not given back
  const p2 = await preview()
  const pending2 = x.h.projectDecide({ planId: p2.id, decisions: invalid(p2) })
  const discard = await x.h.projectDiscardPlan({ planId: p2.id })
  const r2 = await pending2
  const applied2 = await tryApply(x.h, p2.id)
  assert.deepEqual(snapshot(x.w.root), before, 'the discarded preview wrote nothing')
  assert.equal(applied2, 'stale')
  assert.equal(code(r2), 'stale')
  assert.deepEqual(ok(discard), { planId: p2.id })

  // Superseded by a new discovery while the invalid decision is pending: not given back
  const p3 = await preview()
  const pending3 = x.h.projectDecide({ planId: p3.id, decisions: invalid(p3) })
  ok<CensusDiscovery>(await x.h.projectDiscover({ root: x.other }))
  const r3 = await pending3
  const applied3 = await tryApply(x.h, p3.id)
  assert.deepEqual(
    snapshot(x.w.root),
    before,
    'the superseded preview wrote nothing in the old root'
  )
  assert.equal(applied3, 'stale')
  assert.equal(code(r3), 'stale')
  allSpent(x.w.home)
})

test('no unhandled rejection in the pending decision tests', () => {
  assert.deepEqual(unhandled, [])
})
