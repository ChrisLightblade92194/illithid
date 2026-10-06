/**
 * Project import/delivery, Task 2 (spec 2026-10-06 project delivery §Import selected census items; criteria 1, 2):
 * the backend imports exactly the selected complete census occurrences, rechecks the run, the project identity and the
 * complete source content at the copy boundaries, and cancellation keeps only already registered variants.
 * Synthetic projects and profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createCensusService } from '../src/main/censusIpc'
import type { CensusItem, CensusRunView, CensusDiscovery } from '../src/engine/census/types'
import { globalLibraryDir } from '../src/engine/globalPaths'
import { listGlobalVariants } from '../src/engine/globalVariants'
import { importProjectItems } from '../src/engine/project/import'
import type { ProjectImportResult, ProjectOrigin } from '../src/engine/project/types'
import type { GlobalResult } from '../src/shared/api'
import { contentSnapshot } from './lib/globalFixture'
import {
  copyTree,
  isContent,
  observeFs,
  projectWorkspace,
  put,
  samePath,
  SKILL,
  snapshot
} from './lib/projectFixture'

type Service = ReturnType<typeof createCensusService>

const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

const ok = <T>(r: unknown): T => {
  const x = r as GlobalResult<T>
  assert.equal(x.ok, true, JSON.stringify(x))
  return (x as { ok: true; value: T }).value
}

/** A: Claude skill caveman (+ resource) and AGENTS.md; B: Codex skill caveman with other content, same AGENTS.md */
function workspace(): { root: string; home: string; a: string; b: string } {
  const { root, home } = projectWorkspace()
  const a = join(root, 'A')
  put(a, '.claude/skills/caveman/SKILL.md', SKILL('caveman'))
  put(a, '.claude/skills/caveman/assets/x.bin', Buffer.from([0, 1, 2]))
  put(a, '.claude/skills/caveman/.hidden', 'h\n')
  mkdirSync(join(a, '.claude/skills/caveman/empty'))
  put(a, 'AGENTS.md', '# shared rules\n@docs/more.md\n')
  const b = join(root, 'B')
  put(b, '.agents/skills/caveman/SKILL.md', SKILL('caveman'))
  put(b, '.agents/skills/caveman/assets/x.bin', Buffer.from([9]))
  put(b, 'AGENTS.md', '# shared rules\n@docs/more.md\n')
  put(b, '.claude/rules/team/style.md', '---\npaths: src/**\n---\nUse tabs.\r\n')
  return { root, home, a, b }
}

async function census(
  s: Service,
  root: string,
  names: string[]
): Promise<{ runId: string; items: CensusItem[]; discovery: CensusDiscovery }> {
  const discovery = ok<CensusDiscovery>(await s.handlers.censusDiscover({ root }))
  const candidateIds = names.map((n) => discovery.candidates.find((c) => c.name === n)!.id)
  const { runId } = ok<{ runId: string }>(
    await s.handlers.censusStart({ discoveryId: discovery.id, candidateIds })
  )
  for (let i = 0; i < 400; i++) {
    const v = ok<CensusRunView>(await s.handlers.censusPoll({ runId }))
    if (v.status === 'completed') return { runId, items: v.snapshot!.items, discovery }
    assert.equal(v.status, 'running')
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('census did not complete')
}

const item = (
  items: CensusItem[],
  projectPath: string,
  rel: string,
  d: CensusDiscovery
): CensusItem => {
  const cand = d.candidates.find((c) => samePath(c.path, projectPath))!
  const i = items.find((x) => x.projectId === cand.id && x.relativePath === rel)
  assert.ok(i, `${projectPath} ${rel}`)
  return i
}

/** Library folders without a variant record (an unfinished import) */
function provisional(home: string): string[] {
  const lib = globalLibraryDir(home)
  if (!existsSync(lib)) return []
  return readdirSync(lib).filter((id) => !existsSync(join(lib, id, 'variant.json')))
}

const ctx = (
  home: string,
  signal = new AbortController().signal
): { home: string; signal: AbortSignal } => ({
  home,
  signal
})

test('import_reads_only_selected_occurrences', async () => {
  const { root, home, a, b } = workspace()
  const s = createCensusService('win32')
  const { runId, items, discovery } = await census(s, root, ['A', 'B'])
  const skillA = item(items, a, '.claude/skills/caveman', discovery)
  const skillB = item(items, b, '.agents/skills/caveman', discovery)
  const ruleB = item(items, b, '.claude/rules/team/style.md', discovery)
  const third = item(items, a, 'AGENTS.md', discovery)
  const selectedItemIds = [skillA.id, skillB.id, ruleB.id]
  const sourceBefore = snapshot(root)

  // Request checks happen before any filesystem access
  const refusals = await observeFs(() => {
    const codes: (string | undefined)[] = []
    for (const ids of [[], [skillA.id, skillA.id], ['nope'], [skillA.id, 42]] as unknown[])
      try {
        s.access.acquireImport(runId, ids as string[])
        codes.push('accepted')
      } catch (e) {
        codes.push((e as { code?: string }).code)
      }
    try {
      s.access.acquireImport('other-run', [skillA.id])
      codes.push('accepted')
    } catch (e) {
      codes.push((e as { code?: string }).code)
    }
    return codes
  })
  assert.deepEqual(refusals.value, ['invalid', 'invalid', 'invalid', 'invalid', 'stale'])
  assert.deepEqual(refusals.calls, [])

  const lease = s.access.acquireImport(runId, selectedItemIds)
  const run = await observeFs(() => importProjectItems(ctx(home), lease))
  assert.equal(run.error, undefined, String(run.error))
  const result = run.value as ProjectImportResult
  const importedItemIds = result.items.filter((x) => x.status === 'imported').map((x) => x.itemId)
  assert.deepEqual(importedItemIds.sort(), selectedItemIds.sort())
  assert.equal(result.status, 'completed')
  const unselectedContentReads = run.calls.filter(
    (c) => isContent(c) && samePath(c.path, join(a, 'AGENTS.md'))
  )
  assert.equal(unselectedContentReads.length, 0)
  assert.ok(!result.items.some((x) => x.itemId === third.id))
  const sourceAfter = snapshot(root)
  assert.deepEqual(sourceAfter, sourceBefore)

  // Same-name alternatives become separate variants; each keeps its project provenance and complete tree
  const variants = listGlobalVariants(home)
  assert.equal(variants.length, 3)
  const skills = variants.filter((v) => v.kind === 'skill')
  assert.equal(skills.length, 2)
  assert.notEqual(skills[0].id, skills[1].id)
  assert.deepEqual(
    skills.map((v) => v.name),
    ['caveman', 'caveman']
  )
  for (const v of skills) {
    const o = v.origins[0] as ProjectOrigin
    assert.equal(o.scope, 'project')
    assert.equal(o.tool, undefined)
    assert.equal(o.digestAlgorithm, 'census-skill-v1')
    const src = samePath(o.projectRoot, a)
      ? join(a, '.claude/skills/caveman')
      : join(b, '.agents/skills/caveman')
    assert.deepEqual(contentSnapshot(v.contentPath), contentSnapshot(src))
    assert.equal(o.digest, samePath(o.projectRoot, a) ? skillA.digest : skillB.digest)
  }
  const a0 = skills.find((v) => samePath((v.origins[0] as ProjectOrigin).projectRoot, a))!
  assert.deepEqual((a0.origins[0] as ProjectOrigin).consumers, ['claude', 'opencode'])
  assert.equal((a0.origins[0] as ProjectOrigin).relativePath, '.claude/skills/caveman')
  const rule = variants.find((v) => v.kind === 'rule')!
  assert.equal(rule.name, 'team/style.md')
  assert.deepEqual(
    readFileSync(rule.contentPath),
    readFileSync(join(b, '.claude/rules/team/style.md'))
  )
  assert.deepEqual(result.variantIds.sort(), variants.map((v) => v.id).sort())
  assert.deepEqual(provisional(home), [])

  // The same occurrence again: refused, not duplicated
  const again = await importProjectItems(ctx(home), s.access.acquireImport(runId, [ruleB.id]))
  assert.deepEqual(
    again.items.map((x) => [x.status, x.code]),
    [['refused', 'alreadyImported']]
  )
  assert.equal(listGlobalVariants(home).length, 3)
})

test('import_stales_after_source_or_run_change', async () => {
  const { root, home, a } = workspace()
  const s = createCensusService('win32')
  const { runId, items, discovery } = await census(s, root, ['A', 'B'])
  const skillA = item(items, a, '.claude/skills/caveman', discovery)
  const ruleA = item(items, a, 'AGENTS.md', discovery)
  const skill = join(a, '.claude/skills/caveman')

  const refusedAfter = async (change: () => void, undo: () => void): Promise<void> => {
    change()
    const r = await importProjectItems(ctx(home), s.access.acquireImport(runId, [skillA.id]))
    assert.deepEqual(
      r.items.map((x) => [x.status, x.code]),
      [['refused', 'changedSinceCensus']]
    )
    assert.equal(listGlobalVariants(home).length, 0)
    assert.deepEqual(provisional(home), [])
    undo()
  }
  // Resource-only, hidden-file, empty-folder and .DS_Store changes are all content changes
  await refusedAfter(
    () => writeFileSync(join(skill, 'assets/x.bin'), Buffer.from([0, 1, 3])),
    () => writeFileSync(join(skill, 'assets/x.bin'), Buffer.from([0, 1, 2]))
  )
  await refusedAfter(
    () => put(skill, 'assets/new.txt', 'n\n'),
    () => renameSync(join(skill, 'assets/new.txt'), join(root, 'moved-new.txt'))
  )
  await refusedAfter(
    () => writeFileSync(join(skill, '.hidden'), 'H\n'),
    () => writeFileSync(join(skill, '.hidden'), 'h\n')
  )
  await refusedAfter(
    () => mkdirSync(join(skill, 'empty2')),
    () => renameSync(join(skill, 'empty2'), join(root, 'moved-empty2'))
  )
  await refusedAfter(
    () => put(skill, '.DS_Store/payload.bin', Buffer.from([1])),
    () => renameSync(join(skill, '.DS_Store'), join(root, 'moved-ds'))
  )

  // The project folder replaced by an identical copy: refused, nothing copied
  renameSync(a, join(root, 'A-old'))
  put(a, 'AGENTS.md', '# shared rules\n@docs/more.md\n')
  const replaced = await importProjectItems(ctx(home), s.access.acquireImport(runId, [ruleA.id]))
  assert.deepEqual(
    replaced.items.map((x) => [x.status, x.code]),
    [['refused', 'projectChanged']]
  )
  assert.deepEqual(provisional(home), [])

  // A new census makes the old run's ids stale before any read
  await census(s, root, ['B'])
  assert.throws(() => s.access.acquireImport(runId, [ruleA.id]), { code: 'stale' })
  assert.equal(listGlobalVariants(home).length, 0)
})

test('import_cancel_keeps_only_registered_successes', async () => {
  const { root, home, a, b } = workspace()
  const s = createCensusService('win32')
  const { runId, items, discovery } = await census(s, root, ['A', 'B'])
  const first = item(items, a, '.claude/skills/caveman', discovery)
  const second = item(items, b, '.agents/skills/caveman', discovery)

  // Cancelled right after the first registration: the second is never started
  const c1 = new AbortController()
  const r1 = await importProjectItems(
    ctx(home, c1.signal),
    s.access.acquireImport(runId, [first.id, second.id]),
    {
      afterRegister: () => c1.abort()
    }
  )
  const registeredAfterCancellation = listGlobalVariants(home)
  assert.equal(registeredAfterCancellation.length, 1)
  assert.equal(
    (registeredAfterCancellation[0].origins[0] as ProjectOrigin).relativePath,
    first.relativePath
  )
  const provisionalDirectories = provisional(home)
  assert.equal(provisionalDirectories.length, 0)
  assert.equal(r1.status, 'cancelled')
  assert.deepEqual(
    r1.items.map((x) => x.status),
    ['imported', 'notAttempted']
  )
  assert.deepEqual(r1.variantIds, [registeredAfterCancellation[0].id])

  // Cancelled while the second skill is being copied: its provisional folder is removed, the first stays
  const { root: root2, home: home2, a: a2, b: b2 } = workspace()
  const s2 = createCensusService('win32')
  const run2 = await census(s2, root2, ['A', 'B'])
  const f2 = item(run2.items, a2, '.claude/skills/caveman', run2.discovery)
  const g2 = item(run2.items, b2, '.agents/skills/caveman', run2.discovery)
  const c2 = new AbortController()
  let release: () => void = () => {}
  let held = false
  const lib2 = globalLibraryDir(home2)
  const pending = observeFs(
    () =>
      importProjectItems(
        ctx(home2, c2.signal),
        s2.access.acquireImport(run2.runId, [f2.id, g2.id])
      ),
    {
      hold: (c) => {
        // The copy of the second skill reads its SKILL.md into the library
        if (
          !held &&
          c.fn === 'promises.open' &&
          samePath(c.path, join(b2, '.agents/skills/caveman/SKILL.md')) &&
          provisional(home2).length === 1
        ) {
          held = true
          return new Promise<void>((r) => (release = r))
        }
        return undefined
      }
    }
  )
  pending.catch(() => {})
  for (let i = 0; i < 400 && !held; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(held, 'the copy of the second skill was held')
  assert.equal(provisional(home2).length, 1, 'a provisional folder exists while copying')
  c2.abort()
  release()
  const r2 = (await pending).value as ProjectImportResult
  assert.equal(r2.status, 'cancelled')
  assert.deepEqual(
    r2.items.map((x) => x.status),
    ['imported', 'notAttempted']
  )
  assert.equal(listGlobalVariants(home2).length, 1)
  assert.deepEqual(provisional(home2), [])
  assert.equal(readdirSync(lib2).length, 1)

  // A new census or a new discovery while the second is read: the run's lease is superseded, the queued work stops
  for (const supersede of ['start', 'discover'] as const) {
    const { root: root3, home: home3, a: a3, b: b3 } = workspace()
    const s3 = createCensusService('win32')
    const run3 = await census(s3, root3, ['A', 'B'])
    const f3 = item(run3.items, a3, '.claude/skills/caveman', run3.discovery)
    const g3 = item(run3.items, b3, '.agents/skills/caveman', run3.discovery)
    let release3: () => void = () => {}
    let held3 = false
    const pending3 = observeFs(
      () => importProjectItems(ctx(home3), s3.access.acquireImport(run3.runId, [f3.id, g3.id])),
      {
        hold: (c) => {
          if (
            !held3 &&
            c.fn === 'promises.open' &&
            samePath(c.path, join(b3, '.agents/skills/caveman/SKILL.md'))
          ) {
            held3 = true
            return new Promise<void>((r) => (release3 = r))
          }
          return undefined
        }
      }
    )
    pending3.catch(() => {})
    for (let i = 0; i < 400 && !held3; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(held3)
    if (supersede === 'start')
      ok(
        await s3.handlers.censusStart({
          discoveryId: run3.discovery.id,
          candidateIds: [run3.discovery.candidates.find((c) => c.name === 'B')!.id]
        })
      )
    else ok(await s3.handlers.censusDiscover({ root: root3 }))
    release3()
    const r3 = (await pending3).value as ProjectImportResult
    assert.deepEqual(
      r3.items.map((x) => x.status),
      ['imported', 'notAttempted'],
      supersede
    )
    assert.equal(r3.status, 'cancelled')
    assert.equal(listGlobalVariants(home3).length, 1)
    assert.deepEqual(provisional(home3), [])
  }
})

test('import_refuses_a_skill_swapped_for_an_identical_copy_during_the_copy', async () => {
  const { root, home, a } = workspace()
  const s = createCensusService('win32')
  const { runId, items, discovery } = await census(s, root, ['A'])
  const skillA = item(items, a, '.claude/skills/caveman', discovery)
  const skill = join(a, '.claude/skills/caveman')
  // An identical copy prepared outside the project, swapped in by two renames during the copy
  const twin = join(root, 'twin-caveman')
  copyTree(skill, twin)
  let swapped = false
  const r = await observeFs(
    () => importProjectItems(ctx(home), s.access.acquireImport(runId, [skillA.id])),
    {
      hold: (c) => {
        // During the copy (the library folder exists), the skill folder is replaced by an identical copy
        if (
          !swapped &&
          c.fn === 'promises.open' &&
          samePath(c.path, join(skill, 'SKILL.md')) &&
          provisional(home).length === 1
        ) {
          swapped = true
          renameSync(skill, join(a, '.claude/skills/caveman-old'))
          renameSync(twin, skill)
        }
        return undefined
      }
    }
  )
  assert.ok(swapped)
  const res = r.value as ProjectImportResult
  assert.deepEqual(
    res.items.map((x) => [x.status, x.code]),
    [['refused', 'changedSinceCensus']]
  )
  assert.equal(listGlobalVariants(home).length, 0)
  assert.deepEqual(provisional(home), [])
})

test('no unhandled rejection during the import tests', () => {
  assert.deepEqual(unhandled, [])
})

test('non-Windows import access refuses without reading', async () => {
  const s = createCensusService('linux')
  const r = await observeFs(() => {
    try {
      s.access.acquireImport('run', ['x'])
      return 'accepted'
    } catch (e) {
      return (e as { code?: string }).code
    }
  })
  assert.equal(r.value, 'unsupportedPlatform')
  assert.deepEqual(r.calls, [])
})
