/**
 * Import of selected complete census occurrences into the variant library (spec 2026-10-06 project delivery §Import
 * selected census items). Items are imported one after the other, each as a new variant with its own id:
 * - The source is read again completely (never through a link, within the census limits) and must still have the
 *   census content; the project's folder chain must still be the discovered one, and the run must still be current.
 * - The copy is verified against that observation, the source identities are checked once more, and the variant
 *   record is written last: a refused, failed or cancelled item leaves no folder and no registered variant.
 * - Cancellation (the import's own signal, or the run's when it is cancelled or superseded) stops the queue; variants
 *   already registered stay and are reported. An in-flight filesystem call may finish; its unfinished copy is removed.
 * Only the selected items are read: other occurrences seen by the census are not touched. Referenced files are not
 * copied; references are recorded (as in the global import) with a check that never follows a link.
 */
import { randomBytes } from 'node:crypto'
import { lstatSync, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { manifestKey } from '../census/compare'
import type { CensusItem } from '../census/types'
import {
  knownOrigins,
  originKey,
  ruleReferences,
  skillReferences,
  VARIANT_FILE,
  type GlobalReference,
  type StoredVariant
} from '../globalImport'
import { globalLibraryDir, type GlobalTool } from '../globalPaths'
import { validVariantName } from '../globalVariants'
import { atomicWrite } from '../write'
import { copyProjectContent, observeProjectContent, recheckIdentities } from './content'
import {
  ProjectError,
  type CensusImportLease,
  type ProjectContentObservation,
  type ProjectContext,
  type ProjectImportHooks,
  type ProjectImportItemResult,
  type ProjectImportResult,
  type ProjectOrigin
} from './types'

/** Library name of an occurrence: a skill's folder; a rule's file name, or its path inside `.claude/rules/` */
export function variantNameOf(item: Pick<CensusItem, 'kind' | 'name' | 'relativePath'>): string {
  if (item.kind === 'skill') return item.name
  const rules = '.claude/rules/'
  return item.relativePath.startsWith(rules)
    ? item.relativePath.slice(rules.length)
    : item.relativePath.split('/').pop()!
}

/** The observation still has the census content: same bytes for a rule, the same complete manifest for a skill */
function matchesCensus(o: ProjectContentObservation, item: CensusItem): boolean {
  if (o.censusDigest !== item.digest) return false
  return item.kind === 'rule'
    ? o.bytes === item.bytes
    : !!item.manifest && !!o.manifest && manifestKey(o.manifest) === manifestKey(item.manifest)
}

/** Existence of a referenced path from its own metadata: never through a link, never a network or device path */
function existsNoFollow(p: string): boolean {
  if (/^[\\/]{2}/.test(p)) return false
  try {
    return !!lstatSync(p, { throwIfNoEntry: false })
  } catch {
    return false
  }
}

/** References of the verified library copy, resolved against the source location */
async function referencesOf(
  home: string,
  source: ProjectContentObservation,
  copy: ProjectContentObservation
): Promise<GlobalReference[]> {
  if (source.kind === 'rule')
    return ruleReferences(
      home,
      source.sourcePath,
      (await fsp.readFile(copy.sourcePath)).toString('utf8'),
      existsNoFollow
    )
  const md = (source.manifest ?? []).filter(
    (e) => e.kind === 'file' && e.path.toLowerCase().endsWith('.md')
  )
  const texts = new Map<string, string>()
  for (const e of md)
    texts.set(
      join(source.sourcePath, ...e.path.split('/')),
      (await fsp.readFile(join(copy.sourcePath, ...e.path.split('/')))).toString('utf8')
    )
  return skillReferences(home, source.sourcePath, [...texts.keys()], existsNoFollow, (f) =>
    texts.get(f)!
  )
}

const aborted = (signal: AbortSignal, e: unknown): boolean =>
  signal.aborted || (e as { name?: string } | null)?.name === 'AbortError'

/** Refusal code of a source that no longer matches the census (or a run/project that changed) */
function refusal(e: ProjectError): { code: string; reason?: string } {
  if (e.code === 'projectChanged' || e.code === 'stale' || e.code === 'invalid')
    return { code: e.code, ...(e.reason ? { reason: e.reason } : {}) }
  return { code: 'changedSinceCensus', ...(e.reason ? { reason: e.reason } : {}) }
}

export async function importProjectItems(
  ctx: ProjectContext,
  lease: CensusImportLease,
  hooks: ProjectImportHooks = {}
): Promise<ProjectImportResult> {
  const signal = AbortSignal.any([ctx.signal, lease.signal])
  const results: ProjectImportItemResult[] = lease.items.map(({ item, project }) => ({
    itemId: item.id,
    kind: item.kind,
    projectPath: project.path,
    relativePath: item.relativePath,
    status: 'notAttempted'
  }))
  const variantIds: string[] = []
  const library = globalLibraryDir(ctx.home)
  const known = knownOrigins(ctx.home)
  let cancelled = false
  for (let index = 0; index < lease.items.length; index++) {
    const { item, project } = lease.items[index]
    const res = results[index]
    if (signal.aborted) {
      cancelled = true
      break
    }
    hooks.onProgress?.(index, lease.items.length)
    let dir: string | null = null
    let registered = false
    try {
      lease.assertCurrent()
      const name = variantNameOf(item)
      if (!validVariantName(item.kind, name))
        throw new ProjectError('invalid', `${name} cannot be a library name.`, 'invalidName')
      const source = await observeProjectContent(project, item.relativePath, item.kind, signal)
      if (!matchesCensus(source, item))
        throw new ProjectError('changedSinceCheck', 'The content changed since the census.')
      const origin: ProjectOrigin = {
        scope: 'project',
        projectRoot: project.path,
        relativePath: item.relativePath,
        path: source.sourcePath,
        consumers: item.consumers as GlobalTool[],
        importedAt: '',
        digest: source.censusDigest,
        digestAlgorithm: source.censusAlgorithm
      }
      const key = originKey(origin)
      if (known.has(key)) {
        res.status = 'refused'
        res.code = 'alreadyImported'
        continue
      }
      const id = `${item.kind}-${randomBytes(8).toString('hex')}`
      signal.throwIfAborted()
      await fsp.mkdir(library, { recursive: true })
      signal.throwIfAborted()
      await fsp.mkdir(join(library, id))
      dir = join(library, id)
      const content = item.kind === 'rule' ? `content/${basename(source.sourcePath)}` : 'content'
      if (item.kind === 'rule') await fsp.mkdir(join(dir, 'content'))
      const copy = await copyProjectContent(source, join(dir, ...content.split('/')), signal)
      const references = await referencesOf(ctx.home, source, copy)
      // Right before registration: the source, its project and the run are still the ones read
      await recheckIdentities(source, signal)
      lease.assertCurrent()
      signal.throwIfAborted()
      const record: StoredVariant = {
        version: 1,
        id,
        kind: item.kind,
        name,
        content,
        origins: [{ ...origin, importedAt: new Date().toISOString() }],
        references
      }
      atomicWrite(join(dir, VARIANT_FILE), JSON.stringify(record, null, 2) + '\n')
      registered = true
      known.add(key)
      variantIds.push(id)
      res.status = 'imported'
      res.variantId = id
      await hooks.afterRegister?.(index)
    } catch (e) {
      if (registered) continue
      if (aborted(signal, e)) {
        cancelled = true
        res.status = 'notAttempted'
        res.code = 'cancelled'
      } else if (e instanceof ProjectError) {
        res.status = 'refused'
        Object.assign(res, refusal(e))
      } else {
        res.status = 'failed'
        res.code = (e as NodeJS.ErrnoException)?.code ?? 'importFailed'
      }
    } finally {
      // Every exit without a registered variant removes its provisional folder
      if (dir && !registered) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (cancelled) break
  }
  if (cancelled) for (const r of results) if (r.status === 'notAttempted') r.code ??= 'cancelled'
  hooks.onProgress?.(results.filter((r) => r.status !== 'notAttempted').length, lease.items.length)
  const imported = results.filter((r) => r.status === 'imported').length
  return {
    status: cancelled
      ? 'cancelled'
      : imported === results.length
        ? 'completed'
        : imported
          ? 'partial'
          : results.some((r) => r.status === 'failed')
            ? 'failed'
            : 'refused',
    items: results,
    variantIds
  }
}
