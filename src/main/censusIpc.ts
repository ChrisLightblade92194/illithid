/**
 * IPC handlers of the Windows project census (spec 2026-10-06 §Integration boundaries, §Read boundaries). One
 * discovery and one run live here, in memory, for the session. A new discovery or start supersedes them: the old run
 * is signalled, its late completion is discarded and its id becomes stale. Requests are single objects with exactly
 * their keys. The renderer names discovery, candidate, run and item ids — the root to discover is its only path;
 * bindings and source paths stay here. Ids correlate backend objects, they are not an authentication boundary.
 * Other platforms refuse every census channel without filesystem access.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { diffManifests } from '../engine/census/compare'
import { discoverProjects, recheckBinding, validateSelection } from '../engine/census/paths'
import { CENSUS_LIMITS, createReader, scanProjects } from '../engine/census/scan'
import {
  CensusError,
  type CensusDetails,
  type CensusItem,
  type CensusSideRef,
  type RulePreview
} from '../engine/census/types'
import type { CensusImportAccess } from '../engine/project/types'
import type { CENSUS_CHANNELS, GlobalResult } from '../shared/api'
import { CensusSession, type CensusRun } from './censusSession'

type CensusChannel = (typeof CENSUS_CHANNELS)[number]

/** Bytes of a rule shown per side in details; the comparison itself covers the whole file */
export const RULE_PREVIEW_BYTES = 200 * 1024

const invalid = (message: string): CensusError => new CensusError('invalid', message)
const stale = (): CensusError =>
  new CensusError('stale', 'This census request was replaced by a newer one.')
const changedSince = (): CensusError =>
  new CensusError(
    'changedSinceCensus',
    'The file changed since the census: run the census again to compare it.'
  )

/** The single request object of a channel, with exactly these keys */
function request(args: unknown[], keys: readonly string[]): Record<string, unknown> {
  const [o] = args
  if (args.length !== 1 || typeof o !== 'object' || o === null || Array.isArray(o))
    throw invalid('A single request object is expected.')
  const own = Object.keys(o)
  const wrong = [
    ...own.filter((k) => !keys.includes(k)),
    ...keys.filter((k) => !own.includes(k)).map((k) => `missing ${k}`)
  ]
  if (wrong.length) throw invalid(`Unexpected request keys: ${wrong.join(', ')}`)
  return o as Record<string, unknown>
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw invalid(`${what} must be a non-empty string.`)
  return v
}
function idList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw invalid('Select at least one project.')
  const out = v.map((x) => text(x, 'candidate id'))
  if (new Set(out).size !== out.length) throw invalid('A project is selected twice.')
  return out
}

async function wrap<T>(fn: () => Promise<T>): Promise<GlobalResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (e instanceof CensusError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: 'error', message: (e as Error)?.message ?? String(e) }
  }
}

function lineEndings(t: string): RulePreview['lineEndings'] {
  const found = [
    /\r\n/.test(t) && 'crlf',
    /\r(?!\n)/.test(t) && 'cr',
    /(?<!\r)\n/.test(t) && 'lf'
  ].filter((x): x is 'crlf' | 'cr' | 'lf' => !!x)
  return found.length === 0 ? 'none' : found.length > 1 ? 'mixed' : found[0]
}

/** Drops a character the preview cut would split (UTF-8 sequence, UTF-16 unit or surrogate pair) */
function cutAtCharacter(b: Buffer, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): Buffer {
  if (encoding === 'utf-8') {
    let i = b.length - 1
    while (i > 0 && b.length - i < 4 && (b[i] & 0xc0) === 0x80) i--
    const lead = b[i]
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    return i >= 0 && i + need > b.length ? b.subarray(0, i) : b
  }
  let end = b.length - (b.length % 2)
  const unit =
    end >= 2 ? (encoding === 'utf-16le' ? b.readUInt16LE(end - 2) : b.readUInt16BE(end - 2)) : 0
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 2
  return b.subarray(0, end)
}

/** Text of a preview, only when its bytes are valid in the encoding a BOM (or none: UTF-8) announces */
function decode(head: Buffer, truncated: boolean): Pick<RulePreview, 'encoding' | 'text'> {
  const [label, encoding, bom]: [
    RulePreview['encoding'],
    'utf-8' | 'utf-16le' | 'utf-16be',
    number
  ] =
    head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
      ? ['utf-8-bom', 'utf-8', 3]
      : head[0] === 0xff && head[1] === 0xfe
        ? ['utf-16le-bom', 'utf-16le', 2]
        : head[0] === 0xfe && head[1] === 0xff
          ? ['utf-16be-bom', 'utf-16be', 2]
          : ['utf-8', 'utf-8', 0]
  let body = head.subarray(bom)
  if (truncated) body = cutAtCharacter(body, encoding)
  try {
    return {
      encoding: label,
      text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body)
    }
  } catch {
    return { encoding: 'unknown', text: null }
  }
}

type Run = CensusRun

function sideOf(r: Run, item: CensusItem): CensusSideRef {
  const projectPath = r.discovery.bindings.get(item.projectId)!.path
  return {
    itemId: item.id,
    projectPath,
    relativePath: item.relativePath,
    fullPath: join(projectPath, ...item.relativePath.split('/'))
  }
}

/** The rule as it is now, refused unless its whole content still has the census digest; bounded preview */
async function previewRule(r: Run, item: CensusItem): Promise<RulePreview> {
  const side = sideOf(r, item)
  // Bound to the run: Cancel, a new discovery or a new start aborts it, so no queued read starts afterwards
  const reader = createReader(r.controller.signal, CENSUS_LIMITS)
  const parts: Buffer[] = []
  let kept = 0
  let read: { digest: string; bytes: number }
  try {
    const st = await reader.locate(side.projectPath, item.relativePath)
    if (!st?.isFile()) throw changedSince()
    read = await reader.hashFile(side.fullPath, st, (chunk) => {
      if (kept >= RULE_PREVIEW_BYTES) return
      const take = Buffer.from(chunk.subarray(0, RULE_PREVIEW_BYTES - kept))
      parts.push(take)
      kept += take.length
    })
  } catch {
    throw r.controller.signal.aborted ? stale() : changedSince()
  }
  if (read.digest !== item.digest) throw changedSince()
  const head = Buffer.concat(parts)
  const truncated = read.bytes > RULE_PREVIEW_BYTES
  const { encoding, text: shown } = decode(head, truncated)
  return {
    ...side,
    bytes: read.bytes,
    encoding,
    lineEndings: lineEndings(shown ?? head.toString('latin1')),
    text: shown,
    truncated
  }
}

type CensusHandlers = Record<CensusChannel, (...args: unknown[]) => Promise<unknown>>

/**
 * The census channels and the import access of one session (ipc.ts builds one service and gives its access to the
 * project handlers). The five census requests stay read-only.
 */
export function createCensusService(
  platform: NodeJS.Platform = process.platform,
  scan: typeof scanProjects = scanProjects
): { handlers: CensusHandlers; access: CensusImportAccess } {
  const session = new CensusSession(platform)
  return { handlers: handlersOf(session, platform, scan), access: session }
}

/** Compatibility wrapper: the census channels of a new session */
export function censusHandlers(
  platform: NodeJS.Platform = process.platform,
  scan: typeof scanProjects = scanProjects
): CensusHandlers {
  return createCensusService(platform, scan).handlers
}

function handlersOf(
  session: CensusSession,
  platform: NodeJS.Platform,
  scan: typeof scanProjects
): CensusHandlers {
  if (platform !== 'win32') {
    const refuse = async (): Promise<GlobalResult<never>> => ({
      ok: false,
      code: 'unsupportedPlatform',
      message: 'The project census is available on Windows only.'
    })
    return {
      censusDiscover: refuse,
      censusStart: refuse,
      censusPoll: refuse,
      censusCancel: refuse,
      censusInspect: refuse
    }
  }
  const supersede = (): void => session.supersede()
  const current = (runId: string): Run => {
    if (!session.run || session.run.id !== runId) throw stale()
    return session.run
  }

  return {
    censusDiscover: (...args) =>
      wrap(async () => {
        const root = text(request(args, ['root']).root, 'root')
        const gen = ++session.generation
        supersede()
        session.discovery = null
        const d = await discoverProjects(root)
        if (gen !== session.generation) throw stale()
        session.discovery = d
        return d.view
      }),
    censusStart: (...args) =>
      wrap(async () => {
        const o = request(args, ['discoveryId', 'candidateIds'])
        const discoveryId = text(o.discoveryId, 'discoveryId')
        const candidateIds = idList(o.candidateIds)
        const d = session.discovery
        if (!d || d.view.id !== discoveryId) throw stale()
        if (candidateIds.some((id) => !d.bindings.has(id)))
          throw invalid('Not an available project of this listing.')
        const gen = ++session.generation
        supersede()
        await validateSelection(d, candidateIds)
        if (gen !== session.generation || session.discovery !== d) throw stale()
        const r: Run = {
          id: randomUUID(),
          discovery: d,
          controller: new AbortController(),
          view: {
            runId: '',
            status: 'running',
            progress: {
              projectsCompleted: 0,
              projectsTotal: candidateIds.length,
              itemsCompleted: 0
            }
          }
        }
        r.view.runId = r.id
        session.run = r
        const live = (): boolean => session.run === r && r.view.status === 'running'
        // Rejection handling is attached before the job can settle: a failure becomes a failed run
        scan(d, candidateIds, {
          signal: r.controller.signal,
          onProgress: (p) => {
            if (live()) r.view = { ...r.view, progress: p }
          }
        }).then(
          (snapshot) => {
            if (live()) r.view = { ...r.view, status: 'completed', snapshot }
          },
          (e: unknown) => {
            if (live())
              r.view = { ...r.view, status: 'failed', reason: (e as Error)?.message ?? String(e) }
          }
        )
        return { runId: r.id }
      }),
    censusPoll: (...args) =>
      wrap(async () => {
        const v = current(text(request(args, ['runId']).runId, 'runId')).view
        return { ...v, progress: { ...v.progress } }
      }),
    censusCancel: (...args) =>
      wrap(async () => {
        const r = current(text(request(args, ['runId']).runId, 'runId'))
        r.controller.abort()
        r.view = { runId: r.id, status: 'cancelled', progress: r.view.progress }
        return { runId: r.id, status: 'cancelled' as const }
      }),
    censusInspect: (...args) =>
      wrap(async (): Promise<CensusDetails> => {
        const o = request(args, ['runId', 'leftId', 'rightId'])
        const runId = text(o.runId, 'runId')
        const leftId = text(o.leftId, 'leftId')
        const rightId = text(o.rightId, 'rightId')
        const r = current(runId)
        const snapshot = r.view.status === 'completed' ? r.view.snapshot : undefined
        if (!snapshot) throw stale()
        if (leftId === rightId) throw invalid('Choose two different items.')
        const find = (id: string): CensusItem => {
          const i = snapshot.items.find((x) => x.id === id)
          if (!i || i.outcome !== 'complete') throw invalid('Not a complete item of this census.')
          return i
        }
        const left = find(leftId)
        const right = find(rightId)
        if (left.kind !== right.kind)
          throw invalid('Rules are compared with rules, skills with skills.')
        if (left.kind === 'skill')
          return {
            kind: 'skill',
            left: sideOf(r, left),
            right: sideOf(r, right),
            ...diffManifests(left.manifest ?? [], right.manifest ?? [])
          }
        // After every asynchronous step the run must still be the current, completed (not cancelled) one
        const stillCurrent = (): void => {
          if (session.run !== r || r.view.status !== 'completed' || r.controller.signal.aborted)
            throw stale()
        }
        for (const i of [left, right]) {
          await recheckBinding(r.discovery.bindings.get(i.projectId)!)
          stillCurrent()
        }
        const l = await previewRule(r, left)
        stillCurrent()
        const rr = await previewRule(r, right)
        stillCurrent()
        return { kind: 'rule', left: l, right: rr, identical: left.digest === right.digest }
      })
  }
}
