/**
 * Synthetic profiles for the Windows global rules/skills tests. Every HOME lives under the OS temp folder, with a
 * space and non-ASCII characters in its path; nothing here touches the real profiles.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** New synthetic HOME (`<tmp>/illithid glöbal XXXX/home ä ö`) */
export function syntheticHome(prefix = 'illithid glöbal '): string {
  const home = join(mkdtempSync(join(tmpdir(), prefix)), 'home ä ö')
  mkdirSync(home, { recursive: true })
  return home
}

/** Writes a file under root (parents created). Returns its absolute path */
export function put(root: string, rel: string, content: string | Buffer): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

/** Tree signature: dirs, file bytes + mtime, link targets. Missing root → {} */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (!st) return
    if (st.isSymbolicLink()) out[rel] = `L:${readlinkSync(p)}`
    else if (st.isDirectory()) {
      out[rel] = 'D'
      for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`)
    } else
      out[rel] =
        `F:${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.mtimeMs}:${st.size}`
  }
  walk(root, '.')
  return out
}

/** Denies read access to the current user (Windows ACL); returns an undo function */
export function denyRead(path: string): () => void {
  const user = process.env['USERNAME'] ?? ''
  const r = spawnSync('icacls', [path, '/deny', `${user}:(R)`])
  if (r.status !== 0) throw new Error(`icacls deny failed (${r.status})`)
  return () => {
    spawnSync('icacls', [path, '/remove:d', user])
  }
}

/**
 * Library variants seeded from a separate source root (outside the synthetic tool folders), imported as `tool`.
 * files: paths relative to that tool's root, e.g. `rules/a.md` or `skills/s/SKILL.md`. Returns the imported items.
 */
export async function seedVariants(
  home: string,
  files: Record<string, string | Buffer>,
  tool: 'claude' | 'codex' | 'opencode' = 'claude'
): Promise<import('../../src/engine/globalImport').ImportedGlobalItem[]> {
  const { importGlobalItems, listGlobalImportables } = await import('../../src/engine/globalImport')
  const src = mkdtempSync(join(dirname(home), `seed-${tool}-`))
  for (const [rel, body] of Object.entries(files)) put(src, rel, body)
  const paths = [{ tool, paths: [src], status: 'resolved' as const }]
  const r = importGlobalItems(home, listGlobalImportables(home, paths).items, paths)
  if (r.errors.length) throw new Error(`seed import failed: ${JSON.stringify(r.errors)}`)
  return r.items
}

/** Denies creating files and folders in a folder (Windows ACL); returns an undo function */
export function denyWrite(dir: string): () => void {
  const user = process.env['USERNAME'] ?? ''
  const r = spawnSync('icacls', [dir, '/deny', `${user}:(WD,AD)`])
  if (r.status !== 0) throw new Error(`icacls deny failed (${r.status})`)
  return () => {
    spawnSync('icacls', [dir, '/remove:d', user])
  }
}

/** Content signature of a tree (bytes only, no times): what a restore must reconstruct */
export function contentSnapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(root)).map(([k, v]) => [k, v.startsWith('F:') ? v.split(':')[1] : v])
  )
}
