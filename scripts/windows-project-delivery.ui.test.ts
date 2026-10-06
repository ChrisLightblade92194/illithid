/**
 * Project import/delivery, Tasks 3 and 7 — the Windows UI (spec 2026-10-06 project delivery §User flow, criterion
 * 11). Runs the built app (`npm run build` first) with the real registered main handlers, on synthetic profiles and
 * project trees only. The folder picker reply, the census channels and the project channels are re-registered around
 * their real handlers (ILLITHID_TEST seam) to record what the renderer sends and to hold replies. Screenshots go to
 * ILLITHID_SHOTS (or a temp folder).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright-core'
import type { CensusDiscovery, CensusItem } from '../src/engine/census/types'
import { readStoredVariants } from '../src/engine/globalImport'
import { CENSUS_CHANNELS, PROJECT_CHANNELS } from '../src/shared/api'
import { censusBase, linkDir, put, snapshot } from './lib/censusFixture'
import { contentSnapshot } from './lib/globalFixture'

const shots =
  process.env['ILLITHID_SHOTS'] ?? mkdtempSync(join(tmpdir(), 'illithid-project-shots-'))
mkdirSync(shots, { recursive: true })

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: test\n---\nbody\n`

interface Ws {
  base: string
  home: string
  root: string
  a: string
  b: string
}

/** Project A: a Claude skill, an AGENTS.md and an incomplete skill; B: a rule and a Codex skill of the same name */
function workspace(): Ws {
  const base = censusBase('illithid delivery ö ')
  const home = join(base, 'home ä')
  for (const d of ['.claude', '.codex', '.config/opencode'])
    mkdirSync(join(home, d), { recursive: true })
  const root = join(base, 'projects ö')
  const a = join(root, 'A')
  put(a, '.claude/skills/caveman/SKILL.md', SKILL('caveman'))
  put(a, '.claude/skills/caveman/assets/x.bin', Buffer.from([0, 1, 2, 3]))
  put(a, '.claude/skills/caveman/.hidden', 'h\n')
  put(a, 'AGENTS.md', '# A rules\n')
  put(a, '.claude/skills/broken/SKILL.md', SKILL('broken'))
  mkdirSync(join(base, 'outside'))
  linkDir(join(base, 'outside'), join(a, '.claude/skills/broken/assets'))
  const b = join(root, 'B')
  put(b, 'CLAUDE.md', '# B rules\r\n')
  put(b, '.agents/skills/caveman/SKILL.md', SKILL('caveman'))
  return { base, home, root, a, b }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    HOME: home,
    LANG: 'en_US.UTF-8',
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-project-ud-')),
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
  __holdNext: Record<string, boolean>
  __release: Record<string, (() => void) | undefined>
  __heldCount: Record<string, number>
  __doneCount: Record<string, number>
}

// The functions passed to app.evaluate run in the main process: no named inner functions
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
          if (g.__holdNext[ch]) {
            g.__holdNext[ch] = false
            g.__heldCount[ch] = (g.__heldCount[ch] ?? 0) + 1
            await new Promise<void>((r) => (g.__release[ch] = r))
          }
          g.__doneCount[ch] = (g.__doneCount[ch] ?? 0) + 1
          return value
        })
      }
    },
    [...CENSUS_CHANNELS, ...PROJECT_CHANNELS]
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
  await page.evaluate(() =>
    (window as unknown as { api: { appVersion: () => Promise<unknown> } }).api.appVersion()
  )
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
  )
  await page.waitForTimeout(400)
}

/** Census of the given projects through the UI; returns the discovery and the completed snapshot items */
async function censusOf(
  app: ElectronApplication,
  page: Page,
  root: string,
  projects: string[]
): Promise<{ discovery: CensusDiscovery; runId: string; items: CensusItem[] }> {
  await page.getByTestId('nav-census').click()
  await setPick(app, root)
  await page.getByTestId('census-choose-root').click()
  await page.getByTestId('census-candidate').first().waitFor()
  for (const p of projects) await page.getByTestId(`census-check-${p}`).check()
  await page.getByTestId('census-run').click()
  await page.getByTestId('census-results').waitFor()
  const discovery = (
    (await calls(app, 'censusDiscover')).at(-1)!.value as { value: CensusDiscovery }
  ).value
  const runId = ((await calls(app, 'censusStart')).at(-1)!.value as { value: { runId: string } })
    .value.runId
  const poll = (await calls(app, 'censusPoll')).filter(
    (c) => (c.value as { value?: { status?: string } }).value?.status === 'completed'
  )
  const items = (poll.at(-1)!.value as { value: { snapshot: { items: CensusItem[] } } }).value
    .snapshot.items
  return { discovery, runId, items }
}

const importCheck = (page: Page, project: string, rel: string): Locator =>
  page.locator(
    `[data-testid="census-item"][data-project="${project}"][data-rel="${rel}"] [data-testid="census-import-check"]`
  )

const idIn = (
  c: { discovery: CensusDiscovery; items: CensusItem[] },
  project: string,
  rel: string
): string => {
  const cand = c.discovery.candidates.find((x) => x.name === project)!
  return c.items.find((i) => i.projectId === cand.id && i.relativePath === rel)!.id
}

test('project_import_selection_reaches_backend', { timeout: 240000 }, async () => {
  const ws = workspace()
  const projectsBefore = snapshot(ws.root)
  const { app, page } = await launch(ws.home)
  try {
    const c = await censusOf(app, page, ws.root, ['A', 'B'])
    // Nothing preselected; incomplete occurrences cannot be selected; Import needs a selection
    const checks = page.getByTestId('census-import-check')
    const total = await checks.count()
    assert.ok(total >= 5)
    for (let i = 0; i < total; i++) assert.equal(await checks.nth(i).isChecked(), false)
    assert.equal(await importCheck(page, 'A', '.claude/skills/broken').isDisabled(), true)
    assert.equal(await page.getByTestId('census-import-open').isDisabled(), true)
    // Select all covers the complete (eligible) items only
    await page.getByTestId('census-import-select-all').click()
    const eligible = c.items.filter((i) => i.outcome === 'complete').length
    assert.equal(
      await page.locator('[data-testid="census-import-check"]:checked').count(),
      eligible
    )
    assert.equal(await importCheck(page, 'A', '.claude/skills/broken').isChecked(), false)
    await page.getByTestId('census-import-clear').click()
    assert.equal(await page.locator('[data-testid="census-import-check"]:checked').count(), 0)
    // A subset: A's Claude skill and B's CLAUDE.md
    await importCheck(page, 'B', 'CLAUDE.md').check()
    await importCheck(page, 'A', '.claude/skills/caveman').check()
    await page.getByTestId('census-import-open').click()
    const dialog = page.getByTestId('project-import-dialog')
    await dialog.waitFor()
    assert.deepEqual(
      await dialog
        .getByTestId('project-import-row')
        .allTextContents()
        .then((t) => t.length),
      2
    )
    assert.equal((await calls(app, 'projectImportStart')).length, 0, 'nothing before confirmation')
    await page.screenshot({ path: join(shots, 'project-01-import-review.png') })
    await dialog.getByTestId('project-import-run').click()
    await page.locator('[data-testid="project-import-result"][data-status="completed"]').waitFor()
    const selectedItemIds = [idIn(c, 'A', '.claude/skills/caveman'), idIn(c, 'B', 'CLAUDE.md')]
    const receivedItemIds = (
      (await calls(app, 'projectImportStart'))[0].arg as { itemIds: string[] }
    ).itemIds
    assert.deepEqual([...receivedItemIds].sort(), [...selectedItemIds].sort())
    assert.deepEqual((await calls(app, 'projectImportStart'))[0].arg, {
      runId: c.runId,
      itemIds: receivedItemIds
    })
    assert.deepEqual(
      await dialog
        .getByTestId('project-import-outcome')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-status'))),
      ['imported', 'imported']
    )
    await page.screenshot({ path: join(shots, 'project-02-import-result.png') })
    const variants = readStoredVariants(ws.home).variants
    assert.deepEqual(variants.map((v) => v.name).sort(), ['CLAUDE.md', 'caveman'])
    await dialog.getByTestId('project-import-close').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.locator('[data-testid="census-import-check"]:checked').count(), 0)

    // Cancel while the start reply is held: the late job is cancelled by id and its real outcome is shown
    await importCheck(page, 'A', 'AGENTS.md').check()
    await page.getByTestId('census-import-open').click()
    await dialog.waitFor()
    await holdNext(app, 'projectImportStart')
    await dialog.getByTestId('project-import-run').click()
    await until(
      'a held start',
      async () => ((await read(app, '__heldCount'))['projectImportStart'] ?? 0) >= 1
    )
    await dialog.getByTestId('project-import-cancel').click()
    await deliverLate(app, page, 'projectImportStart')
    const started = (await calls(app, 'projectImportStart')).at(-1)!.value as {
      value: { jobId: string }
    }
    await until('the cancel of the late job', async () =>
      (await calls(app, 'projectCancel')).some(
        (x) => (x.arg as { jobId: string }).jobId === started.value.jobId
      )
    )
    const result = page.getByTestId('project-import-result')
    await result.waitFor()
    const finalView = [...(await calls(app, 'projectPoll')), ...(await calls(app, 'projectCancel'))]
      .map((x) => (x.value as { value?: { id: string; status: string } }).value)
      .filter((v) => v?.id === started.value.jobId && v.status !== 'running')
    assert.ok(finalView.length >= 1)
    assert.equal(await result.getAttribute('data-status'), finalView[0]!.status)
    await dialog.getByTestId('project-import-close').click()
    // The projects were only read
    assert.deepEqual(snapshot(ws.root), projectsBefore)
  } finally {
    await app.close()
  }
})

test('project_origin_can_use_global_delivery', { timeout: 240000 }, async () => {
  const ws = workspace()
  const sourceBefore = snapshot(join(ws.a, '.claude/skills/caveman'))
  const { app, page } = await launch(ws.home)
  try {
    await censusOf(app, page, ws.root, ['A'])
    await importCheck(page, 'A', '.claude/skills/caveman').check()
    await page.getByTestId('census-import-open').click()
    const dialog = page.getByTestId('project-import-dialog')
    await dialog.getByTestId('project-import-run').click()
    await page.locator('[data-testid="project-import-result"][data-status="completed"]').waitFor()
    await dialog.getByTestId('project-import-close').click()
    const [variant] = readStoredVariants(ws.home).variants
    const importedSkillBytes = contentSnapshot(join(variant.dir, 'content'))
    // The existing global flow: confirm the tool folders, choose the project variant for Codex, preview, apply
    await page.getByTestId('nav-paths').click()
    for (const tool of ['claude', 'codex', 'opencode']) {
      await page.getByTestId(`path-confirm-${tool}`).click()
      await page.locator(`[data-testid="path-row-${tool}"][data-confirmed="true"]`).waitFor()
    }
    await page.getByTestId('nav-skills').click()
    await page.locator('[data-testid="origin-project"]').first().waitFor()
    const select = page.getByTestId('recipient-skill-caveman-codex')
    const options = await select
      .locator('option')
      .evaluateAll((os) =>
        os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }))
      )
    const wanted = options.find((o) => /project A/.test(o.text))
    assert.ok(wanted, JSON.stringify(options))
    await select.selectOption(wanted.value)
    await page
      .locator('[data-testid="status-skill-caveman-codex"][data-status="toApply"]')
      .waitFor()
    await page.screenshot({ path: join(shots, 'project-03-global-library.png') })
    await page.getByTestId('open-preview').click()
    await page.getByTestId('preview-modal').waitFor()
    await page.getByTestId('preview-apply').click()
    await page.locator('[data-testid="result-status"][data-status="completed"]').waitFor()
    await page.getByTestId('preview-close').click()
    const deliveredSkillBytes = contentSnapshot(join(ws.home, '.codex', 'skills', 'caveman'))
    assert.deepEqual(deliveredSkillBytes, importedSkillBytes)
    assert.deepEqual(snapshot(join(ws.a, '.claude/skills/caveman')), sourceBefore)
  } finally {
    await app.close()
  }
})
