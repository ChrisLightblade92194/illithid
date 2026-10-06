/**
 * State of the project deliveries (spec 2026-10-06 project delivery §Content, provenance and ownership): records,
 * plans, operations and backups live under `<global state>/project/`, beside — never inside — the global state, whose
 * files and meaning stay unchanged. Nothing is written into a project's instructions or skill trees.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globalStateDir } from '../globalPaths'
import { atomicWrite } from '../write'
import { ProjectError, type ProjectDeliveryRecord } from './types'

export const projectStateDir = (home: string): string => join(globalStateDir(home), 'project')
export const projectPlansDir = (home: string): string => join(projectStateDir(home), 'plans')
export const projectOperationsDir = (home: string): string =>
  join(projectStateDir(home), 'operations')
export const projectBackupsDir = (home: string): string => join(projectStateDir(home), 'backups')
const deliveriesPath = (home: string): string => join(projectStateDir(home), 'deliveries.json')

/** Project delivery records; a corrupt or unknown format is refused, never read as empty */
export function readProjectDeliveries(home: string): ProjectDeliveryRecord[] {
  const p = deliveriesPath(home)
  if (!existsSync(p)) return []
  const o = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown; entries?: unknown }
  if (o.version !== 1 || !Array.isArray(o.entries)) throw new Error(`${p}: unsupported format`)
  return o.entries as ProjectDeliveryRecord[]
}

export function writeProjectDeliveries(home: string, records: ProjectDeliveryRecord[]): void {
  atomicWrite(
    deliveriesPath(home),
    JSON.stringify({ version: 1, entries: records }, null, 2) + '\n'
  )
}

/** Leaves a project destination unmanaged: the record goes, the files stay exactly as they are */
export function forgetProjectDelivery(home: string, id: string): void {
  const all = readProjectDeliveries(home)
  const rest = all.filter((r) => r.id !== id)
  if (rest.length === all.length)
    throw new ProjectError('notFound', 'No project delivery with this id.')
  writeProjectDeliveries(home, rest)
}
