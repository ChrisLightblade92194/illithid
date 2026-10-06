/**
 * Synthetic project trees and filesystem observers for the project census tests. Every tree lives under the OS temp
 * folder with spaces and non-ASCII characters in its path; nothing here reads or scans real projects.
 */
// The default export is the fs module object other modules call: observers patch it (and fs.promises), not a copy
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

export { put, snapshot } from './globalFixture'

/** New empty folder `<tmp>/illithid census ä XXXX` */
export function censusBase(prefix = 'illithid census ä '): string {
  const base = mkdtempSync(resolve(tmpdir(), prefix))
  mkdirSync(base, { recursive: true })
  return base
}

/** A folder link: a junction on Windows (no privilege needed), a directory symlink elsewhere */
export function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

export interface FsCall {
  /** promises.<name>, <name>Sync or <name> (callback API) */
  fn: string
  path: string
}

const NAMES = [
  'access',
  'lstat',
  'stat',
  'readdir',
  'opendir',
  'readFile',
  'open',
  'readlink',
  'realpath'
]

/** Calls that enumerate a folder or open/read a file, in any of the three fs APIs */
const CONTENT = new Set(
  ['readdir', 'opendir', 'readFile', 'open'].flatMap((n) => [`promises.${n}`, `${n}Sync`, n])
)
export const isContent = (c: FsCall): boolean => CONTENT.has(c.fn)
export const fmt = (c: FsCall): string => `${c.fn} ${c.path}`

const norm = (p: string): string =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
export const samePath = (a: string, b: string): boolean => norm(a) === norm(b)
/** p is strictly inside dir */
export function inside(p: string, dir: string): boolean {
  const r = relative(norm(dir), norm(p))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

export const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected by the test`), { code })

export interface ObserveOptions {
  /** An error for this call (it is then not performed), or undefined to let it through */
  fail?: (call: FsCall) => NodeJS.ErrnoException | undefined
  /** Awaited before a promise-API call proceeds (holds that read) */
  hold?: (call: FsCall) => Promise<void> | undefined
}

export interface Observed<T> {
  value?: T
  error?: unknown
  calls: FsCall[]
}

type AnyFn = ((...a: unknown[]) => unknown) & { native?: AnyFn }

/**
 * Runs fn while recording every path-taking call of fs.promises, the fs sync API and the fs callback API made by any
 * module, including realpath.native. Resolves with fn's value or error, never rejects.
 */
export async function observeFs<T>(
  fn: () => Promise<T> | T,
  opts: ObserveOptions = {}
): Promise<Observed<T>> {
  const calls: FsCall[] = []
  const fsm = fs as unknown as Record<string, AnyFn>
  const fsp = fs.promises as unknown as Record<string, AnyFn>
  const restore: (() => void)[] = []
  const savedNative = fs.realpathSync.native as unknown as AnyFn
  const record = (fnName: string, a: unknown[]): FsCall | null => {
    if (typeof a[0] !== 'string') return null
    const c = { fn: fnName, path: a[0] }
    calls.push(c)
    return c
  }
  const patch = (obj: Record<string, AnyFn>, key: string, make: (orig: AnyFn) => AnyFn): void => {
    const orig = obj[key]
    if (typeof orig !== 'function') return
    obj[key] = make(orig)
    restore.push(() => (obj[key] = orig))
  }
  for (const n of NAMES) {
    patch(fsp, n, (orig) => async (...a: unknown[]) => {
      const c = record(`promises.${n}`, a)
      if (c) {
        await opts.hold?.(c)
        const e = opts.fail?.(c)
        if (e) throw e
      }
      return orig(...a)
    })
    patch(fsm, `${n}Sync`, (orig) => (...a: unknown[]) => {
      const c = record(`${n}Sync`, a)
      const e = c && opts.fail?.(c)
      if (e) throw e
      return orig(...a)
    })
    patch(fsm, n, (orig) => (...a: unknown[]) => {
      const c = record(n, a)
      const e = c && opts.fail?.(c)
      const cb = a[a.length - 1]
      if (e && typeof cb === 'function') return void process.nextTick(() => cb(e))
      return orig(...a)
    })
  }
  patch(
    fsm,
    'existsSync',
    (orig) =>
      (...a: unknown[]) => (record('existsSync', a), orig(...a))
  )
  // The patched realpathSync is a new function: give it a recording native (restoring realpathSync restores both)
  const native = savedNative
  fsm['realpathSync'].native = (...a: unknown[]) => {
    const c = record('realpathSync.native', a)
    const e = c && opts.fail?.(c)
    if (e) throw e
    return native(...a)
  }
  try {
    return { value: await fn(), calls }
  } catch (error) {
    return { error, calls }
  } finally {
    for (const r of restore.reverse()) r()
  }
}

export const codeOf = (e: unknown): string | undefined => (e as { code?: string } | undefined)?.code
