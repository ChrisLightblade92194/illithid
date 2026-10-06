/**
 * Project census, Task 4 — the Windows census view (spec 2026-10-06 §User flow, criteria 8, 9). Runs the built app
 * (`npm run build` first) with the real registered main handlers, on synthetic profiles and project trees only. The
 * folder picker reply and the census channels are re-registered around their real handlers (ILLITHID_TEST seam) to
 * record what the renderer sends and to hold replies. Screenshots go to ILLITHID_SHOTS (or a temp folder).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import type { CensusDiscovery } from '../src/engine/census/types'
import { CENSUS_CHANNELS } from '../src/shared/api'
import { censusBase, linkDir, put, snapshot, syntheticGlobalState } from './lib/censusFixture'

const shots = process.env['ILLITHID_SHOTS'] ?? mkdtempSync(join(tmpdir(), 'illithid-census-shots-'))
mkdirSync(shots, { recursive: true })

interface Ws {
  base: string
  home: string
  root: string
  other: string
}

/** Two projects to compare, one left unselected, a linked folder, a grandchild; a second root to switch to */
function workspace(): Ws {
  const base = censusBase()
  const root = join(base, 'projects ö')
  const S = '---\nname: tool\n---\nbody\n'
  put(root, 'p1/CLAUDE.md', 'a\nb\n')
  put(root, 'p1/AGENTS.md', 'same\n')
  put(root, 'p1/.claude/skills/tool/SKILL.md', S)
  put(root, 'p1/.claude/skills/tool/assets/x.bin', Buffer.from([1]))
  put(root, 'p1/deep/AGENTS.md', '# grandchild\n')
  put(root, 'p2/CLAUDE.md', 'a\r\nb\r\n')
  put(root, 'p2/.claude/rules/same.md', 'same\n')
  put(root, 'p2/.agents/skills/tool/SKILL.md', S)
  put(root, 'p2/.agents/skills/tool/assets/x.bin', Buffer.from([2]))
  put(root, 'p3/AGENTS.md', 'same\n')
  put(base, 'outside/AGENTS.md', '# behind a link\n')
  linkDir(join(base, 'outside'), join(root, 'zz linked'))
  const other = join(base, 'other root')
  put(other, 'q1/AGENTS.md', '# q1\n')
  put(other, 'q2/AGENTS.md', '# q2\n')
  return { base, home: syntheticGlobalState(base), root, other }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    HOME: home,
    LANG: 'en_US.UTF-8',
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-census-ud-')),
    ILLITHID_TEST: '1'
  }
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await probe(app)
  return { app, page }
}

/** Main-process globals of the IPC wrappers (test mode exposes the registered handlers) */
interface Probe {
  __illithidHandlers?: Record<string, (...a: unknown[]) => Promise<unknown>>
  __pick: string | null
  __calls: { ch: string; arg: unknown; value: unknown }[]
  /** Channels whose next matching reply is held until released */
  __holdNext: Record<string, boolean>
  __release: Record<string, (() => void) | undefined>
  __heldCount: Record<string, number>
  __doneCount: Record<string, number>
}

// The functions passed to app.evaluate run in the main process: no named inner functions (tsx would wrap them in a
// helper that does not exist there)
async function probe(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, channels: string[]) => {
      const g = globalThis as unknown as Probe
      const h = g.__illithidHandlers!
      g.__pick = null
      g.__calls = []
      g.__holdNext = {}
      g.__release = {}
      g.__heldCount = {}
      g.__doneCount = {}
      ipcMain.removeHandler('api:pickDirectory')
      ipcMain.handle('api:pickDirectory', async () => g.__pick)
      for (const ch of channels) {
        ipcMain.removeHandler(`api:${ch}`)
        ipcMain.handle(`api:${ch}`, async (_e, ...a: unknown[]) => {
          const value = await h[ch](...a)
          g.__calls.push({ ch, arg: JSON.parse(JSON.stringify(a[0] ?? null)), value })
          const v = value as { ok?: boolean; value?: { status?: string } }
          // A poll is held only once it carries a completed snapshot (the reply that would show results)
          const matches = ch !== 'censusPoll' || v.value?.status === 'completed'
          if (g.__holdNext[ch] && matches) {
            g.__holdNext[ch] = false
            g.__heldCount[ch] = (g.__heldCount[ch] ?? 0) + 1
            await new Promise<void>((r) => (g.__release[ch] = r))
          }
          g.__doneCount[ch] = (g.__doneCount[ch] ?? 0) + 1
          return value
        })
      }
    },
    [...CENSUS_CHANNELS]
  )
}

const setPick = (app: ElectronApplication, dir: string): Promise<void> =>
  app.evaluate((_e, d: string) => {
    ;(globalThis as unknown as Probe).__pick = d
  }, dir)
const holdNext = (app: ElectronApplication, ch: string): Promise<void> =>
  app.evaluate((_e, c: string) => {
    ;(globalThis as unknown as Probe).__holdNext[c] = true
  }, ch)
const read = async <K extends keyof Probe>(app: ElectronApplication, key: K): Promise<Probe[K]> =>
  (await app.evaluate(
    (_e, k: string) => (globalThis as unknown as Record<string, unknown>)[k],
    key as string
  )) as Probe[K]
const calls = async (app: ElectronApplication, ch: string): Promise<Probe['__calls']> =>
  (await read(app, '__calls')).filter((c) => c.ch === ch)

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const heldCount = async (app: ElectronApplication, ch: string): Promise<number> =>
  (await read(app, '__heldCount'))[ch] ?? 0

/** Releases the held reply of ch and returns once it reached the renderer and React has rendered */
async function deliverLate(app: ElectronApplication, page: Page, ch: string): Promise<void> {
  const before = (await read(app, '__doneCount'))[ch] ?? 0
  await app.evaluate((_e, c: string) => {
    const g = globalThis as unknown as Probe
    const open = g.__release[c]
    g.__release[c] = undefined
    if (open) open()
  }, ch)
  await until(
    `the late ${ch} reply`,
    async () => ((await read(app, '__doneCount'))[ch] ?? 0) > before
  )
  // A later round trip on the same IPC pipe: the delayed reply was delivered before it
  await page.evaluate(() =>
    (window as unknown as { api: { appVersion: () => Promise<unknown> } }).api.appVersion()
  )
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
  )
  await page.waitForTimeout(600)
}

const names = (page: Page): Promise<string[]> =>
  page
    .locator('[data-testid="census-candidate"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-name') ?? ''))
const rels = (page: Page): Promise<string[]> =>
  page
    .locator('[data-testid="census-item"]')
    .evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-project')}:${e.getAttribute('data-rel')}`)
    )

async function chooseRoot(app: ElectronApplication, page: Page, dir: string): Promise<void> {
  await setPick(app, dir)
  await page.getByTestId('census-choose-root').click()
}
async function runCensus(page: Page, projects: string[]): Promise<void> {
  for (const p of projects) await page.getByTestId(`census-check-${p}`).check()
  await page.getByTestId('census-run').click()
}
const discovered = async (app: ElectronApplication): Promise<CensusDiscovery> => {
  const d = (await calls(app, 'censusDiscover')).at(-1)!.value as { value: CensusDiscovery }
  return d.value
}
const idOf = (d: CensusDiscovery, name: string): string =>
  d.candidates.find((c) => c.name === name)!.id
const lastStart = async (app: ElectronApplication): Promise<string> =>
  ((await calls(app, 'censusStart')).at(-1)!.value as { value: { runId: string } }).value.runId

test(
  'census: choose a root, select projects by hand, compare equal content and same-name differences; no global action or write',
  { timeout: 240000 },
  async () => {
    const ws = workspace()
    const watched = [
      ws.root,
      join(ws.home, '.claude'),
      join(ws.home, '.codex'),
      join(ws.home, '.config/opencode'),
      join(ws.home, '.illithid'),
      join(ws.home, '.config/illithid/global')
    ]
    const before = watched.map((d) => snapshot(d))
    const { app, page } = await launch(ws.home)
    try {
      await page.getByTestId('nav-census').click()
      // The census view offers no global import or apply
      assert.equal(await page.getByTestId('open-import').count(), 0)
      assert.equal(await page.getByTestId('open-preview').count(), 0)
      await chooseRoot(app, page, ws.root)
      await page.getByTestId('census-candidate').first().waitFor()
      assert.equal(await page.getByTestId('census-root').textContent(), ws.root)
      // Root plus immediate folders only, the root apart; nothing preselected; the link visible but not selectable
      assert.deepEqual(await names(page), ['projects ö', 'p1', 'p2', 'p3', 'zz linked'])
      assert.equal(
        await page
          .locator('[data-testid="census-candidate"][data-root="true"]')
          .getAttribute('data-name'),
        'projects ö'
      )
      for (const n of ['projects ö', 'p1', 'p2', 'p3'])
        assert.equal(await page.getByTestId(`census-check-${n}`).isChecked(), false, n)
      assert.equal(await page.getByTestId('census-check-zz linked').isDisabled(), true)
      assert.match(
        (await page
          .locator('[data-testid="census-candidate"][data-name="zz linked"]')
          .textContent()) ?? '',
        /not followed/i
      )
      assert.equal(await page.getByTestId('census-run').isDisabled(), true)
      await runCensus(page, ['p1', 'p2'])
      await page.getByTestId('census-results').waitFor()
      // The backend received exactly the two candidates of the discovery shown
      const d = await discovered(app)
      assert.deepEqual(
        (await calls(app, 'censusStart')).map((c) => c.arg),
        [{ discoveryId: d.id, candidateIds: [idOf(d, 'p1'), idOf(d, 'p2')] }]
      )
      const summary = page.getByTestId('census-summary')
      assert.deepEqual(
        await Promise.all(
          ['data-projects', 'data-rules', 'data-skills', 'data-incomplete'].map((a) =>
            summary.getAttribute(a)
          )
        ),
        ['2', '4', '2', '0']
      )
      assert.match(
        (await page.getByTestId('census-coverage').textContent()) ?? '',
        /\.claude\/rules\/\*\*\/\*\.md/
      )
      assert.deepEqual(await rels(page), [
        'p1:AGENTS.md',
        'p1:CLAUDE.md',
        'p1:.claude/skills/tool',
        'p2:CLAUDE.md',
        'p2:.claude/rules/same.md',
        'p2:.agents/skills/tool'
      ])
      // Equal content across names and projects; same-name differences for the rule and the skill
      const equal = page.getByTestId('census-equal-group')
      assert.equal(await equal.count(), 1)
      assert.deepEqual(await equal.locator('[data-testid="census-occurrence"]').allTextContents(), [
        'p1 · AGENTS.md',
        'p2 · .claude/rules/same.md'
      ])
      assert.deepEqual(
        await page
          .locator('[data-testid="census-name-group"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-name'))),
        ['CLAUDE.md', 'tool']
      )
      await page.screenshot({ path: join(shots, 'census-01-results.png') })
      // Filters: kind, project, potential consumer, category
      await page.getByTestId('census-filter-kind').selectOption('skill')
      assert.deepEqual(await rels(page), ['p1:.claude/skills/tool', 'p2:.agents/skills/tool'])
      await page.getByTestId('census-filter-consumer').selectOption('codex')
      assert.deepEqual(await rels(page), ['p2:.agents/skills/tool'])
      await page.getByTestId('census-filter-consumer').selectOption('all')
      await page.getByTestId('census-filter-project').selectOption({ label: 'p1' })
      assert.deepEqual(await rels(page), ['p1:.claude/skills/tool'])
      await page.getByTestId('census-filter-project').selectOption('all')
      await page.getByTestId('census-filter-kind').selectOption('all')
      await page.getByTestId('census-filter-category').selectOption('equal')
      assert.deepEqual(await rels(page), ['p1:AGENTS.md', 'p2:.claude/rules/same.md'])
      await page.getByTestId('census-filter-category').selectOption('all')
      // Rule details: the two texts side by side, with their line endings
      const run = await lastStart(app)
      await page
        .locator(
          '[data-testid="census-name-group"][data-name="CLAUDE.md"] [data-testid="census-compare"]'
        )
        .first()
        .click()
      await page.getByTestId('census-details').waitFor()
      const snap = (
        (await calls(app, 'censusPoll')).at(-1)!.value as {
          value: { snapshot: { items: { id: string; projectId: string; relativePath: string }[] } }
        }
      ).value.snapshot
      const item = (project: string, rel: string): string =>
        snap.items.find((i) => i.projectId === idOf(d, project) && i.relativePath === rel)!.id
      assert.deepEqual((await calls(app, 'censusInspect')).at(-1)!.arg, {
        runId: run,
        leftId: item('p1', 'CLAUDE.md'),
        rightId: item('p2', 'CLAUDE.md')
      })
      assert.deepEqual(await page.getByTestId('census-detail-text').allTextContents(), [
        'a\nb\n',
        'a\r\nb\r\n'
      ])
      assert.deepEqual(
        await page
          .getByTestId('census-detail-side')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-line-endings'))),
        ['lf', 'crlf']
      )
      assert.match(
        (await page.getByTestId('census-details').textContent()) ?? '',
        new RegExp(join(ws.root, 'p2', 'CLAUDE.md').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
      )
      await page.screenshot({ path: join(shots, 'census-02-rule-details.png') })
      await page.getByTestId('census-details-close').click()
      await page.getByTestId('census-details').waitFor({ state: 'detached' })
      // Skill details: the resource that differs, never opened
      await page
        .locator(
          '[data-testid="census-name-group"][data-name="tool"] [data-testid="census-compare"]'
        )
        .first()
        .click()
      await page.getByTestId('census-details').waitFor()
      assert.deepEqual(await page.getByTestId('census-detail-changed').allTextContents(), [
        'assets/x.bin'
      ])
      await page.screenshot({ path: join(shots, 'census-03-skill-details.png') })
      await page.getByTestId('census-details-close').click()
      // Nothing was written: projects, global tool folders, library and delivery state are unchanged
      assert.deepEqual(
        watched.map((d) => snapshot(d)),
        before
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'census: replies after Cancel, a selection change or a newer run never bring back obsolete results',
  { timeout: 240000 },
  async () => {
    const ws = workspace()
    const { app, page } = await launch(ws.home)
    try {
      await page.getByTestId('nav-census').click()
      await chooseRoot(app, page, ws.root)
      await page.getByTestId('census-candidate').first().waitFor()
      // Cancel while the completed reply is held: the backend cancels that run, the late reply shows nothing
      await holdNext(app, 'censusPoll')
      await runCensus(page, ['p1', 'p2'])
      await until('a held completed poll', async () => (await heldCount(app, 'censusPoll')) >= 1)
      const first = await lastStart(app)
      await page.getByTestId('census-cancel').click()
      await until('the cancel request', async () => (await calls(app, 'censusCancel')).length >= 1)
      assert.deepEqual(
        (await calls(app, 'censusCancel')).map((c) => c.arg),
        [{ runId: first }]
      )
      await deliverLate(app, page, 'censusPoll')
      assert.equal(await page.getByTestId('census-results').count(), 0)
      assert.equal(await page.getByTestId('census-status').getAttribute('data-status'), 'cancelled')
      // A selection change while the completed reply is held: the run is cancelled, its reply discarded
      await holdNext(app, 'censusPoll')
      await page.getByTestId('census-run').click()
      await until('a second held poll', async () => (await heldCount(app, 'censusPoll')) >= 2)
      const second = await lastStart(app)
      await page.getByTestId('census-check-p2').uncheck()
      await until('the second cancel', async () => (await calls(app, 'censusCancel')).length >= 2)
      assert.deepEqual((await calls(app, 'censusCancel')).at(-1)!.arg, { runId: second })
      await deliverLate(app, page, 'censusPoll')
      assert.equal(await page.getByTestId('census-results').count(), 0)
      // A newer run while the older completed reply is held: only the newer results are shown
      await holdNext(app, 'censusPoll')
      await page.getByTestId('census-run').click()
      await until('a third held poll', async () => (await heldCount(app, 'censusPoll')) >= 3)
      put(ws.root, 'p1/CLAUDE.local.md', '# added before the newer run\n')
      await page.getByTestId('census-run').click()
      await page.getByTestId('census-results').waitFor()
      const newer = await lastStart(app)
      assert.equal(await page.getByTestId('census-results').getAttribute('data-run-id'), newer)
      assert.equal(await page.getByTestId('census-summary').getAttribute('data-rules'), '3')
      await deliverLate(app, page, 'censusPoll')
      assert.equal(await page.getByTestId('census-results').getAttribute('data-run-id'), newer)
      assert.equal(await page.getByTestId('census-summary').getAttribute('data-rules'), '3')
      // A held details reply, then a selection change: no details panel appears
      await page.getByTestId('census-check-p2').check()
      assert.equal(await page.getByTestId('census-results').count(), 0)
      await page.getByTestId('census-run').click()
      await page.getByTestId('census-results').waitFor()
      await holdNext(app, 'censusInspect')
      await page
        .locator('[data-testid="census-name-group"] [data-testid="census-compare"]')
        .first()
        .click()
      await until('a held details reply', async () => (await heldCount(app, 'censusInspect')) >= 1)
      await page.getByTestId('census-check-p1').uncheck()
      await deliverLate(app, page, 'censusInspect')
      assert.equal(await page.getByTestId('census-details').count(), 0)
      assert.equal(await page.getByTestId('census-results').count(), 0)
    } finally {
      await app.close()
    }
  }
)

test(
  'census: a late listing after a root change, and late replies after navigating away, are discarded',
  { timeout: 240000 },
  async () => {
    const ws = workspace()
    const { app, page } = await launch(ws.home)
    try {
      await page.getByTestId('nav-census').click()
      // The first root's listing is held while the user picks another root
      await holdNext(app, 'censusDiscover')
      await chooseRoot(app, page, ws.root)
      await until('a held listing', async () => (await heldCount(app, 'censusDiscover')) >= 1)
      await chooseRoot(app, page, ws.other)
      await page.locator('[data-testid="census-candidate"][data-name="q1"]').waitFor()
      await deliverLate(app, page, 'censusDiscover')
      assert.deepEqual(await names(page), ['other root', 'q1', 'q2'])
      assert.equal(await page.getByTestId('census-root').textContent(), ws.other)
      // Details held, then navigation away and back: no details, no old results
      await runCensus(page, ['q1', 'q2'])
      await page.getByTestId('census-results').waitFor()
      await holdNext(app, 'censusInspect')
      // q1 and q2 both have an AGENTS.md, with different contents
      await page
        .locator(
          '[data-testid="census-name-group"][data-name="AGENTS.md"] [data-testid="census-compare"]'
        )
        .first()
        .click()
      await until('a held details reply', async () => (await heldCount(app, 'censusInspect')) >= 1)
      await page.getByTestId('nav-skills').click()
      await deliverLate(app, page, 'censusInspect')
      await page.getByTestId('nav-census').click()
      assert.equal(await page.getByTestId('census-details').count(), 0)
      assert.equal(await page.getByTestId('census-results').count(), 0)
      assert.equal(await page.getByTestId('census-candidate').count(), 0)
      // A completed reply held while the user navigates away: the backend run is cancelled, nothing comes back
      await chooseRoot(app, page, ws.root)
      await page.getByTestId('census-candidate').first().waitFor()
      await holdNext(app, 'censusPoll')
      await runCensus(page, ['p1'])
      await until('a held completed poll', async () => (await heldCount(app, 'censusPoll')) >= 1)
      const run = await lastStart(app)
      await page.getByTestId('nav-skills').click()
      await until('the cancel on leaving', async () =>
        (await calls(app, 'censusCancel')).some((c) => (c.arg as { runId: string }).runId === run)
      )
      await deliverLate(app, page, 'censusPoll')
      await page.getByTestId('nav-census').click()
      assert.equal(await page.getByTestId('census-results').count(), 0)
      assert.equal(await page.getByTestId('census-candidate').count(), 0)
    } finally {
      await app.close()
    }
  }
)

test(
  'census: a project filter chosen for one root does not hide the results of the next root',
  { timeout: 240000 },
  async () => {
    const ws = workspace()
    const { app, page } = await launch(ws.home)
    try {
      await page.getByTestId('nav-census').click()
      await chooseRoot(app, page, ws.root)
      await page.getByTestId('census-candidate').first().waitFor()
      await runCensus(page, ['p1', 'p2'])
      await page.getByTestId('census-results').waitFor()
      await page.getByTestId('census-filter-project').selectOption({ label: 'p1' })
      assert.deepEqual(await rels(page), ['p1:AGENTS.md', 'p1:CLAUDE.md', 'p1:.claude/skills/tool'])
      // Another root: its only rule is listed without resetting the filter by hand
      await chooseRoot(app, page, ws.other)
      await page.locator('[data-testid="census-candidate"][data-name="q1"]').waitFor()
      await runCensus(page, ['q1'])
      await page.getByTestId('census-results').waitFor()
      assert.equal(await page.getByTestId('census-summary').getAttribute('data-rules'), '1')
      assert.deepEqual(await rels(page), ['q1:AGENTS.md'])
      // The filter shown is the filter applied
      assert.equal(await page.getByTestId('census-filter-project').inputValue(), 'all')
      // A project filter that no longer matches the new snapshot of the same root is also dropped
      await page.getByTestId('census-filter-project').selectOption({ label: 'q1' })
      await page.getByTestId('census-check-q1').uncheck()
      await runCensus(page, ['q2'])
      await page.getByTestId('census-results').waitFor()
      assert.deepEqual(await rels(page), ['q2:AGENTS.md'])
      assert.equal(await page.getByTestId('census-filter-project').inputValue(), 'all')
    } finally {
      await app.close()
    }
  }
)
