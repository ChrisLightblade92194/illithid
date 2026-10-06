/**
 * Project import/delivery, Tasks 3 and 7 — the Windows UI (spec 2026-10-06 project delivery §User flow, criterion
 * 11). Runs the built app (`npm run build` first) with the real registered main handlers, on synthetic profiles and
 * project trees only. The folder picker reply, the census channels and the project channels are re-registered around
 * their real handlers (ILLITHID_TEST seam) to record what the renderer sends and to hold replies. Screenshots go to
 * ILLITHID_SHOTS (or a temp folder).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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
import { contentSnapshot, denyWrite } from './lib/globalFixture'

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
  /** Set by holdFsIn once a held filesystem call is waiting */
  __fsHeld?: boolean
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
/**
 * A main-process global, read with a narrow retry: Playwright occasionally reports "Resulting promise was garbage
 * collected" for a synchronous evaluate while a held IPC reply is released (seen once on this machine). Any other
 * error, and a third such failure, is thrown.
 */
async function read<K extends keyof Probe>(app: ElectronApplication, key: K): Promise<Probe[K]> {
  for (let attempt = 1; ; attempt++)
    try {
      return (await app.evaluate(
        (_e, k: string) => (globalThis as unknown as Record<string, unknown>)[k],
        key as string
      )) as Probe[K]
    } catch (e) {
      if (attempt >= 3 || !/garbage collected/.test((e as Error).message ?? '')) throw e
    }
}
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

/** Imports the given occurrences through the census view (one dialog) */
async function importVia(
  app: ElectronApplication,
  page: Page,
  root: string,
  projects: string[],
  items: [string, string][]
): Promise<void> {
  await censusOf(app, page, root, projects)
  for (const [p, rel] of items) await importCheck(page, p, rel).check()
  await page.getByTestId('census-import-open').click()
  const dialog = page.getByTestId('project-import-dialog')
  await dialog.getByTestId('project-import-run').click()
  await page.locator('[data-testid="project-import-result"][data-status="completed"]').waitFor()
  await dialog.getByTestId('project-import-close').click()
  await dialog.waitFor({ state: 'detached' })
}

/** Opens the delivery dialog, selects variants by name, discovers root and selects projects */
async function deliverySetup(
  app: ElectronApplication,
  page: Page,
  root: string,
  variants: string[],
  projects: string[]
): Promise<Locator> {
  await page.getByTestId('nav-skills').click()
  await page.getByTestId('open-project-delivery').click()
  const dialog = page.getByTestId('project-delivery-dialog')
  await dialog.waitFor()
  // Nothing preselected: no item, no project
  assert.equal(await dialog.locator('[data-testid="delivery-variant-check"]:checked').count(), 0)
  for (const v of variants)
    await dialog.locator(`[data-testid="delivery-variant-check"][data-name="${v}"]`).check()
  await setPick(app, root)
  await dialog.getByTestId('delivery-choose-root').click()
  await dialog.getByTestId('delivery-candidate').first().waitFor()
  assert.equal(await dialog.locator('[data-testid^="delivery-project-check-"]:checked').count(), 0)
  for (const p of projects) await dialog.getByTestId(`delivery-project-check-${p}`).check()
  return dialog
}

const lastValue = async <T>(app: ElectronApplication, ch: string): Promise<T> =>
  ((await calls(app, ch)).at(-1)!.value as { value: T }).value

const comboOf = (dialog: Locator, project: string, variant: string, tool: string): Locator =>
  dialog.locator(
    `[data-testid="delivery-combo"][data-project="${project}"][data-variant-name="${variant}"][data-tool="${tool}"]`
  )

test('project_delivery_mixed_recipients', { timeout: 240000 }, async () => {
  const ws = workspace()
  mkdirSync(join(ws.root, 'C'))
  mkdirSync(join(ws.root, 'D'))
  const sourceBefore = snapshot(join(ws.a, '.claude/skills/caveman'))
  const bBefore = snapshot(ws.b)
  const { app, page } = await launch(ws.home)
  try {
    await importVia(app, page, ws.root, ['A'], [['A', '.claude/skills/caveman']])
    const [variant] = readStoredVariants(ws.home).variants
    const dialog = await deliverySetup(app, page, ws.root, ['caveman'], ['C', 'D'])
    // Per-project tools: Codex for C, OpenCode for D (no common tool)
    await dialog.getByTestId('delivery-override-C').check()
    await dialog.getByTestId('delivery-tool-C-codex').check()
    await dialog.getByTestId('delivery-override-D').check()
    await dialog.getByTestId('delivery-tool-D-opencode').check()
    assert.deepEqual(
      await dialog
        .getByTestId('delivery-combo')
        .evaluateAll((els) =>
          els.map(
            (e) =>
              e.getAttribute('data-project') +
              ':' +
              e.getAttribute('data-tool') +
              ':' +
              e.getAttribute('data-target')
          )
        ),
      ['C:codex:.agents/skills/caveman', 'D:opencode:.opencode/skills/caveman']
    )
    // Omit the skill for D without changing the library selection
    await comboOf(dialog, 'D', 'caveman', 'opencode').uncheck()
    await page.screenshot({ path: join(shots, 'project-04-delivery-choices.png') })
    await dialog.getByTestId('delivery-preview').click()
    const preview = page.getByTestId('project-preview')
    await preview.waitFor()
    const d = await lastValue<CensusDiscovery>(app, 'projectDiscover')
    const C = d.candidates.find((c) => c.name === 'C')!.id
    assert.deepEqual((await calls(app, 'projectPreview')).at(-1)!.arg, {
      discoveryId: d.id,
      selections: [
        { candidateId: C, variantId: variant.id, tool: 'codex', slot: { type: 'default' } }
      ]
    })
    assert.deepEqual(
      await preview
        .getByTestId('project-preview-change')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-rel') + ':' + e.getAttribute('data-action'))
        ),
      ['.agents/skills/caveman:create']
    )
    await page.screenshot({ path: join(shots, 'project-05-delivery-preview.png') })
    await preview.getByTestId('project-preview-apply').click()
    await page.locator('[data-testid="project-apply-result"][data-status="completed"]').waitFor()
    await page.screenshot({ path: join(shots, 'project-06-delivery-result.png') })
    const projectC = join(ws.root, 'C')
    const actualTargets = [
      join(projectC, '.agents', 'skills', 'caveman'),
      join(ws.root, 'D', '.opencode'),
      join(ws.root, 'D', '.agents')
    ].filter((p) => Object.keys(snapshot(p)).length > 0)
    assert.deepEqual(actualTargets, [join(projectC, '.agents', 'skills', 'caveman')])
    assert.deepEqual(
      contentSnapshot(join(projectC, '.agents', 'skills', 'caveman')),
      contentSnapshot(join(variant.dir, 'content'))
    )
    assert.deepEqual(snapshot(ws.b), bBefore, 'an unselected project is untouched')
    const sourceAfter = snapshot(join(ws.a, '.claude/skills/caveman'))
    assert.deepEqual(sourceAfter, sourceBefore)
  } finally {
    await app.close()
  }
})

test('project_preview_late_reply_cannot_enable_apply', { timeout: 240000 }, async () => {
  const ws = workspace()
  mkdirSync(join(ws.root, 'C'))
  const other = join(ws.base, 'other root')
  mkdirSync(join(other, 'Q'), { recursive: true })
  const { app, page } = await launch(ws.home)
  try {
    await importVia(app, page, ws.root, ['A'], [['A', '.claude/skills/caveman']])
    const dialog = await deliverySetup(app, page, ws.root, ['caveman'], ['B', 'C'])
    await dialog.getByTestId('delivery-common-codex').check()
    // A held preview reply, then a selection change: the late plan is discarded, Apply never appears
    await holdNext(app, 'projectPreview')
    await dialog.getByTestId('delivery-preview').click()
    await until(
      'a held preview',
      async () => ((await read(app, '__heldCount'))['projectPreview'] ?? 0) >= 1
    )
    await comboOf(dialog, 'C', 'caveman', 'codex').uncheck()
    await deliverLate(app, page, 'projectPreview')
    const late = await lastValue<{ id: string }>(app, 'projectPreview')
    await until('the late plan is discarded', async () =>
      (await calls(app, 'projectDiscardPlan')).some(
        (c) => (c.arg as { planId: string }).planId === late.id
      )
    )
    assert.equal(await page.getByTestId('project-preview').count(), 0)
    assert.equal(await page.getByTestId('project-preview-apply').count(), 0)
    // A held preview reply, then another root: discarded too
    await holdNext(app, 'projectPreview')
    await dialog.getByTestId('delivery-preview').click()
    await until(
      'a second held preview',
      async () => ((await read(app, '__heldCount'))['projectPreview'] ?? 0) >= 2
    )
    await setPick(app, other)
    await dialog.getByTestId('delivery-choose-root').click()
    await dialog.locator('[data-testid="delivery-candidate"][data-name="Q"]').waitFor()
    await deliverLate(app, page, 'projectPreview')
    const late2 = await lastValue<{ id: string }>(app, 'projectPreview')
    await until('the second late plan is discarded', async () =>
      (await calls(app, 'projectDiscardPlan')).some(
        (c) => (c.arg as { planId: string }).planId === late2.id
      )
    )
    assert.equal(await page.getByTestId('project-preview').count(), 0)
    // Back to the first root: a fresh preview applies; no obsolete id was ever sent to apply
    await setPick(app, ws.root)
    await dialog.getByTestId('delivery-choose-root').click()
    await dialog.getByTestId('delivery-project-check-C').check()
    await dialog.getByTestId('delivery-common-codex').check()
    await dialog.getByTestId('delivery-preview').click()
    await page.getByTestId('project-preview').waitFor()
    await page.getByTestId('project-preview-apply').click()
    await page.locator('[data-testid="project-apply-result"][data-status="completed"]').waitFor()
    const staleApplyRequests = (await calls(app, 'projectApplyStart')).filter((c) =>
      [late.id, late2.id].includes((c.arg as { planId: string }).planId)
    )
    assert.equal(staleApplyRequests.length, 0)
    assert.equal((await calls(app, 'projectApplyStart')).length, 1)
  } finally {
    await app.close()
  }
})

test('project_operation_restore_round_trip', { timeout: 300000 }, async () => {
  const ws = workspace()
  put(ws.root, 'C/AGENTS.md', '# C rules\n')
  mkdirSync(join(ws.root, 'D'))
  const projectBeforeApply = contentSnapshot(join(ws.root, 'C'))
  const { app, page } = await launch(ws.home)
  const undo: (() => void)[] = []
  try {
    // Two different rules: A's AGENTS.md and B's CLAUDE.md
    await importVia(
      app,
      page,
      ws.root,
      ['A', 'B'],
      [
        ['A', 'AGENTS.md'],
        ['B', 'CLAUDE.md']
      ]
    )
    const agents = readStoredVariants(ws.home).variants.find((v) => v.name === 'AGENTS.md')!
    await page.getByTestId('nav-rules').click()
    await page.getByTestId('open-project-delivery').click()
    const dialog = page.getByTestId('project-delivery-dialog')
    await dialog.locator('[data-testid="delivery-variant-check"][data-name="AGENTS.md"]').check()
    await dialog.locator('[data-testid="delivery-variant-check"][data-name="CLAUDE.md"]').check()
    await setPick(app, ws.root)
    await dialog.getByTestId('delivery-choose-root').click()
    await dialog.getByTestId('delivery-project-check-C').check()
    await dialog.getByTestId('delivery-project-check-D').check()
    await dialog.getByTestId('delivery-common-codex').check()
    await dialog.getByTestId('delivery-common-opencode').check()
    // AGENTS.md for Codex in C and D; CLAUDE.md for OpenCode in C only (its default is AGENTS.md too)
    for (const [p, v, t] of [
      ['C', 'AGENTS.md', 'opencode'],
      ['C', 'CLAUDE.md', 'codex'],
      ['D', 'CLAUDE.md', 'codex'],
      ['D', 'CLAUDE.md', 'opencode'],
      ['D', 'AGENTS.md', 'opencode']
    ])
      await comboOf(dialog, p, v, t).uncheck()
    await dialog.getByTestId('delivery-preview').click()
    const preview = page.getByTestId('project-preview')
    await preview.waitFor()
    // C's shared AGENTS.md: two incoming variants, a collision to resolve; D: a plain create
    const c = preview.locator('[data-testid="project-preview-change"][data-project="C"]')
    assert.equal(await c.getAttribute('data-collision'), 'true')
    assert.equal(await preview.getByTestId('project-preview-apply').isDisabled(), true)
    await c.getByTestId('project-choice').selectOption(agents.id)
    await page
      .locator('[data-testid="project-preview-change"][data-project="C"][data-collision="false"]')
      .waitFor()
    assert.equal(await c.getAttribute('data-action'), 'skip', 'different content starts as Skip')
    await c.getByTestId('project-replace').click()
    await c.getByTestId('project-replace-confirm').click()
    await page
      .locator('[data-testid="project-preview-change"][data-project="C"][data-action="replace"]')
      .waitFor()
    assert.equal(await preview.getByTestId('project-preview-apply').isDisabled(), false)
    await page.screenshot({ path: join(shots, 'project-07-collision-replace.png') })
    // D refuses new files between the preview and the apply: a partial result
    undo.push(denyWrite(join(ws.root, 'D')))
    await preview.getByTestId('project-preview-apply').click()
    await page.locator('[data-testid="project-apply-result"][data-status="partial"]').waitFor()
    assert.deepEqual(
      await page
        .getByTestId('project-apply-outcome')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-project') + ':' + e.getAttribute('data-status'))
        ),
      ['C:done', 'D:failed']
    )
    await page.screenshot({ path: join(shots, 'project-08-partial-result.png') })
    undo.pop()!()
    assert.equal(
      readFileSync(join(ws.root, 'C', 'AGENTS.md'), 'utf8'),
      readFileSync(join(agents.dir, agents.content), 'utf8')
    )
    await preview.getByTestId('project-preview-close').click()
    await dialog.waitFor({ state: 'detached' })
    // Operations: the project operation, its restore preview and apply
    await page.getByTestId('nav-operations').click()
    const op = page.locator('[data-testid="project-operation-row"][data-status="partial"]')
    await op.waitFor()
    await op.getByTestId('project-restore-preview').click()
    const restore = page.getByTestId('project-preview')
    await restore.waitFor()
    assert.equal(await restore.getAttribute('data-kind'), 'restore')
    await restore.getByTestId('project-preview-apply').click()
    await page.locator('[data-testid="project-apply-result"][data-status="completed"]').waitFor()
    await page.screenshot({ path: join(shots, 'project-09-restore.png') })
    const restoredProject = contentSnapshot(join(ws.root, 'C'))
    assert.deepEqual(restoredProject, projectBeforeApply)
  } finally {
    for (const u of undo) u()
    await app.close()
  }
})

/**
 * Holds the main process's first promise-API filesystem call inside dir (test mode only) until __fsRelease(): an
 * apply job reading its library variant there stays running. No named inner functions (the function runs in main).
 */
async function holdFsIn(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate((_e, d: string) => {
    const g = globalThis as unknown as Record<string, unknown>
    const fsp = (
      process as unknown as {
        getBuiltinModule(m: string): {
          promises: Record<string, (...a: unknown[]) => Promise<unknown>>
        }
      }
    ).getBuiltinModule('node:fs').promises
    const prefix = d.toLowerCase()
    const saved: [string, (...a: unknown[]) => Promise<unknown>][] = []
    let open: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      open = r
    })
    g.__fsHeld = false
    g.__fsRelease = () => {
      for (const [k, f] of saved) fsp[k] = f
      open?.()
    }
    for (const k of ['lstat', 'open', 'readdir', 'stat']) {
      const orig = fsp[k]
      saved.push([k, orig])
      fsp[k] = async (...a: unknown[]) => {
        if (!g.__fsHeld && typeof a[0] === 'string' && a[0].toLowerCase().startsWith(prefix)) {
          g.__fsHeld = true
          await gate
        }
        return orig.apply(fsp, a)
      }
    }
  }, dir)
}
const releaseFs = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    const g = globalThis as unknown as { __fsRelease?: () => void }
    g.__fsRelease?.()
  })

test('project_apply_start_reply_keeps_job_controls', { timeout: 240000 }, async () => {
  const ws = workspace()
  mkdirSync(join(ws.root, 'C'))
  const { app, page } = await launch(ws.home)
  try {
    await importVia(app, page, ws.root, ['A'], [['A', '.claude/skills/caveman']])
    const [variant] = readStoredVariants(ws.home).variants
    let dialog = await deliverySetup(app, page, ws.root, ['caveman'], ['C'])
    await dialog.getByTestId('delivery-common-codex').check()
    await dialog.getByTestId('delivery-preview').click()
    let preview = page.getByTestId('project-preview')
    await preview.waitFor()
    // The backend starts the job (held on its first library read); its start reply is held on the way back
    await holdFsIn(app, variant.dir)
    await holdNext(app, 'projectApplyStart')
    await preview.getByTestId('project-preview-apply').click()
    await until(
      'a held apply start',
      async () => ((await read(app, '__heldCount'))['projectApplyStart'] ?? 0) >= 1
    )
    const started = (await calls(app, 'projectApplyStart')).at(-1)!.value as {
      ok: boolean
      value: { jobId: string }
    }
    assert.equal(started.ok, true, 'the backend started the job')
    const jobId = started.value.jobId
    // While the job id is on its way the dialog cannot be left: the job and its result would be lost
    const close = preview.getByTestId('project-preview-close')
    assert.equal(await close.isDisabled(), true, 'Close is disabled while the apply starts')
    assert.equal(
      await preview.getByRole('button', { name: 'Back to choices' }).isDisabled(),
      true,
      'Back is disabled while the apply starts'
    )
    await close.click({ force: true, timeout: 2000 }).catch(() => {})
    assert.equal(await preview.count(), 1, 'the preview stays open')
    await page.screenshot({ path: join(shots, 'project-10-apply-starting.png') })
    // The id arrives: the renderer polls that job and offers Cancel while it runs
    await deliverLate(app, page, 'projectApplyStart')
    await until('a poll of the started job', async () =>
      (await calls(app, 'projectPoll')).some((c) => (c.arg as { jobId: string }).jobId === jobId)
    )
    assert.equal(await read(app, '__fsHeld'), true, 'the job is still running')
    await preview.getByTestId('project-apply-cancel').click()
    await until('the cancel of the started job', async () =>
      (await calls(app, 'projectCancel')).some((c) => (c.arg as { jobId: string }).jobId === jobId)
    )
    await releaseFs(app)
    // The real outcome of that job is shown, then the dialog can be closed
    const result = preview.getByTestId('project-apply-result')
    await result.waitFor()
    const finalView = [...(await calls(app, 'projectPoll')), ...(await calls(app, 'projectCancel'))]
      .map(
        (x) =>
          (x.value as { value?: { id: string; status: string; result?: { status: string } } }).value
      )
      .filter((v) => v?.id === jobId && v.status !== 'running')
    assert.ok(finalView.length >= 1)
    assert.equal(finalView[0]!.status, 'cancelled')
    assert.equal(await result.getAttribute('data-status'), finalView[0]!.result!.status)
    assert.equal(existsSync(join(ws.root, 'C', '.agents')), false, 'cancelled before any write')
    await page.screenshot({ path: join(shots, 'project-11-apply-cancelled.png') })
    await close.click()
    await dialog.waitFor({ state: 'detached' })

    // A refused start (the preview was superseded in the backend) leaves the dialog closable
    dialog = await deliverySetup(app, page, ws.root, ['caveman'], ['C'])
    await dialog.getByTestId('delivery-common-codex').check()
    await dialog.getByTestId('delivery-preview').click()
    preview = page.getByTestId('project-preview')
    await preview.waitFor()
    await page.evaluate(
      (root) =>
        (
          window as unknown as { api: { projectDiscover: (r: unknown) => Promise<unknown> } }
        ).api.projectDiscover({ root }),
      ws.root
    )
    await preview.getByTestId('project-preview-apply').click()
    await preview.getByTestId('project-preview-error').waitFor()
    const refusedStart = (await calls(app, 'projectApplyStart')).at(-1)!.value as { ok: boolean }
    assert.equal(refusedStart.ok, false)
    assert.equal(await preview.getByTestId('project-preview-close').isDisabled(), false)
    await preview.getByTestId('project-preview-close').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(existsSync(join(ws.root, 'C', '.agents')), false)
  } finally {
    await releaseFs(app).catch(() => {})
    await app.close()
  }
})
