/**
 * Synthetic projects, library variants and failure injection for the project import/delivery tests. Every tree lives
 * under the OS temp folder with spaces and non-ASCII characters in its path; nothing here reads real projects.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverProjects } from '../../src/engine/census/paths'
import type { CandidateBinding, DiscoveryHandle } from '../../src/engine/census/types'
import { globalLibraryDir } from '../../src/engine/globalPaths'
import type { ProjectOrigin } from '../../src/engine/project/types'
import { censusBase, put } from './censusFixture'

export {
  censusBase,
  codeOf,
  errno,
  fmt,
  inside,
  isContent,
  isWrite,
  linkDir,
  observeFs,
  put,
  samePath,
  snapshot,
  syntheticGlobalState,
  type FsCall
} from './censusFixture'

export const SKILL = (name: string): string => `---\nname: ${name}\ndescription: test\n---\nbody\n`

/** `<tmp>/illithid prøjects XXXX/` with a `root ö` folder for the projects and a `home ä` HOME */
export function projectWorkspace(): { base: string; root: string; home: string } {
  const base = censusBase('illithid prøjects ')
  const root = join(base, 'root ö')
  const home = join(base, 'home ä')
  mkdirSync(root, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { base, root, home }
}

/** Discovery of root and the binding of one of its candidates (the root itself when name is null) */
export async function bindingOf(
  root: string,
  name: string | null
): Promise<{ discovery: DiscoveryHandle; binding: CandidateBinding; candidateId: string }> {
  const discovery = await discoverProjects(root)
  const c = discovery.view.candidates.find((x) => (name === null ? x.isRoot : x.name === name))
  if (!c) throw new Error(`no candidate ${name}`)
  const binding = discovery.bindings.get(c.id)
  if (!binding) throw new Error(`candidate ${name} is not available (${c.status})`)
  return { discovery, binding, candidateId: c.id }
}

/**
 * A library variant written directly in the variant layout (no import step), with the given origins: lets provenance
 * tests build project-only and mixed libraries without depending on the importer.
 */
export function seedRawVariant(
  home: string,
  v: {
    kind: 'rule' | 'skill'
    name: string
    /** Rule: the bytes; skill: files relative to the skill folder */
    content: string | Buffer | Record<string, string | Buffer>
    origins: (ProjectOrigin | Record<string, unknown>)[]
  }
): { id: string; dir: string } {
  const id = `${v.kind}-${randomBytes(8).toString('hex')}`
  const dir = join(globalLibraryDir(home), id)
  let content = 'content'
  if (v.kind === 'rule') {
    const file = v.name.split('/').pop()!
    content = `content/${file}`
    put(dir, content, v.content as string | Buffer)
  } else {
    mkdirSync(join(dir, 'content'), { recursive: true })
    for (const [rel, body] of Object.entries(v.content as Record<string, string | Buffer>))
      put(join(dir, 'content'), rel, body)
  }
  writeFileSync(
    join(dir, 'variant.json'),
    JSON.stringify(
      { version: 1, id, kind: v.kind, name: v.name, content, origins: v.origins, references: [] },
      null,
      2
    ) + '\n'
  )
  return { id, dir }
}
