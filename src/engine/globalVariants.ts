/**
 * Library variants of global rules and skills and the human decisions bound to them (spec 2026-10-04 §5, §7).
 * - A variant has a stable id distinct from its display name; same-name variants coexist.
 * - The revision is the digest of the current library content (whole tree for a skill), computed on every read.
 * - Same name + same content is only a merge suggestion (sameContentAs); merging is an explicit user action.
 * - A delivery choice names the variant revision and the destination digest the user saw; a changed revision makes it
 *   stale. Nothing is decided from names, dates or import order.
 * State lives in the global store (globalStateDir), not in upstream state.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  contentDigest,
  originKey,
  readStoredVariants,
  VARIANT_FILE,
  type GlobalKind,
  type GlobalReference,
  type StoredVariant,
  type VariantOrigin
} from './globalImport'
import { globalStateDir, type GlobalTool } from './globalPaths'
import { destinationKey } from './globalDestinations'
import { atomicWrite } from './write'

export type { GlobalTool } from './globalPaths'
export type VariantId = string
export type Revision = string

export interface VariantRecord {
  id: VariantId
  kind: GlobalKind
  name: string
  revision: Revision
  origins: VariantOrigin[]
  /** Rule: the content file; skill: the content folder */
  contentPath: string
  references: GlobalReference[]
  /** Other variants with the same kind, name and revision (merge candidates, never merged implicitly) */
  sameContentAs: VariantId[]
}

export interface DeliveryChoice {
  variantId: VariantId
  variantRevision: Revision
  tool: GlobalTool
  destination: string
  /** Destination digest the user saw; null = the destination was absent (not "unchecked") */
  expectedDestinationDigest: string | null
}

/** What the app delivered last to a destination (written by the apply step) */
export interface DeliveryRecord {
  destination: string
  tool: GlobalTool
  kind: GlobalKind
  variantId: VariantId
  variantRevision: Revision
  deliveredDigest: string
  at: string
  operationId: string
}

function revisionOf(kind: GlobalKind, path: string): Revision {
  try {
    return contentDigest(kind, path)
  } catch (e) {
    return `error:${(e as NodeJS.ErrnoException).code ?? 'readFailed'}`
  }
}

/** Variants of the library, sorted by name, first import time and id */
export function listGlobalVariants(home: string): VariantRecord[] {
  const base = readStoredVariants(home).variants.map((v) => {
    const contentPath = join(v.dir, v.content)
    return {
      id: v.id,
      kind: v.kind,
      name: v.name,
      revision: revisionOf(v.kind, contentPath),
      origins: v.origins,
      contentPath,
      references: v.references ?? []
    }
  })
  const firstAt = (o: VariantOrigin[]): string => o.map((x) => x.importedAt).sort()[0] ?? ''
  return base
    .map((v) => ({
      ...v,
      sameContentAs: base
        .filter(
          (o) =>
            o.id !== v.id &&
            o.kind === v.kind &&
            o.name === v.name &&
            o.revision === v.revision &&
            !v.revision.startsWith('error:')
        )
        .map((o) => o.id)
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        firstAt(a.origins).localeCompare(firstAt(b.origins)) ||
        a.id.localeCompare(b.id)
    )
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Display/delivery name: relative segments valid on Windows; one segment for a skill; rules end with .md */
export function validVariantName(kind: GlobalKind, name: string): boolean {
  if (!name || name.includes('-->') || name.includes('::')) return false
  const segs = name.split('/')
  if (kind === 'skill' && segs.length !== 1) return false
  if (kind === 'rule' && !name.toLowerCase().endsWith('.md')) return false
  return segs.every(
    (s) =>
      !!s &&
      s !== '.' &&
      s !== '..' &&
      !/[<>:"\\|?*]/.test(s) &&
      ![...s].some((ch) => ch.charCodeAt(0) < 32) &&
      !/[ .]$/.test(s) &&
      !WINDOWS_RESERVED.test(s)
  )
}

function writeStored(dir: string, v: StoredVariant): void {
  atomicWrite(join(dir, VARIANT_FILE), JSON.stringify(v, null, 2) + '\n')
}

function stored(home: string, id: VariantId): (StoredVariant & { dir: string }) | undefined {
  return readStoredVariants(home).variants.find((v) => v.id === id)
}

/** Changes only the display name (content, frontmatter and references untouched) */
export function renameGlobalVariant(
  home: string,
  id: VariantId,
  name: string
): { ok: true } | { ok: false; code: 'notFound' | 'invalidName' } {
  const v = stored(home, id)
  if (!v) return { ok: false, code: 'notFound' }
  if (!validVariantName(v.kind, name)) return { ok: false, code: 'invalidName' }
  const { dir, ...rest } = v
  writeStored(dir, { ...rest, name })
  return { ok: true }
}

/**
 * Explicit merge of same-name variants with identical content into the first id (origins combined). The other folders
 * are moved to `<global state>/merged/`, not deleted. Refused when contents differ, when the revision changed since the
 * user saw it, or when a merged-away variant is recorded as delivered.
 */
export function mergeGlobalVariants(
  home: string,
  ids: VariantId[],
  expectedRevision: Revision
):
  | { ok: true; id: VariantId }
  | {
      ok: false
      code: 'notFound' | 'tooFew' | 'contentDiffers' | 'nameDiffers' | 'changedSinceCheck' | 'inUse'
    } {
  const unique = [...new Set(ids)]
  if (unique.length < 2) return { ok: false, code: 'tooFew' }
  const all = readStoredVariants(home).variants
  const vs = unique.map((id) => all.find((v) => v.id === id))
  if (vs.some((v) => !v)) return { ok: false, code: 'notFound' }
  const list = vs as (StoredVariant & { dir: string })[]
  const revs = list.map((v) => revisionOf(v.kind, join(v.dir, v.content)))
  if (list.some((v) => v.kind !== list[0].kind) || revs.some((r) => r !== revs[0]))
    return { ok: false, code: 'contentDiffers' }
  if (list.some((v) => v.name !== list[0].name)) return { ok: false, code: 'nameDiffers' }
  if (revs[0] !== expectedRevision) return { ok: false, code: 'changedSinceCheck' }
  const away = new Set(unique.slice(1))
  if (readDeliveries(home).some((r) => away.has(r.variantId))) return { ok: false, code: 'inUse' }
  const [keep, ...rest] = list
  const seen = new Set<string>()
  const origins = [keep, ...rest]
    .flatMap((v) => v.origins)
    .filter((o) => {
      const k = originKey(o)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  const { dir, ...keepRecord } = keep
  writeStored(dir, { ...keepRecord, origins })
  const archive = join(globalStateDir(home), 'merged')
  mkdirSync(archive, { recursive: true })
  for (const v of rest) renameSync(v.dir, join(archive, v.id))
  return { ok: true, id: keep.id }
}

const choicesPath = (home: string): string => join(globalStateDir(home), 'choices.json')
const deliveriesPath = (home: string): string => join(globalStateDir(home), 'deliveries.json')

function readList<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return []
  const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o[key])) throw new Error(`${path}: unsupported format`)
  return o[key] as T[]
}

export function readGlobalChoices(home: string): DeliveryChoice[] {
  return readList<DeliveryChoice>(choicesPath(home), 'choices')
}

export function writeGlobalChoices(home: string, choices: DeliveryChoice[]): void {
  atomicWrite(choicesPath(home), JSON.stringify({ version: 1, choices }, null, 2) + '\n')
}

export function readDeliveries(home: string): DeliveryRecord[] {
  return readList<DeliveryRecord>(deliveriesPath(home), 'entries')
}

export function writeDeliveries(home: string, entries: DeliveryRecord[]): void {
  atomicWrite(deliveriesPath(home), JSON.stringify({ version: 1, entries }, null, 2) + '\n')
}

/** Delivery record of a destination (Windows-insensitive match), if any */
export function deliveryAt(
  records: DeliveryRecord[],
  destination: string
): DeliveryRecord | undefined {
  const k = destinationKey(destination)
  return records.find((r) => destinationKey(r.destination) === k)
}

export type ChoiceStatus = 'valid' | 'staleRevision' | 'unknownVariant'

/** Whether each choice still refers to an existing variant at the revision the user chose */
export function choiceValidity(
  home: string,
  choices: DeliveryChoice[],
  variants: VariantRecord[] = listGlobalVariants(home)
): { choice: DeliveryChoice; status: ChoiceStatus }[] {
  return choices.map((choice) => {
    const v = variants.find((x) => x.id === choice.variantId)
    const status: ChoiceStatus = !v
      ? 'unknownVariant'
      : v.revision !== choice.variantRevision
        ? 'staleRevision'
        : 'valid'
    return { choice, status }
  })
}

/** Leaves a destination unmanaged: the delivery record is dropped, the content stays exactly as it is */
export function forgetDelivery(
  home: string,
  destination: string
): { ok: true } | { ok: false; code: 'notManaged' } {
  const all = readDeliveries(home)
  const k = destinationKey(destination)
  const rest = all.filter((r) => destinationKey(r.destination) !== k)
  if (rest.length === all.length) return { ok: false, code: 'notManaged' }
  writeDeliveries(home, rest)
  return { ok: true }
}
