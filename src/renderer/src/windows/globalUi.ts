/** Shared labels and helpers of the Windows global screens */
import type { GlobalResult } from '../../../shared/api'
import type { GlobalTool } from '../../../engine/globalPaths'
import type { RecipientStatus } from '../../../engine/globalView'
import type { VariantRecord } from '../../../engine/globalVariants'

/** Unwraps a global channel result (throws with the backend code on refusal) */
export async function call<T>(p: Promise<GlobalResult<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw Object.assign(new Error(`${r.code}: ${r.message}`), { code: r.code })
  return r.value
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const TOOL_LABEL: Record<GlobalTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

export const STATUS_LABEL: Record<RecipientStatus, string> = {
  unmanaged: 'Not managed',
  toApply: 'To apply',
  synced: 'Synced (files match)',
  conflict: 'Conflict',
  unsupported: 'Not supported',
  error: 'Error'
}

export const STATUS_COLOR: Record<RecipientStatus, string> = {
  unmanaged: 'gray',
  toApply: 'blue',
  synced: 'green',
  conflict: 'orange',
  unsupported: 'grape',
  error: 'red'
}

export const OP_LABEL: Record<string, string> = {
  create: 'Create',
  update: 'Update (backup first)',
  replace: 'Replace (backup first)',
  adopt: 'Adopt as is (no write)',
  unchanged: 'Unchanged',
  remove: 'Remove (backup first)'
}

export const RESULT_COLOR: Record<string, string> = {
  done: 'green',
  unchanged: 'gray',
  refused: 'orange',
  failed: 'red',
  notAttempted: 'gray',
  pending: 'gray',
  completed: 'green',
  partial: 'orange',
  interrupted: 'red',
  running: 'blue'
}

export const short = (s: string | null | undefined, n = 8): string => (s ? s.slice(0, n) : '—')

/** Plain-language reason for an import error code (null = the code speaks for itself) */
const IMPORT_ERROR_TEXT: Record<string, string> = {
  linkedSource:
    'Linked file or rules/skills folder: not followed. Only a single linked skill folder can be imported, after confirmation.',
  link: 'Link inside the skill folder: not followed, so the skill cannot be imported.',
  externalLink:
    'Link inside the skill pointing outside it: not followed, so the skill cannot be imported.',
  brokenLink: 'Broken link: its target does not exist.',
  linkCycle: 'Cyclic link: it loops, or its target contains the link itself.',
  unsupportedLinkTarget:
    'Link to a network or device path: only local Windows folders are supported.',
  linkTargetNotFolder: 'The link does not point to a folder.',
  notASkill: 'The target folder has no SKILL.md file.',
  linkChanged:
    'The link or its target changed since it was shown: close and reopen the import to see them as they are now.',
  changedSincePreview: 'The content changed since it was read: review it again.',
  changedSinceListing: 'The content changed since it was listed: open the import again.',
  notListed: 'Not one of the items listed for import.',
  alreadyImported: 'This content is already in the library.',
  EPERM: 'Access denied.',
  EACCES: 'Access denied.'
}

export const importErrorText = (code: string): string | null => IMPORT_ERROR_TEXT[code] ?? null

/** A variant as listed in choices: name, every origin with its path, short revision (never the name alone) */
export function variantLabel(v: VariantRecord): string {
  const origins = v.origins.map((o) => `${TOOL_LABEL[o.tool]} (${o.path})`).join(', ')
  return `${v.name} — from ${origins} · rev ${short(v.revision)}`
}
