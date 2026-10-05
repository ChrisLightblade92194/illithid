/**
 * Task 7 — the Windows global flow from the UI (spec 2026-10-04 §6, §7, §9, §11; criteria 3, 4, 5, 10).
 * Runs the built app (`npm run build` first) on synthetic profiles only. Screenshots go to ILLITHID_SHOTS (or a temp
 * folder) for review: conflict, preview, partial result, restore.
 * A synced state means matching files; it does not show that a tool loaded the instructions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { contentSnapshot, denyWrite, put, snapshot, syntheticHome } from './lib/globalFixture'
import { readStoredVariants } from '../src/engine/globalImport'
import { globalLibraryDir } from '../src/engine/globalPaths'
import { readDeliveries } from '../src/engine/globalVariants'

const TOOL_DIRS = ['.claude', '.codex', '.config/opencode']
const snapTools = (home: string): Record<string, Record<string, string>> =>
  Object.fromEntries(TOOL_DIRS.map((d) => [d, snapshot(join(home, d))]))
const shots = process.env['ILLITHID_SHOTS'] ?? mkdtempSync(join(tmpdir(), 'illithid-ui-shots-'))
mkdirSync(shots, { recursive: true })

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    HOME: home,
    LANG: 'en_US.UTF-8',
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-win-ud-')),
    ILLITHID_TEST: '1'
  }
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 860 })
  return { app, page }
}

async function confirmPaths(page: Page): Promise<void> {
  await page.getByTestId('nav-paths').click()
  for (const tool of ['claude', 'codex', 'opencode']) {
    await page.getByTestId(`path-confirm-${tool}`).click()
    await page.locator(`[data-testid="path-row-${tool}"][data-confirmed="true"]`).waitFor()
  }
}

async function importAll(page: Page): Promise<void> {
  await page.getByTestId('open-import').click()
  await page.getByTestId('import-select-all').click()
  await page.getByTestId('import-run').click()
  await page.getByTestId('import-result').waitFor()
  await page.getByTestId('import-close').click()
}

async function chooseVariant(page: Page, row: string, originTool: string | null): Promise<void> {
  const select = page.getByTestId(`recipient-${row}`)
  const options = await select
    .locator('option')
    .evaluateAll((os) =>
      os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }))
    )
  const wanted = originTool
    ? options.find((o) => o.text.includes(originTool))
    : options.find((o) => o.value === '')
  assert.ok(wanted, `option for ${originTool} in ${row}: ${JSON.stringify(options)}`)
  await select.selectOption(wanted.value)
}

const status = (page: Page, row: string): Promise<string | null> =>
  page.getByTestId(`status-${row}`).getAttribute('data-status')

async function waitStatus(page: Page, row: string, want: string): Promise<void> {
  await page
    .locator(`[data-testid="status-${row}"][data-status="${want}"]`)
    .waitFor({ timeout: 15000 })
}

/** Main-process globals of the IPC wrappers below (test mode exposes the registered handlers) */
interface IpcProbe {
  __illithidHandlers?: Record<string, (...a: unknown[]) => Promise<unknown>>
  __gate: Promise<void> | null
  __open: (() => void) | null
  __previewAsked: number
  __previewDone: number
  __linkedImports: { linkPath: string }[][]
}

/**
 * Re-registers two channels around their real handlers: globalLinkedPreview waits while a gate is held (a delayed
 * reply), globalLinkedImport records what the renderer actually sends
 */
async function probeLinkedChannels(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as IpcProbe
    const h = g.__illithidHandlers!
    g.__gate = null
    g.__open = null
    g.__previewAsked = 0
    g.__previewDone = 0
    g.__linkedImports = []
    ipcMain.removeHandler('api:globalLinkedPreview')
    ipcMain.handle('api:globalLinkedPreview', async (_e, ...a: unknown[]) => {
      g.__previewAsked++
      if (g.__gate) await g.__gate
      try {
        return await h.globalLinkedPreview(...a)
      } finally {
        g.__previewDone++
      }
    })
    ipcMain.removeHandler('api:globalLinkedImport')
    ipcMain.handle('api:globalLinkedImport', async (_e, ...a: unknown[]) => {
      g.__linkedImports.push(JSON.parse(JSON.stringify(a[0])))
      return h.globalLinkedImport(...a)
    })
  })
}

// The functions passed to app.evaluate run in the main process: no named inner functions (tsx would wrap them in a
// helper that does not exist there)
const holdPreview = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    const g = globalThis as unknown as IpcProbe
    g.__gate = new Promise<void>((r) => {
      g.__open = r
    })
  })

const probe = async <K extends keyof IpcProbe>(
  app: ElectronApplication,
  key: K
): Promise<IpcProbe[K]> =>
  (await app.evaluate(
    (_e, k: string) => (globalThis as unknown as Record<string, unknown>)[k],
    key as string
  )) as IpcProbe[K]

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Releases the held preview and returns once its late reply has reached the renderer and React has rendered */
async function deliverLatePreview(app: ElectronApplication, page: Page, n: number): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as IpcProbe
    const open = g.__open
    g.__gate = null
    g.__open = null
    if (open) open()
  })
  await until('the delayed preview reply', async () => (await probe(app, '__previewDone')) >= n)
  // A later round trip on the same IPC pipe: the delayed reply was delivered before it
  await page.evaluate(() =>
    (window as unknown as { api: { appVersion: () => Promise<unknown> } }).api.appVersion()
  )
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
  )
}

test(
  'Windows flow: two same-name skills keep their origins, each tool gets its variant, nothing is written before Apply',
  { timeout: 240000 },
  async () => {
    const home = syntheticHome('illithid ui ')
    put(
      home,
      '.claude/skills/pdf/SKILL.md',
      '---\nname: pdf\ndescription: claude\n---\nclaude pdf\n'
    )
    put(home, '.claude/skills/pdf/ref/a.md', 'claude resource\n')
    put(home, '.codex/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: codex\n---\ncodex pdf\n')
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const initial = snapTools(home)
    const codexBefore = contentSnapshot(join(home, '.codex'))
    const { app, page } = await launch(home)
    try {
      // Deferred features are not offered
      for (const menu of ['mcp', 'hooks', 'permissions', 'sessions', 'stats', 'market'])
        assert.equal(await page.locator(`[data-menu="${menu}"]`).count(), 0, menu)
      await confirmPaths(page)
      await importAll(page)
      assert.deepEqual(snapTools(home), initial, 'import wrote into a tool folder')

      await page.getByTestId('nav-skills').click()
      const cards = page.locator('[data-group="skill:pdf"] [data-variant-id]')
      await cards.first().waitFor()
      assert.equal(await cards.count(), 2)
      const texts = await cards.allInnerTexts()
      assert.ok(
        texts.some((t) => t.includes('Claude Code') && t.includes('.claude')),
        texts.join('|')
      )
      assert.ok(
        texts.some((t) => t.includes('Codex') && t.includes('.codex')),
        texts.join('|')
      )

      // Claude's variant for OpenCode; Codex keeps its own variant, which needs a decision on the existing folder
      await chooseVariant(page, 'skill-pdf-opencode', 'Claude Code')
      await waitStatus(page, 'skill-pdf-opencode', 'toApply')
      await chooseVariant(page, 'skill-pdf-codex', 'Codex')
      await waitStatus(page, 'skill-pdf-codex', 'conflict')
      await page.getByTestId('resolve-skill-pdf-codex').click()
      const panel = page.getByTestId('conflict-panel')
      await panel.waitFor()
      assert.match(await panel.innerText(), /codex pdf/)
      await page.screenshot({ path: join(shots, '01-conflict.png') })
      await page.getByTestId('conflict-accept').click()
      await waitStatus(page, 'skill-pdf-codex', 'toApply')
      assert.equal(await status(page, 'skill-pdf-claude'), 'unmanaged')
      assert.deepEqual(snapTools(home), initial, 'a choice wrote into a tool folder')

      await page.getByTestId('open-preview').click()
      const preview = page.getByTestId('preview-modal')
      await preview.waitFor()
      const changes = preview.locator('[data-testid="preview-change"]')
      assert.equal(await changes.count(), 2)
      assert.deepEqual(
        (
          await changes.evaluateAll((els) =>
            els.map((e) => `${e.getAttribute('data-tool')}:${e.getAttribute('data-op')}`)
          )
        ).sort(),
        ['codex:adopt', 'opencode:create']
      )
      // The adoption of identical content is not counted as a write
      assert.match(await preview.innerText(), /2 destination\(s\), 1 with a write/)
      await page.screenshot({ path: join(shots, '02-preview.png') })
      assert.deepEqual(snapTools(home), initial, 'the preview wrote into a tool folder')

      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="completed"]').waitFor()
      await page.screenshot({ path: join(shots, '03-result.png') })
      assert.equal(
        readFileSync(join(home, '.config/opencode/skills/pdf/SKILL.md'), 'utf8'),
        '---\nname: pdf\ndescription: claude\n---\nclaude pdf\n'
      )
      assert.equal(
        readFileSync(join(home, '.config/opencode/skills/pdf/ref/a.md'), 'utf8'),
        'claude resource\n'
      )
      assert.deepEqual(
        contentSnapshot(join(home, '.codex')),
        codexBefore,
        'adoption changed Codex files'
      )
      await page.getByTestId('preview-close').click()
      await waitStatus(page, 'skill-pdf-opencode', 'synced')
      await waitStatus(page, 'skill-pdf-codex', 'synced')
    } finally {
      await app.close()
    }
  }
)

test(
  'Windows flow: a destination changed after preview is refused and its new content is preserved',
  { timeout: 240000 },
  async () => {
    const home = syntheticHome('illithid ui stale ')
    put(
      home,
      '.claude/skills/pdf/SKILL.md',
      '---\nname: pdf\ndescription: source\n---\nsource skill\n'
    )
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const { app, page } = await launch(home)
    try {
      await confirmPaths(page)
      await importAll(page)
      await page.getByTestId('nav-skills').click()
      await chooseVariant(page, 'skill-pdf-opencode', 'Claude Code')
      await waitStatus(page, 'skill-pdf-opencode', 'toApply')
      const beforePreview = snapTools(home)
      await page.getByTestId('open-preview').click()
      await page.getByTestId('preview-modal').waitFor()
      assert.deepEqual(snapTools(home), beforePreview, 'preview changed tool files')

      const localContent = '---\nname: pdf\ndescription: local\n---\nkeep this local change\n'
      put(home, '.config/opencode/skills/pdf/SKILL.md', localContent)
      const afterLocalEdit = snapTools(home)
      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="refused"]').waitFor()
      assert.match(await page.getByTestId('preview-modal').innerText(), /changedSinceCheck/)
      assert.deepEqual(snapTools(home), afterLocalEdit, 'stale preview overwrote tool files')
      assert.equal(
        readFileSync(join(home, '.config/opencode/skills/pdf/SKILL.md'), 'utf8'),
        localContent
      )
      await page.screenshot({ path: join(shots, '07-stale-preview.png') })
      await page.getByTestId('preview-close').click()
      await waitStatus(page, 'skill-pdf-opencode', 'conflict')
    } finally {
      await app.close()
    }
  }
)

test(
  'Windows flow: restore with original bytes already present also restores the previous unmanaged ownership',
  { timeout: 240000 },
  async () => {
    const home = syntheticHome('illithid ui ownership ')
    put(home, '.claude/rules/style.md', '# shared style\n')
    const original = 'codex user text\n'
    put(home, '.codex/AGENTS.md', original)
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const { app, page } = await launch(home)
    try {
      await confirmPaths(page)
      await importAll(page)
      await page.getByTestId('nav-rules').click()
      await chooseVariant(page, 'rule-style.md-codex', 'Claude Code')
      await waitStatus(page, 'rule-style.md-codex', 'toApply')
      await page.getByTestId('open-preview').click()
      await page.getByTestId('preview-modal').waitFor()
      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="completed"]').waitFor()
      assert.equal(readDeliveries(home).filter((r) => r.tool === 'codex').length, 1)
      await page.getByTestId('preview-close').click()

      put(home, '.codex/AGENTS.md', original)
      const beforeRestore = snapTools(home)
      await page.getByTestId('nav-operations').click()
      const op = page.locator('[data-testid="operation-row"][data-status="completed"]')
      await op.waitFor()
      await op.getByTestId('restore-preview').click()
      const preview = page.getByTestId('preview-modal')
      await preview.waitFor()
      assert.equal(
        await preview.locator('[data-testid="preview-change"][data-op="unchanged"]').count(),
        1
      )
      assert.deepEqual(snapTools(home), beforeRestore, 'restore preview changed tool files')
      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="completed"]').waitFor()
      assert.equal(
        readDeliveries(home).filter((r) => r.tool === 'codex').length,
        0,
        'restore kept an owner that did not exist before'
      )
      assert.deepEqual(snapTools(home), beforeRestore, 'unchanged restore rewrote tool files')
      await page.screenshot({ path: join(shots, '08-restore-ownership.png') })
    } finally {
      await app.close()
    }
  }
)

test(
  'Windows flow: a partial result is reported as such and the operation can be restored',
  { timeout: 240000 },
  async () => {
    const home = syntheticHome('illithid ui ')
    put(home, '.claude/rules/style.md', '# style\n')
    put(home, '.codex/AGENTS.md', 'codex user text\n')
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const before = contentSnapshot(join(home, '.codex'))
    const { app, page } = await launch(home)
    let undo: (() => void) | null = null
    try {
      await confirmPaths(page)
      await importAll(page)
      await page.getByTestId('nav-rules').click()
      await chooseVariant(page, 'rule-style.md-codex', 'Claude Code')
      await waitStatus(page, 'rule-style.md-codex', 'toApply')
      await chooseVariant(page, 'rule-style.md-opencode', 'Claude Code')
      await waitStatus(page, 'rule-style.md-opencode', 'toApply')
      await page.getByTestId('open-preview').click()
      await page.getByTestId('preview-modal').waitFor()
      // OpenCode's folder stops accepting new files between the preview and the apply
      undo = denyWrite(join(home, '.config/opencode'))
      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="partial"]').waitFor()
      const result = await page.getByTestId('preview-modal').innerText()
      assert.match(result, /failed/i)
      assert.doesNotMatch(result, /Nothing has been written yet/)
      await page.screenshot({ path: join(shots, '04-partial.png') })
      undo()
      undo = null
      await page.getByTestId('preview-close').click()

      await page.getByTestId('nav-operations').click()
      const op = page.locator('[data-testid="operation-row"][data-status="partial"]')
      await op.waitFor()
      await op.getByTestId('restore-preview').click()
      await page.getByTestId('preview-modal').waitFor()
      await page.screenshot({ path: join(shots, '05-restore-preview.png') })
      await page.getByTestId('preview-apply').click()
      await page.locator('[data-testid="result-status"][data-status="completed"]').waitFor()
      await page.screenshot({ path: join(shots, '06-restore-result.png') })
      assert.deepEqual(contentSnapshot(join(home, '.codex')), before)
    } finally {
      undo?.()
      await app.close()
    }
  }
)

test(
  'Windows flow: linked skills are imported only after an explicit confirmation of every link and target shown',
  { timeout: 240000 },
  async () => {
    const home = syntheticHome('illithid ui linked ')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a, 0x1a])
    put(home, '.claude/skills/plain/SKILL.md', '---\nname: plain\n---\nplain\n')
    const shared = join(home, 'shared skills')
    put(shared, 'caveman/SKILL.md', '---\nname: caveman\n---\nTalk like caveman.\n')
    put(shared, 'caveman/assets/logo.png', png)
    put(shared, 'tidy/SKILL.md', '---\nname: tidy\n---\nKeep it tidy.\n')
    put(shared, 'tidy/scripts/run.cmd', '@echo off\r\necho ran> "%~dp0..\\..\\ran.txt"\r\n')
    mkdirSync(join(home, '.codex/skills'), { recursive: true })
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    const links = [join(home, '.claude/skills/caveman'), join(home, '.codex/skills/tidy')]
    symlinkSync(join(shared, 'caveman'), links[0], 'junction')
    symlinkSync(join(shared, 'tidy'), links[1], 'junction')
    const targets = [join(shared, 'caveman'), join(shared, 'tidy')].map((p) =>
      realpathSync.native(p)
    )
    const library = (): string[] =>
      existsSync(globalLibraryDir(home)) ? readdirSync(globalLibraryDir(home)) : []
    const toolsBefore = snapTools(home)
    const sharedBefore = snapshot(shared)
    const { app, page } = await launch(home)
    try {
      await confirmPaths(page)
      await page.getByTestId('open-import').click()
      const rows = page.getByTestId('linked-item')
      await rows.first().waitFor()
      assert.equal(await rows.count(), 2)
      const rowText = (await rows.allInnerTexts()).join('|')
      for (const p of [...links, ...targets]) assert.ok(rowText.includes(p), p)

      // Never preselected, never reached by "Select all"
      await page.getByTestId('import-select-all').click()
      for (const i of [0, 1])
        assert.equal(await page.getByTestId(`linked-check-${i}`).isChecked(), false)
      assert.match(await page.getByTestId('import-run').innerText(), /Import 1 selected/)

      // Multiple selection; the confirmation lists every link and target it covers
      await page.getByTestId('linked-check-0').check()
      await page.getByTestId('linked-check-1').check()
      await page.getByTestId('linked-pending').waitFor()
      assert.match(await page.getByTestId('import-run').innerText(), /Import 1 selected/)
      await page.getByTestId('linked-review').click()
      const panel = page.getByTestId('linked-confirm-panel')
      await panel.waitFor()
      const listed = (await panel.getByTestId('linked-confirm-path').allInnerTexts()).join('|')
      for (const p of [...links, ...targets]) assert.ok(listed.includes(p), p)
      await page.screenshot({ path: join(shots, '09-linked-confirm.png') })

      // Cancel: nothing read into the library, links and targets unchanged
      await page.getByTestId('linked-cancel').click()
      await panel.waitFor({ state: 'detached' })
      assert.equal(await page.locator('[data-testid="linked-item"][data-ready="true"]').count(), 0)
      assert.deepEqual(library(), [])
      assert.deepEqual(snapshot(shared), sharedBefore)
      assert.deepEqual(snapTools(home), toolsBefore)

      // Confirm: the targets are read (nothing written yet), then imported with the ordinary selection
      await page.getByTestId('linked-review').click()
      await page.getByTestId('linked-confirm').click()
      await page.locator('[data-testid="linked-item"][data-ready="true"]').nth(1).waitFor()
      assert.deepEqual(library(), [], 'reading the targets wrote into the library')
      assert.match(await page.getByTestId('import-run').innerText(), /Import 3 selected/)
      await page.getByTestId('import-run').click()
      const result = page.getByTestId('import-result')
      await result.waitFor()
      assert.match(await result.innerText(), /3 imported, 0 not imported/)
      await page.screenshot({ path: join(shots, '10-linked-result.png') })

      const variants = readStoredVariants(home).variants
      assert.deepEqual(variants.map((v) => v.name).sort(), ['caveman', 'plain', 'tidy'])
      const cave = variants.find((v) => v.name === 'caveman')!
      assert.deepEqual(
        [cave.origins[0].tool, cave.origins[0].path, cave.origins[0].linkTarget],
        ['claude', links[0], targets[0]]
      )
      assert.deepEqual(readFileSync(join(cave.dir, 'content/assets/logo.png')), png)
      const tidy = variants.find((v) => v.name === 'tidy')!
      assert.deepEqual(
        [tidy.origins[0].tool, tidy.origins[0].path, tidy.origins[0].linkTarget],
        ['codex', links[1], targets[1]]
      )
      assert.ok(existsSync(join(tidy.dir, 'content/scripts/run.cmd')))
      // Links, targets and contents as they were; no script ran
      assert.deepEqual(snapTools(home), toolsBefore)
      assert.deepEqual(snapshot(shared), sharedBefore)
      assert.equal(existsSync(join(home, 'ran.txt')), false)
    } finally {
      await app.close()
    }
  }
)

interface LateHome {
  home: string
  shared: string
  links: string[]
  toolsBefore: Record<string, Record<string, string>>
  sharedBefore: Record<string, string>
}

/** A plain Claude Code skill; caveman (Claude Code) and tidy (Codex) installed as junctions to a shared folder */
function lateHome(): LateHome {
  const home = syntheticHome('illithid ui late ')
  put(home, '.claude/skills/plain/SKILL.md', '---\nname: plain\n---\nplain\n')
  const shared = join(home, 'shared skills')
  put(shared, 'caveman/SKILL.md', '---\nname: caveman\n---\nTalk like caveman.\n')
  put(shared, 'tidy/SKILL.md', '---\nname: tidy\n---\nKeep it tidy.\n')
  mkdirSync(join(home, '.codex/skills'), { recursive: true })
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  const links = [join(home, '.claude/skills/caveman'), join(home, '.codex/skills/tidy')]
  symlinkSync(join(shared, 'caveman'), links[0], 'junction')
  symlinkSync(join(shared, 'tidy'), links[1], 'junction')
  return { home, shared, links, toolsBefore: snapTools(home), sharedBefore: snapshot(shared) }
}

/** Opens the import, selects the linked rows and confirms them while the preview reply is held */
async function confirmHeld(app: ElectronApplication, page: Page, rows: number[]): Promise<void> {
  const asked = await probe(app, '__previewAsked')
  await page.getByTestId('open-import').click()
  for (const i of rows) await page.getByTestId(`linked-check-${i}`).check()
  await page.getByTestId('linked-review').click()
  await holdPreview(app)
  await page.getByTestId('linked-confirm').click()
  await until('the preview request', async () => (await probe(app, '__previewAsked')) > asked)
}

const readyRows = (page: Page): Promise<number> =>
  page.locator('[data-testid="linked-item"][data-ready="true"]').count()
const sentLinks = async (app: ElectronApplication): Promise<string[][]> =>
  (await probe(app, '__linkedImports')).map((call) => call.map((s) => s.linkPath))
const variantNames = (home: string): string[] =>
  readStoredVariants(home)
    .variants.map((v) => v.name)
    .sort()

test(
  'Windows flow: a late preview reply does not bring back a linked skill deselected meanwhile',
  { timeout: 240000 },
  async () => {
    const l = lateHome()
    const { app, page } = await launch(l.home)
    try {
      await confirmPaths(page)
      await probeLinkedChannels(app)
      await confirmHeld(app, page, [0, 1])
      await page.getByTestId('linked-check-0').uncheck()
      await deliverLatePreview(app, page, 1)
      assert.equal(await readyRows(page), 0, 'the late reply brought back a preview')
      assert.equal(await page.getByTestId('linked-check-0').isChecked(), false)
      assert.match(await page.getByTestId('import-run').innerText(), /Import 0 selected/)
      // Tidy alone, confirmed again: only tidy reaches the import
      await page.getByTestId('linked-review').click()
      await page.getByTestId('linked-confirm').click()
      await page.locator('[data-testid="linked-item"][data-ready="true"]').first().waitFor()
      assert.equal(await readyRows(page), 1)
      await page.getByTestId('import-select-all').click()
      assert.match(await page.getByTestId('import-run').innerText(), /Import 2 selected/)
      await page.getByTestId('import-run').click()
      await page.getByTestId('import-result').waitFor()
      assert.deepEqual(await sentLinks(app), [[l.links[1]]])
      assert.deepEqual(variantNames(l.home), ['plain', 'tidy'])
      assert.deepEqual(snapTools(l.home), l.toolsBefore)
      assert.deepEqual(snapshot(l.shared), l.sharedBefore)
    } finally {
      await app.close()
    }
  }
)

test(
  'Windows flow: a late preview reply does not override Cancel',
  { timeout: 240000 },
  async () => {
    const l = lateHome()
    const { app, page } = await launch(l.home)
    try {
      await confirmPaths(page)
      await probeLinkedChannels(app)
      await confirmHeld(app, page, [0, 1])
      await page.getByTestId('linked-cancel').click()
      await deliverLatePreview(app, page, 1)
      assert.equal(await readyRows(page), 0, 'the late reply overrode Cancel')
      assert.equal(await page.getByTestId('linked-confirm-panel').count(), 0)
      assert.match(await page.getByTestId('import-run').innerText(), /Import 0 selected/)
      // An ordinary import afterwards sends no linked skill
      await page.getByTestId('import-select-all').click()
      await page.getByTestId('import-run').click()
      await page.getByTestId('import-result').waitFor()
      assert.deepEqual(await sentLinks(app), [])
      assert.deepEqual(variantNames(l.home), ['plain'])
      assert.deepEqual(snapTools(l.home), l.toolsBefore)
      assert.deepEqual(snapshot(l.shared), l.sharedBefore)
    } finally {
      await app.close()
    }
  }
)

test(
  'Windows flow: a late preview reply after the import was closed changes nothing',
  { timeout: 240000 },
  async () => {
    const l = lateHome()
    const { app, page } = await launch(l.home)
    try {
      await confirmPaths(page)
      await probeLinkedChannels(app)
      await confirmHeld(app, page, [0])
      await page.getByTestId('import-close').click()
      await page.getByTestId('import-close').waitFor({ state: 'detached' })
      await deliverLatePreview(app, page, 1)
      await page.getByTestId('open-import').click()
      await page.getByTestId('linked-item').first().waitFor()
      assert.equal(await readyRows(page), 0)
      assert.equal(await page.getByTestId('linked-check-0').isChecked(), false)
      await page.getByTestId('import-close').click()
      assert.deepEqual(await sentLinks(app), [])
      assert.deepEqual(variantNames(l.home), [])
      assert.deepEqual(snapTools(l.home), l.toolsBefore)
      assert.deepEqual(snapshot(l.shared), l.sharedBefore)
    } finally {
      await app.close()
    }
  }
)
