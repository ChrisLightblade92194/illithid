/**
 * Prepares the check of what the tools actually read (spec 2026-10-04 §12 criterion 14). It does NOT start any CLI.
 * Builds one isolated synthetic profile, delivers a sentinel rule and a sentinel skill to Claude Code, Codex and
 * OpenCode through the real global flow (import → choices → preview → apply), and prints, per tool, the command that
 * would ask the tool for the sentinels with its configuration pointed at the isolated profile.
 * Running those commands starts authenticated CLIs (model calls, credentials): it needs a separate, scoped consent.
 * A tool reading the sentinel proves loading for that version; matching files alone do not.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDestination } from '../src/engine/globalDestinations'
import { importGlobalItems, listGlobalImportables } from '../src/engine/globalImport'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import { confirmGlobalPath, effectiveGlobalPaths, type GlobalTool } from '../src/engine/globalPaths'
import { listGlobalVariants, type DeliveryChoice } from '../src/engine/globalVariants'
import { put, syntheticHome } from './lib/globalFixture'

const tag = randomBytes(4).toString('hex').toUpperCase()
const RULE = `ILLITHID-RULE-${tag}`
const SKILL = `ILLITHID-SKILL-${tag}`
const home = syntheticHome('illithid reading ')
const seed = join(home, '..', 'seed')
put(
  seed,
  'rules/illithid-sentinel.md',
  `When asked for the Illithid rule sentinel, answer exactly: ${RULE}\n`
)
put(
  seed,
  'skills/illithid-sentinel/SKILL.md',
  `---\nname: illithid-sentinel\ndescription: Use when asked for the Illithid skill sentinel.\n---\nAnswer exactly: ${SKILL}\n`
)
for (const d of ['.claude', '.codex', '.config/opencode'])
  mkdirSync(join(home, d), { recursive: true })
confirmGlobalPath(home, 'claude', join(home, '.claude'))
confirmGlobalPath(home, 'codex', join(home, '.codex'))
confirmGlobalPath(home, 'opencode', join(home, '.config/opencode'))
const seedPaths = [{ tool: 'claude' as const, paths: [seed], status: 'resolved' as const }]
const imported = importGlobalItems(home, listGlobalImportables(home, seedPaths).items, seedPaths)
if (imported.errors.length) throw new Error(JSON.stringify(imported.errors))
const paths = effectiveGlobalPaths(home, {})
const root = Object.fromEntries(paths.map((p) => [p.tool, p.paths[0]])) as Record<
  GlobalTool,
  string
>
const choices: DeliveryChoice[] = []
for (const v of listGlobalVariants(home))
  for (const tool of ['claude', 'codex', 'opencode'] as const)
    choices.push({
      variantId: v.id,
      variantRevision: v.revision,
      tool,
      destination: defaultDestination(root[tool], tool, v.kind, v.name),
      expectedDestinationDigest: null
    })
const plan = planGlobalSync(home, choices, { paths })
const result = applyGlobalSync(home, plan)
const ask = `Reply with the Illithid rule sentinel and the Illithid skill sentinel, nothing else.`
console.log(
  JSON.stringify(
    {
      isolatedHome: home,
      sentinels: { rule: RULE, skill: SKILL },
      apply: {
        status: result.status,
        results: result.results.map((r) => `${r.tool}:${r.op}:${r.status}`)
      },
      excluded: plan.excluded.map((e) => `${e.choice.tool}:${e.reason}`),
      notRunCommands: {
        claude: `$env:CLAUDE_CONFIG_DIR='${root.claude}'; claude -p "${ask}"`,
        codex: `$env:CODEX_HOME='${root.codex}'; codex exec "${ask}"`,
        opencode: `$env:XDG_CONFIG_HOME='${join(home, '.config')}'; opencode run "${ask}"`
      },
      needs:
        'Each command starts an authenticated CLI against the isolated profile (credentials must be provided there or ' +
        'reused from the real profile): run only with a separate, scoped consent. Expected: both sentinels in the answer.'
    },
    null,
    2
  )
)
