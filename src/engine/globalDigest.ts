/** Digests for the global Windows flow: every copied entry participates, including .DS_Store. */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Same tree format as upstream dirContentHash, without its Finder-metadata exclusions. Never follows links. */
export function globalTreeDigest(root: string): string {
  const h = createHash('sha256')
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) h.update(`L\0${r}\0${readlinkSync(p)}\0`)
      else if (st.isDirectory()) {
        h.update(`D\0${r}\0`)
        walk(p, r)
      } else if (st.isFile()) {
        h.update(`F\0${r}\0`)
        h.update(readFileSync(p))
        h.update('\0')
      }
    }
  }
  walk(root, '')
  return h.digest('hex')
}
