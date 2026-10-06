/**
 * Selective import of global rules and skills into the variant library (spec 2026-10-04 §5, §6).
 * - Originals are only read: no move, no retire (no upstream pendingRetire), no ownership transfer.
 * - Links and junctions are never followed: a linked item or a link inside a skill is reported and not importable.
 *   One exception, the guided import: a skill folder that is itself a link is listed with its target (metadata only),
 *   and its target is read only after the user confirmed that link and that target (bound by a fingerprint the backend
 *   checks again before reading, before copying and after copying). Links inside it and linked containers stay refused.
 * - A read error is reported and yields no item; a skill is importable only when every file of its tree was read.
 * - Each import is a new copy with its own id; the variant record (variant.json) is written last, after the copy was
 *   verified against the listed digest, so an interrupted import never looks complete.
 * Digests: rule = sha256 of the bytes; skill = globalTreeDigest (relative paths + bytes of the complete tree).
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats
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
import { globalTreeDigest } from './globalDigest'
import type { ProjectOrigin } from './project/types'
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
  /** Links: where the link points (as resolved, or as stored when it cannot be resolved) */
  target?: string
}

/** A skill folder that is itself a link or junction: offered for a guided import, its target never read before */
export interface LinkedSkillCandidate {
  tool: GlobalTool
  /** Folder name under the skills container (the skill's name in the tool) */
  name: string
  /** The link or junction itself */
  linkPath: string
  /** The local folder it resolves to */
  targetPath: string
  /** Identity of the link, its stored target and the target folder when listed: binds a confirmation to them */
  linkFingerprint: string
}

/** What the user confirmed: the link and the target shown, with the fingerprint of the listing */
export type LinkedSkillConfirmation = Pick<
  LinkedSkillCandidate,
  'tool' | 'linkPath' | 'targetPath' | 'linkFingerprint'
>

/** A confirmed target, read and validated as a skill */
export interface LinkedSkillPreview extends LinkedSkillCandidate {
  sourceDigest: string
  references: GlobalReference[]
}

export interface LinkedSkillPreviewResult {
  items: LinkedSkillPreview[]
  errors: GlobalImportError[]
}

/** An import request: the confirmation and the digest of the preview the user saw */
export interface LinkedSkillSelection extends LinkedSkillConfirmation {
  sourceDigest: string
}

export interface GlobalImportListing {
  items: GlobalImportable[]
  /** Linked skill folders: importable only through a confirmation (never part of `items`) */
  linked: LinkedSkillCandidate[]
  errors: GlobalImportError[]
}

/** Provenance of a variant imported from a global tool root (legacy records carry no scope: they are global) */
export interface GlobalOrigin {
  scope?: 'global'
  tool: GlobalTool
  /** Where the tool has it (for a linked skill: the link) */
  path: string
  /** Linked skills only: the real folder that was read */
  linkTarget?: string
  importedAt: string
  digest: string
}

/** Provenance of a variant (the format of VariantRecord.origins): a global tool root or a project */
export type VariantOrigin = GlobalOrigin | ProjectOrigin

export interface ImportedGlobalItem {
  id: string
  kind: GlobalKind
  name: string
  /** Rule: the copied file; skill: the copied folder */
  storedPath: string
  origin: GlobalOrigin
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
  return kind === 'rule' ? fileDigest(path) : globalTreeDigest(path)
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

export function ruleReferences(
  home: string,
  file: string,
  text: string,
  exists: (p: string) => boolean = existsSync
): GlobalReference[] {
  return includeRefs(text).map((ref) => ({
    ref,
    resolved: exists(refPath(home, dirname(file), ref)),
    external: true
  }))
}

/**
 * References in a skill's markdown files that leave the skill folder (links and includes). `read` supplies a file's
 * text (a project import reads its verified library copy); `exists` decides whether a referenced path exists.
 */
export function skillReferences(
  home: string,
  root: string,
  mdFiles: string[],
  exists: (p: string) => boolean = existsSync,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8')
): GlobalReference[] {
  const out: GlobalReference[] = []
  const seen = new Set<string>()
  for (const f of mdFiles) {
    const text = read(f)
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
      out.push({ ref, resolved: exists(abs), external: true })
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

const isCandidate = (c: LinkedSkillCandidate | GlobalImportError): c is LinkedSkillCandidate =>
  'linkFingerprint' in c

function fingerprint(
  tool: GlobalTool,
  linkPath: string,
  link: BigIntStats,
  stored: string,
  targetPath: string,
  target: BigIntStats
): string {
  const parts = [tool, linkPath, link.dev, link.ino, stored, targetPath, target.dev, target.ino]
  return createHash('sha256')
    .update(JSON.stringify(parts.map(String)))
    .digest('hex')
}

/**
 * Metadata of a skill folder that is a link: where it points, never what the target contains. A network or device
 * target is refused from the stored link text, before any resolution (this release handles local Windows folders only).
 * The fingerprint covers the identity of the link and of the target folder, so a link recreated, re-pointed (even to
 * identical content) or a target folder replaced in place no longer matches a confirmation.
 */
function inspectLink(tool: GlobalTool, linkPath: string): LinkedSkillCandidate | GlobalImportError {
  const fail = (code: string, target?: string): GlobalImportError =>
    target ? { path: linkPath, code, target } : { path: linkPath, code }
  let link: BigIntStats
  let stored: string
  try {
    link = lstatSync(linkPath, { bigint: true })
    if (!link.isSymbolicLink()) return fail('notListed')
    stored = readlinkSync(linkPath)
  } catch (e) {
    // A junction to a network share cannot even be read back as a path
    return fail(errCode(e) === 'EINVAL' ? 'unsupportedLinkTarget' : errCode(e))
  }
  if (/^[\\/]{2}/.test(stored)) return fail('unsupportedLinkTarget', stored)
  let targetPath: string
  try {
    targetPath = realpathSync.native(linkPath)
  } catch (e) {
    const code = errCode(e)
    const shown = resolve(dirname(linkPath), stored)
    if (code === 'ENOENT') return fail('brokenLink', shown)
    return fail(code === 'ELOOP' ? 'linkCycle' : code, shown)
  }
  if (!/^[A-Za-z]:\\/.test(targetPath)) return fail('unsupportedLinkTarget', targetPath)
  // The target holds the link itself: reading it would come back through the link
  let parent = dirname(linkPath)
  try {
    parent = realpathSync.native(parent)
  } catch {
    // keep the path as listed
  }
  if (within(targetPath, join(parent, basename(linkPath)))) return fail('linkCycle', targetPath)
  let target: BigIntStats
  try {
    target = statSync(targetPath, { bigint: true })
  } catch (e) {
    return fail(errCode(e), targetPath)
  }
  if (!target.isDirectory()) return fail('linkTargetNotFolder', targetPath)
  return {
    tool,
    name: basename(linkPath),
    linkPath,
    targetPath,
    linkFingerprint: fingerprint(tool, linkPath, link, stored, targetPath, target)
  }
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
      const c = inspectLink(tool, dir)
      if (isCandidate(c)) out.linked.push(c)
      else out.errors.push(c)
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
      digest = globalTreeDigest(dir)
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
  const out: GlobalImportListing = { items: [], linked: [], errors: [] }
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

function copyTree(src: string, dst: string, changed = 'changedSinceListing'): void {
  for (const n of readdirSync(src)) {
    const s = join(src, n)
    const d = join(dst, n)
    const st = lstatSync(s)
    if (st.isSymbolicLink())
      throw Object.assign(new Error('link appeared'), { code: changed, path: s })
    if (st.isDirectory()) {
      mkdirSync(d)
      copyTree(s, d, changed)
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
    const origin: GlobalOrigin = {
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
  const known = knownOrigins(home)
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
    const key = legacyOriginKey(it.tool, it.sourcePath, it.sourceDigest)
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

const legacyOriginKey = (tool: GlobalTool, path: string, digest: string): string =>
  originKey({ tool, path, digest, importedAt: '' })

/**
 * Identity of an origin: scope, path and digest format, so a project origin never equals a global one. A global key
 * keeps the tool, path and digest of the legacy key; its digest format is implied by the variant kind.
 */
export function originKey(o: VariantOrigin): string {
  return o.scope === 'project'
    ? JSON.stringify([
        'project',
        o.projectRoot,
        o.relativePath,
        o.path,
        o.digestAlgorithm,
        o.digest
      ])
    : JSON.stringify(['global', o.tool, o.path, 'legacy', o.digest])
}

/** Sources already in the library with the same content (scope, path, digest format and digest) */
export function knownOrigins(home: string): Set<string> {
  return new Set(readStoredVariants(home).variants.flatMap((v) => v.origins.map(originKey)))
}

/**
 * The candidate a confirmation names, derived again from the disk: a link directly under a skills container of a
 * confirmed root, the container itself not linked. Any other path (a plain folder, a link elsewhere, a path through
 * `..`) is refused without being inspected.
 */
function linkedCandidate(
  paths: GlobalPathResult[],
  tool: GlobalTool,
  linkPath: string
): LinkedSkillCandidate | GlobalImportError {
  const notListed = { path: linkPath, code: 'notListed' }
  const p = paths.find((x) => x.tool === tool && x.status === 'resolved')
  const name = basename(linkPath)
  if (!p || !name || name.startsWith('.')) return notListed
  const root = p.paths[0]
  const container = NATIVE_LAYOUT[tool].skillDirs
    .map((d) => join(root, d))
    .find((c) => join(c, name) === linkPath)
  if (!container) return notListed
  if (linkedBelowRoot(root, container)) return { path: container, code: 'linkedSource' }
  if (!lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) return notListed
  return inspectLink(tool, linkPath)
}

/** The candidate, provided the link and its target are still the ones confirmed */
function boundCandidate(
  paths: GlobalPathResult[],
  c: LinkedSkillConfirmation
): LinkedSkillCandidate | GlobalImportError {
  const now = linkedCandidate(paths, c.tool, c.linkPath)
  if (!isCandidate(now)) return now
  if (now.targetPath !== c.targetPath || now.linkFingerprint !== c.linkFingerprint)
    return { path: c.linkPath, code: 'linkChanged', target: now.targetPath }
  return now
}

/** A confirmed target read as a skill: every entry a plain file or folder, SKILL.md present, every file read */
function readLinkedTarget(
  home: string,
  target: string
): { digest: string; references: GlobalReference[] } | { errors: GlobalImportError[] } {
  // Before walking: a confirmed target that is no skill (a whole drive, a home folder) is not enumerated.
  // A linked SKILL.md is left to the walk, which reports it as a link
  const skillMd = lstatSync(join(target, 'SKILL.md'), { throwIfNoEntry: false })
  if (!skillMd || !(skillMd.isFile() || skillMd.isSymbolicLink()))
    return { errors: [{ path: target, code: 'notASkill' }] }
  const problems: GlobalImportError[] = []
  const md: string[] = []
  walkSkill(target, target, problems, md)
  if (problems.length) return { errors: problems }
  try {
    return { digest: globalTreeDigest(target), references: skillReferences(home, target, md) }
  } catch (e) {
    return { errors: [{ path: (e as NodeJS.ErrnoException).path ?? target, code: errCode(e) }] }
  }
}

/**
 * Reads the targets the user confirmed (each bound to the link and target shown) and validates them as skills. Writes
 * nothing and stores no authorization: the import needs the same confirmation again, with the digest shown here.
 */
export function previewLinkedSkills(
  home: string,
  confirmed: LinkedSkillConfirmation[],
  paths: GlobalPathResult[] = resolveGlobalPaths(home)
): LinkedSkillPreviewResult {
  const out: LinkedSkillPreviewResult = { items: [], errors: [] }
  for (const c of confirmed) {
    const cand = boundCandidate(paths, c)
    if (!isCandidate(cand)) {
      out.errors.push(cand)
      continue
    }
    const read = readLinkedTarget(home, cand.targetPath)
    if ('errors' in read) {
      out.errors.push(...read.errors)
      continue
    }
    // The link may have been swapped while its target was read
    const again = boundCandidate(paths, c)
    if (!isCandidate(again)) {
      out.errors.push(again)
      continue
    }
    out.items.push({ ...cand, sourceDigest: read.digest, references: read.references })
  }
  return out
}

/** Test hooks around the copy of a linked skill (races between the checks and the copy) */
export interface LinkedImportHooks {
  beforeCopy?: () => void
  afterCopy?: () => void
}

/**
 * Imports confirmed and previewed linked skills as new variants. Link, target and content are checked again before the
 * copy (refused as linkChanged / changedSincePreview), the copy is taken from the target folder and verified against
 * the previewed digest, and the link is checked once more before the variant record is written. Every refusal or error
 * removes the provisional folder. The origin keeps the link (logical provenance) and the real target that was read.
 */
export function importLinkedSkills(
  home: string,
  selected: LinkedSkillSelection[],
  paths: GlobalPathResult[] = resolveGlobalPaths(home),
  hooks: LinkedImportHooks = {}
): GlobalImportResult {
  const known = knownOrigins(home)
  const result: GlobalImportResult = { items: [], errors: [] }
  for (const s of selected) {
    const cand = boundCandidate(paths, s)
    if (!isCandidate(cand)) {
      result.errors.push(cand)
      continue
    }
    const key = legacyOriginKey(s.tool, s.linkPath, s.sourceDigest)
    if (known.has(key)) {
      result.errors.push({ path: s.linkPath, code: 'alreadyImported' })
      continue
    }
    const r = copyLinkedIn(home, paths, s, cand, hooks)
    if ('errors' in r) result.errors.push(...r.errors)
    else {
      result.items.push(r)
      known.add(key)
    }
  }
  return result
}

function copyLinkedIn(
  home: string,
  paths: GlobalPathResult[],
  s: LinkedSkillSelection,
  cand: LinkedSkillCandidate,
  hooks: LinkedImportHooks
): ImportedGlobalItem | { errors: GlobalImportError[] } {
  const refuse = (code: string): { errors: GlobalImportError[] } => ({
    errors: [{ path: s.linkPath, code }]
  })
  // The content as previewed, read before any library folder exists
  const read = readLinkedTarget(home, s.targetPath)
  if ('errors' in read) return read
  if (read.digest !== s.sourceDigest) return refuse('changedSincePreview')
  const id = `skill-${randomBytes(8).toString('hex')}`
  const dir = join(globalLibraryDir(home), id)
  const stored = join(dir, 'content')
  let kept = false
  try {
    hooks.beforeCopy?.()
    // Link and target identity once more, right before anything is created or copied (metadata only)
    const before = boundCandidate(paths, s)
    if (!isCandidate(before)) return { errors: [before] }
    mkdirSync(stored, { recursive: true })
    copyTree(s.targetPath, stored, 'changedSincePreview')
    hooks.afterCopy?.()
    if (globalTreeDigest(stored) !== s.sourceDigest) return refuse('changedSincePreview')
    const after = boundCandidate(paths, s)
    if (!isCandidate(after)) return { errors: [after] }
    const origin: GlobalOrigin = {
      tool: s.tool,
      path: s.linkPath,
      linkTarget: s.targetPath,
      importedAt: new Date().toISOString(),
      digest: s.sourceDigest
    }
    const record: StoredVariant = {
      version: 1,
      id,
      kind: 'skill',
      name: cand.name,
      content: 'content',
      origins: [origin],
      references: read.references
    }
    atomicWrite(join(dir, VARIANT_FILE), JSON.stringify(record, null, 2) + '\n')
    kept = true
    return { id, kind: 'skill', name: cand.name, storedPath: stored, origin }
  } catch (e) {
    return { errors: [{ path: (e as NodeJS.ErrnoException).path ?? s.linkPath, code: errCode(e) }] }
  } finally {
    // Every exit without a recorded variant (refusal or error) removes the provisional folder
    if (!kept) rmSync(dir, { recursive: true, force: true })
  }
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
    const origin: GlobalOrigin = {
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
