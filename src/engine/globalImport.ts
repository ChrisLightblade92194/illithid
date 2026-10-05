/**
 * Selective import of global rules and skills into the variant library (spec 2026-10-04 §5, §6).
 * - Originals are only read: no move, no retire (no upstream pendingRetire), no ownership transfer.
 * - Links and junctions are never followed: a linked item or a link inside a skill is reported and not importable.
 * - A read error is reported and yields no item; a skill is importable only when every file of its tree was read.
 * - Each import is a new copy with its own id; the variant record (variant.json) is written last, after the copy was
 *   verified against the listed digest, so an interrupted import never looks complete.
 * Digests: rule = sha256 of the bytes; skill = upstream dirContentHash (relative paths + bytes of the whole tree).
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { findSection, parseDestination, readDestination } from './globalDestinations'
import {
  globalLibraryDir,
  NATIVE_LAYOUT,
  resolveGlobalPaths,
  type GlobalPathResult,
  type GlobalTool
} from './globalPaths'
import { deliveryAt, readDeliveries } from './globalVariants'
import { dirContentHash } from './skills'
import { atomicWrite } from './write'

export type GlobalKind = 'rule' | 'skill'

/** An include (rule `@path`) or a reference leaving a skill folder */
export interface GlobalReference {
  ref: string
  /** The referenced path exists */
  resolved: boolean
  /** Points outside the imported content (always true for rule includes) */
  external: boolean
}

export interface GlobalImportSelection {
  tool: GlobalTool
  kind: GlobalKind
  name: string
  sourcePath: string
  sourceDigest: string
}

export interface GlobalImportable extends GlobalImportSelection {
  references: GlobalReference[]
}

export interface GlobalImportError {
  path: string
  code: string
}

export interface GlobalImportListing {
  items: GlobalImportable[]
  errors: GlobalImportError[]
}

/** Provenance of a variant (the format of VariantRecord.origins) */
export interface VariantOrigin {
  tool: GlobalTool
  path: string
  importedAt: string
  digest: string
}

export interface ImportedGlobalItem {
  id: string
  kind: GlobalKind
  name: string
  /** Rule: the copied file; skill: the copied folder */
  storedPath: string
  origin: VariantOrigin
}

export interface GlobalImportResult {
  items: ImportedGlobalItem[]
  errors: GlobalImportError[]
}

/** On-disk record of a variant (`<library>/<id>/variant.json`) */
export interface StoredVariant {
  version: 1
  id: string
  kind: GlobalKind
  name: string
  /** Content path relative to the variant folder (`content/<file>` for a rule, `content` for a skill) */
  content: string
  origins: VariantOrigin[]
  references: GlobalReference[]
}

export const VARIANT_FILE = 'variant.json'

export function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Digest of a variant or destination content of the given kind */
export function contentDigest(kind: GlobalKind, path: string): string {
  return kind === 'rule' ? fileDigest(path) : dirContentHash(path)
}

function within(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!!r && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r))
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? 'readFailed'
}

/** Lines outside fenced code blocks, inline code removed */
function proseLines(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) out.push(line.replace(/`[^`]*`/g, ''))
  }
  return out
}

const INCLUDE_RE = /(?:^|\s)@([^\s`'"<>()[\]]+)/g
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/** `@path` tokens that look like file paths (a separator or an extension), trailing punctuation dropped */
function includeRefs(text: string): string[] {
  const refs: string[] = []
  for (const line of proseLines(text))
    for (const m of line.matchAll(INCLUDE_RE)) {
      const ref = m[1].replace(/[.,;:!?]+$/, '')
      if (/[\\/]/.test(ref) || /\.[A-Za-z0-9]+$/.test(ref)) refs.push(ref)
    }
  return refs
}

function refPath(home: string, fromDir: string, ref: string): string {
  if (ref === '~' || ref.startsWith('~/') || ref.startsWith('~\\')) return join(home, ref.slice(2))
  return isAbsolute(ref) ? resolve(ref) : resolve(fromDir, ref)
}

function ruleReferences(home: string, file: string, text: string): GlobalReference[] {
  return includeRefs(text).map((ref) => ({
    ref,
    resolved: existsSync(refPath(home, dirname(file), ref)),
    external: true
  }))
}

/** References in a skill's markdown files that leave the skill folder (links and includes) */
function skillReferences(home: string, root: string, mdFiles: string[]): GlobalReference[] {
  const out: GlobalReference[] = []
  const seen = new Set<string>()
  for (const f of mdFiles) {
    const text = readFileSync(f, 'utf8')
    const refs = [
      ...proseLines(text).flatMap((l) => [...l.matchAll(LINK_RE)].map((m) => m[1])),
      ...includeRefs(text)
    ]
    for (const raw of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) continue // URL
      if (raw.startsWith('#')) continue
      const ref = raw.replace(/[#?].*$/, '')
      const abs = refPath(home, dirname(f), ref)
      if (within(root, abs) || seen.has(ref)) continue
      seen.add(ref)
      out.push({ ref, resolved: existsSync(abs), external: true })
    }
  }
  return out
}

function listRuleFile(
  home: string,
  tool: GlobalTool,
  name: string,
  path: string,
  out: GlobalImportListing
): void {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (!st) return
  if (st.isSymbolicLink()) {
    out.errors.push({ path, code: 'linkedSource' })
    return
  }
  if (!st.isFile()) return
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch (e) {
    out.errors.push({ path, code: errCode(e) })
    return
  }
  out.items.push({
    tool,
    kind: 'rule',
    name,
    sourcePath: path,
    sourceDigest: createHash('sha256').update(buf).digest('hex'),
    references: ruleReferences(home, path, buf.toString('utf8'))
  })
}

/** A linked rules/skills folder is reported and never read through */
function linkedContainer(dir: string, out: GlobalImportListing): boolean {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  out.errors.push({ path: dir, code: 'linkedSource' })
  return true
}

/** The path itself or a folder between the tool root and it is a link or junction */
export function linkedBelowRoot(root: string, path: string): boolean {
  let p = resolve(path)
  const r = resolve(root)
  while (p !== r && within(r, p)) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return true
    p = dirname(p)
  }
  return false
}

function listRuleDir(
  home: string,
  tool: GlobalTool,
  dir: string,
  rel: string,
  out: GlobalImportListing
): void {
  if (linkedContainer(dir, out)) return
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch (e) {
    if (errCode(e) !== 'ENOENT') out.errors.push({ path: dir, code: errCode(e) })
    return
  }
  for (const n of names) {
    if (n.startsWith('.')) continue
    const p = join(dir, n)
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (!st) continue
    const r = rel ? `${rel}/${n}` : n
    if (st.isSymbolicLink()) out.errors.push({ path: p, code: 'linkedSource' })
    else if (st.isDirectory()) listRuleDir(home, tool, p, r, out)
    else if (st.isFile() && n.toLowerCase().endsWith('.md')) listRuleFile(home, tool, r, p, out)
  }
}

/** Walks a skill tree with lstat only: links are problems, never followed */
function walkSkill(root: string, dir: string, problems: GlobalImportError[], md: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch (e) {
    problems.push({ path: dir, code: errCode(e) })
    return
  }
  for (const n of names) {
    const p = join(dir, n)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) {
      const target = resolve(dirname(p), readlinkSync(p))
      problems.push({ path: p, code: within(root, target) ? 'link' : 'externalLink' })
    } else if (st.isDirectory()) walkSkill(root, p, problems, md)
    else if (st.isFile()) {
      if (n.toLowerCase().endsWith('.md')) md.push(p)
    } else problems.push({ path: p, code: 'unsupportedEntry' })
  }
}

function listSkillDir(
  home: string,
  tool: GlobalTool,
  parent: string,
  out: GlobalImportListing
): void {
  if (linkedContainer(parent, out)) return
  let names: string[]
  try {
    names = readdirSync(parent).sort()
  } catch (e) {
    if (errCode(e) !== 'ENOENT') out.errors.push({ path: parent, code: errCode(e) })
    return
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dir = join(parent, name)
    const st = lstatSync(dir, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isSymbolicLink()) {
      out.errors.push({ path: dir, code: 'linkedSource' })
      continue
    }
    if (!st.isDirectory()) continue
    const skillMd = lstatSync(join(dir, 'SKILL.md'), { throwIfNoEntry: false })
    if (!skillMd) continue
    const problems: GlobalImportError[] = []
    const md: string[] = []
    walkSkill(dir, dir, problems, md)
    if (problems.length) {
      out.errors.push(...problems)
      continue
    }
    let digest: string
    let references: GlobalReference[]
    try {
      digest = dirContentHash(dir)
      references = skillReferences(home, dir, md)
    } catch (e) {
      out.errors.push({ path: (e as NodeJS.ErrnoException).path ?? dir, code: errCode(e) })
      continue
    }
    out.items.push({ tool, kind: 'skill', name, sourcePath: dir, sourceDigest: digest, references })
  }
}

/** Importable global rules and skills of the resolved roots (ambiguous or unavailable tools are skipped). Read-only */
export function listGlobalImportables(
  home: string,
  paths: GlobalPathResult[]
): GlobalImportListing {
  const out: GlobalImportListing = { items: [], errors: [] }
  for (const p of paths) {
    if (p.status !== 'resolved') continue
    const root = p.paths[0]
    const layout = NATIVE_LAYOUT[p.tool]
    for (const f of layout.ruleFiles) listRuleFile(home, p.tool, f, join(root, f), out)
    for (const d of layout.ruleDirs) listRuleDir(home, p.tool, join(root, d), '', out)
    for (const d of layout.skillDirs) listSkillDir(home, p.tool, join(root, d), out)
  }
  return out
}

/** Variant records in the library. Folders without a valid variant.json (interrupted imports) are reported */
export function readStoredVariants(home: string): {
  variants: (StoredVariant & { dir: string })[]
  errors: GlobalImportError[]
} {
  const lib = globalLibraryDir(home)
  const variants: (StoredVariant & { dir: string })[] = []
  const errors: GlobalImportError[] = []
  let ids: string[]
  try {
    ids = readdirSync(lib).sort()
  } catch (e) {
    if (errCode(e) !== 'ENOENT') errors.push({ path: lib, code: errCode(e) })
    return { variants, errors }
  }
  for (const id of ids) {
    const dir = join(lib, id)
    try {
      const v = JSON.parse(readFileSync(join(dir, VARIANT_FILE), 'utf8')) as StoredVariant
      if (v.version !== 1 || v.id !== id || !Array.isArray(v.origins)) throw new Error('invalid')
      variants.push({ ...v, dir })
    } catch (e) {
      errors.push({
        path: dir,
        code: errCode(e) === 'ENOENT' ? 'incompleteVariant' : 'invalidVariant'
      })
    }
  }
  return { variants, errors }
}

function copyTree(src: string, dst: string): void {
  for (const n of readdirSync(src)) {
    const s = join(src, n)
    const d = join(dst, n)
    const st = lstatSync(s)
    if (st.isSymbolicLink())
      throw Object.assign(new Error('link appeared'), { code: 'changedSinceListing', path: s })
    if (st.isDirectory()) {
      mkdirSync(d)
      copyTree(s, d)
    } else if (st.isFile()) copyFileSync(s, d, constants.COPYFILE_EXCL)
    else throw Object.assign(new Error('unsupported entry'), { code: 'unsupportedEntry', path: s })
  }
}

function copyIn(home: string, it: GlobalImportable): ImportedGlobalItem {
  const id = `${it.kind}-${randomBytes(8).toString('hex')}`
  const dir = join(globalLibraryDir(home), id)
  const content = join(dir, 'content')
  try {
    mkdirSync(content, { recursive: true })
    const rel = it.kind === 'rule' ? `content/${basename(it.sourcePath)}` : 'content'
    const stored = join(dir, rel)
    if (it.kind === 'rule') copyFileSync(it.sourcePath, stored, constants.COPYFILE_EXCL)
    else copyTree(it.sourcePath, stored)
    const digest = contentDigest(it.kind, stored)
    if (digest !== it.sourceDigest)
      throw Object.assign(new Error('source changed during copy'), {
        code: 'changedSinceListing',
        path: it.sourcePath
      })
    const origin: VariantOrigin = {
      tool: it.tool,
      path: it.sourcePath,
      importedAt: new Date().toISOString(),
      digest
    }
    const record: StoredVariant = {
      version: 1,
      id,
      kind: it.kind,
      name: it.name,
      content: rel,
      origins: [origin],
      references: it.references
    }
    atomicWrite(join(dir, VARIANT_FILE), JSON.stringify(record, null, 2) + '\n')
    return { id, kind: it.kind, name: it.name, storedPath: stored, origin }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/**
 * Imports the selected items as new library variants. Each selection must match the current listing of the resolved
 * roots (same tool, kind, name, path) and its listed digest; anything else is refused without reading it.
 */
export function importGlobalItems(
  home: string,
  selected: GlobalImportSelection[],
  paths: GlobalPathResult[] = resolveGlobalPaths(home)
): GlobalImportResult {
  const listing = listGlobalImportables(home, paths)
  const known = new Set(
    readStoredVariants(home).variants.flatMap((v) =>
      v.origins.map((o) => `${o.tool}\0${o.path}\0${o.digest}`)
    )
  )
  const result: GlobalImportResult = { items: [], errors: [] }
  const roots = new Map(
    paths.filter((p) => p.status === 'resolved').map((p) => [p.tool, p.paths[0]])
  )
  const linked = (tool: GlobalTool, path: string): boolean => {
    const root = roots.get(tool)
    return !!root && linkedBelowRoot(root, path)
  }
  for (const s of selected) {
    // A folder of the source may have become a link since it was listed: never copy through it
    if (linked(s.tool, s.sourcePath)) {
      result.errors.push({ path: s.sourcePath, code: 'linkedSource' })
      continue
    }
    const it = listing.items.find(
      (i) =>
        i.tool === s.tool && i.kind === s.kind && i.name === s.name && i.sourcePath === s.sourcePath
    )
    if (!it) {
      result.errors.push({ path: s.sourcePath, code: 'notListed' })
      continue
    }
    if (it.sourceDigest !== s.sourceDigest) {
      result.errors.push({ path: s.sourcePath, code: 'changedSinceListing' })
      continue
    }
    const key = `${it.tool}\0${it.sourcePath}\0${it.sourceDigest}`
    if (known.has(key)) {
      result.errors.push({ path: s.sourcePath, code: 'alreadyImported' })
      continue
    }
    try {
      if (linked(it.tool, it.sourcePath)) {
        result.errors.push({ path: it.sourcePath, code: 'linkedSource' })
        continue
      }
      result.items.push(copyIn(home, it))
      known.add(key)
    } catch (e) {
      result.errors.push({
        path: (e as NodeJS.ErrnoException).path ?? s.sourcePath,
        code: errCode(e)
      })
    }
  }
  return result
}

/**
 * A destination's current content (file, section body or skill folder) as a new library variant, bound to the digest
 * the user saw. The destination itself is not touched; links are not followed.
 */
export function importLocalChange(
  home: string,
  tool: GlobalTool,
  destination: string,
  kind: GlobalKind,
  expectedDigest: string,
  name?: string
):
  | { ok: true; item: ImportedGlobalItem }
  | { ok: false; code: 'changedSinceCheck' | 'unsupported' | string } {
  const state = readDestination(destination, kind)
  if (state.digest === null || state.digest !== expectedDigest)
    return { ok: false, code: 'changedSinceCheck' }
  if (!['file', 'dir', 'section'].includes(state.shape)) return { ok: false, code: 'unsupported' }
  const d = parseDestination(destination)
  const label =
    name ?? deliveryName(home, destination) ?? (d.kind === 'section' ? d.section : basename(d.path))
  const id = `${kind}-${randomBytes(8).toString('hex')}`
  const dir = join(globalLibraryDir(home), id)
  const content = join(dir, 'content')
  let kept = false
  try {
    mkdirSync(content, { recursive: true })
    let rel = 'content'
    let references: GlobalReference[] = []
    if (kind === 'rule') {
      let bytes: Buffer
      if (d.kind === 'section') {
        const buf = readFileSync(d.file)
        const s = findSection(buf, d.section)
        if (s === 'absent' || s === 'malformed') return { ok: false, code: 'changedSinceCheck' }
        bytes = buf.subarray(s.bodyStart, s.bodyEnd)
      } else bytes = readFileSync(d.path)
      rel = `content/${basename(label.split('/').pop() ?? label)}`
      writeFileSync(join(dir, rel), bytes, { flag: 'wx' })
      references = ruleReferences(
        home,
        d.kind === 'section' ? d.file : d.path,
        bytes.toString('utf8')
      )
    } else {
      const problems: GlobalImportError[] = []
      walkSkill(
        d.kind === 'path' ? d.path : d.file,
        d.kind === 'path' ? d.path : d.file,
        problems,
        []
      )
      if (problems.length) return { ok: false, code: problems[0].code }
      copyTree(d.kind === 'path' ? d.path : d.file, content)
    }
    const digest = contentDigest(kind, join(dir, rel))
    if (digest !== expectedDigest) return { ok: false, code: 'changedSinceCheck' }
    const origin: VariantOrigin = {
      tool,
      path: destination,
      importedAt: new Date().toISOString(),
      digest
    }
    const record: StoredVariant = {
      version: 1,
      id,
      kind,
      name: label,
      content: rel,
      origins: [origin],
      references
    }
    atomicWrite(join(dir, VARIANT_FILE), JSON.stringify(record, null, 2) + '\n')
    kept = true
    return { ok: true, item: { id, kind, name: label, storedPath: join(dir, rel), origin } }
  } catch (e) {
    return { ok: false, code: errCode(e) }
  } finally {
    // Every exit without a recorded variant (refusal or error) removes the provisional folder
    if (!kept) rmSync(dir, { recursive: true, force: true })
  }
}

/** Display name of the variant last delivered to a destination, if any */
function deliveryName(home: string, destination: string): string | undefined {
  const rec = deliveryAt(readDeliveries(home), destination)
  return rec
    ? readStoredVariants(home).variants.find((v) => v.id === rec.variantId)?.name
    : undefined
}
