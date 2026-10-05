/**
 * Destinations of global deliveries (spec 2026-10-04 §8).
 * - A path destination is a dedicated file (rule) or folder (skill) inside a tool root.
 * - A section destination is a delimited section of a native instructions file (`<file>::<section>`; `::` cannot occur in
 *   a Windows path). Sections are handled as bytes: the content outside the markers is never re-encoded.
 * Reading a destination never follows a link and never treats a differently-cased existing name as the same entry.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GlobalKind } from './globalImport'
import type { GlobalTool } from './globalPaths'
import { globalTreeDigest } from './globalDigest'

export const SECTION_SEP = '::'

export type DestinationShape =
  { kind: 'path'; path: string } | { kind: 'section'; file: string; section: string }

export function sectionDestination(file: string, section: string): string {
  return `${file}${SECTION_SEP}${section}`
}

export function parseDestination(destination: string): DestinationShape {
  const i = destination.indexOf(SECTION_SEP)
  return i === -1
    ? { kind: 'path', path: destination }
    : {
        kind: 'section',
        file: destination.slice(0, i),
        section: destination.slice(i + SECTION_SEP.length)
      }
}

/** Comparison key: Windows treats names differing only in case as the same entry */
export function destinationKey(destination: string): string {
  const d = parseDestination(destination)
  return d.kind === 'path'
    ? resolve(d.path).toLowerCase()
    : `${resolve(d.file).toLowerCase()}${SECTION_SEP}${d.section.toLowerCase()}`
}

/** File that holds a destination (the section's file, or the path itself) */
export function destinationFile(destination: string): string {
  const d = parseDestination(destination)
  return d.kind === 'path' ? d.path : d.file
}

/** Default destination of a variant for a tool: dedicated file/folder for Claude and skills, section otherwise */
export function defaultDestination(
  root: string,
  tool: GlobalTool,
  kind: GlobalKind,
  name: string
): string {
  if (kind === 'skill') return join(root, 'skills', name)
  if (tool === 'claude') return join(root, 'rules', 'illithid', ...name.split('/'))
  return sectionDestination(join(root, 'AGENTS.md'), name)
}

export const sectionBegin = (name: string): string => `<!-- BEGIN illithid-global: ${name} -->`
export const sectionEnd = (name: string): string => `<!-- END illithid-global: ${name} -->`

export interface SectionBounds {
  /** Offset of the BEGIN marker */
  begin: number
  bodyStart: number
  /** Offset of the END marker (the body ends right before it) */
  bodyEnd: number
  /** Offset after the END marker line (its line break included) */
  end: number
}

function indexesAtLineStart(buf: Buffer, needle: Buffer): number[] {
  const out: number[] = []
  let i = buf.indexOf(needle)
  while (i !== -1) {
    if (i === 0 || buf[i - 1] === 0x0a) out.push(i)
    i = buf.indexOf(needle, i + 1)
  }
  return out
}

function lineBreakAt(buf: Buffer, i: number): number {
  if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return 2
  if (buf[i] === 0x0a) return 1
  return 0
}

/** Bounds of a managed section; 'malformed' when the markers cannot delimit it with certainty */
export function findSection(buf: Buffer, name: string): SectionBounds | 'absent' | 'malformed' {
  const b = Buffer.from(sectionBegin(name), 'utf8')
  const e = Buffer.from(sectionEnd(name), 'utf8')
  const begins = indexesAtLineStart(buf, b)
  const ends = indexesAtLineStart(buf, e)
  if (!begins.length && !ends.length) return 'absent'
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return 'malformed'
  const lb = lineBreakAt(buf, begins[0] + b.length)
  if (!lb) return 'malformed'
  const bodyStart = begins[0] + b.length + lb
  if (ends[0] < bodyStart) return 'malformed'
  const afterEnd = ends[0] + e.length
  const tail = lineBreakAt(buf, afterEnd)
  if (!tail && afterEnd !== buf.length) return 'malformed'
  return { begin: begins[0], bodyStart, bodyEnd: ends[0], end: afterEnd + tail }
}

/** Section body for a content: the bytes, plus a line break when they lack a final one (the END marker starts a line) */
export function sectionBody(content: Buffer): Buffer {
  return content.length && content[content.length - 1] !== 0x0a
    ? Buffer.concat([content, Buffer.from('\n')])
    : content
}

export function bytesDigest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface DestinationState {
  /** Content digest; null when nothing is there. Links, malformed sections and errors get a tagged digest */
  digest: string | null
  shape:
    | 'absent'
    | 'file'
    | 'dir'
    | 'section'
    | 'link'
    | 'malformedSection'
    | 'caseMismatch'
    | 'other'
    | 'unreadable'
  /** caseMismatch: the existing name on disk */
  actualName?: string
  error?: string
}

function exactEntry(path: string): { name: string | null; error?: string } {
  const parent = dirname(path)
  const base = basename(path)
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'readFailed'
    return code === 'ENOENT' || code === 'ENOTDIR' ? { name: null } : { name: null, error: code }
  }
  const found =
    names.find((n) => n === base) ?? names.find((n) => n.toLowerCase() === base.toLowerCase())
  return { name: found ?? null }
}

/** Current state of a destination for a variant kind. Read-only, never follows links */
export function readDestination(destination: string, kind: GlobalKind): DestinationState {
  const d = parseDestination(destination)
  const path = d.kind === 'path' ? d.path : d.file
  const entry = exactEntry(path)
  if (entry.error)
    return { digest: `error:${entry.error}`, shape: 'unreadable', error: entry.error }
  if (!entry.name) return { digest: null, shape: 'absent' }
  if (entry.name !== basename(path))
    return { digest: `case:${entry.name}`, shape: 'caseMismatch', actualName: entry.name }
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return { digest: `link:${readlinkSync(path)}`, shape: 'link' }
    if (d.kind === 'section') {
      if (!st.isFile()) return { digest: 'other', shape: 'other' }
      const buf = readFileSync(path)
      const s = findSection(buf, d.section)
      if (s === 'absent') return { digest: null, shape: 'absent' }
      if (s === 'malformed')
        return { digest: `malformed:${bytesDigest(buf)}`, shape: 'malformedSection' }
      return { digest: bytesDigest(buf.subarray(s.bodyStart, s.bodyEnd)), shape: 'section' }
    }
    if (kind === 'skill' && st.isDirectory())
      return { digest: globalTreeDigest(path), shape: 'dir' }
    if (kind === 'rule' && st.isFile())
      return { digest: bytesDigest(readFileSync(path)), shape: 'file' }
    return { digest: 'other', shape: 'other' }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'readFailed'
    return { digest: `error:${code}`, shape: 'unreadable', error: code }
  }
}
