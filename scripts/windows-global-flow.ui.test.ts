/**
 * Task 7 — the Windows global flow from the UI (spec 2026-10-04 §6, §7, §9, §11; criteria 3, 4, 5, 10).
 * Runs the built app (`npm run build` first) on synthetic profiles only. Screenshots go to ILLITHID_SHOTS (or a temp
 * folder) for review: conflict, preview, partial result, restore.
 * A synced state means matching files; it does not show that a tool loaded the instructions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { contentSnapshot, denyWrite, put, snapshot, syntheticHome } from './lib/globalFixture'
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
