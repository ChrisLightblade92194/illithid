/**
 * Project import/delivery, Task 1 (spec 2026-10-06 project delivery, criteria 2, 8): complete-content observations of
 * one project rule or skill — every entry participates (hidden files, empty folders, .DS_Store), links and limits make
 * it incomplete, and a copy is verified against the observation. Synthetic projects only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanProjects } from '../src/engine/census/scan'
import { globalTreeDigest } from '../src/engine/globalDigest'
import { copyProjectContent, observeProjectContent } from '../src/engine/project/content'
import {
  bindingOf,
  inside,
  isWrite,
  linkDir,
  observeFs,
  projectWorkspace,
  put,
  samePath,
  SKILL,
  snapshot
} from './lib/projectFixture'

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
const signal = (): AbortSignal => new AbortController().signal

function skillProject(): { base: string; root: string; skill: string } {
  const { base, root } = projectWorkspace()
  const skill = join(root, 'A', '.claude', 'skills', 'caveman')
  put(skill, 'SKILL.md', SKILL('caveman'))
  put(skill, 'assets/x.bin', Buffer.from([0, 1, 2, 255]))
  put(skill, '.hidden', 'h\n')
  return { base, root, skill }
}

test('project_content_covers_every_entry', async () => {
  const { base, root, skill } = skillProject()
  const { binding, discovery, candidateId } = await bindingOf(root, 'A')
  const rel = '.claude/skills/caveman'
  const before = await observeProjectContent(binding, rel, 'skill', signal())
  assert.equal(before.kind, 'skill')
  assert.equal(before.censusAlgorithm, 'census-skill-v1')
  assert.equal(before.revisionAlgorithm, 'fullTree-v1')
  assert.deepEqual(
    before.manifest!.map((e) => e.path),
    ['.hidden', 'SKILL.md', 'assets', 'assets/x.bin']
  )
  // The library revision is the complete-tree format of the global library, computed from the same reads
  assert.equal(before.revision, globalTreeDigest(skill))
  // The census digest is the census contract: equal to what a census reports for the same skill
  const census = await scanProjects(discovery, [candidateId], {
    signal: signal(),
    onProgress: () => {}
  })
  const item = census.items.find((i) => i.relativePath === rel)!
  assert.equal(before.censusDigest, item.digest)
  assert.deepEqual(before.manifest, item.manifest)

  let last = before
  for (const change of [
    () => put(skill, 'assets/extra.txt', 'extra\n'),
    () => mkdirSync(join(skill, 'empty')),
    () => put(skill, '.DS_Store/payload.bin', Buffer.from([7]))
  ]) {
    change()
    const after = await observeProjectContent(binding, rel, 'skill', signal())
    assert.notEqual(after.censusDigest, last.censusDigest)
    assert.notEqual(after.revision, last.revision)
    assert.equal(after.revision, globalTreeDigest(skill))
    last = after
  }
  assert.ok(last.manifest!.some((e) => e.path === 'empty' && e.kind === 'dir'))
  assert.ok(last.manifest!.some((e) => e.path === '.DS_Store/payload.bin'))

  // A verified copy holds exactly the observed tree; the source is not touched
  const sourceBefore = snapshot(skill)
  const dest = join(base, 'library ä', 'content')
  mkdirSync(join(base, 'library ä'))
  const copied = await copyProjectContent(last, dest, signal())
  assert.deepEqual(copied.manifest, last.manifest)
  assert.equal(copied.censusDigest, last.censusDigest)
  assert.equal(copied.revision, globalTreeDigest(dest))
  assert.equal(copied.sourcePath, dest)
  assert.deepEqual(snapshot(skill), sourceBefore)
})

test('project_content_reads_a_rule_as_exact_bytes', async () => {
  const { base, root } = projectWorkspace()
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# A\r\n@x.md\r\n')])
  put(root, 'A/AGENTS.override.md', bytes)
  const { binding } = await bindingOf(root, 'A')
  const o = await observeProjectContent(binding, 'AGENTS.override.md', 'rule', signal())
  assert.equal(o.censusAlgorithm, 'sha256-v1')
  assert.equal(o.revisionAlgorithm, 'sha256-v1')
  assert.equal(o.censusDigest, sha(bytes))
  assert.equal(o.revision, sha(bytes))
  assert.equal(o.bytes, bytes.length)
  assert.equal(o.manifest, undefined)
  const dest = join(base, 'copy', 'AGENTS.override.md')
  mkdirSync(join(base, 'copy'))
  const c = await copyProjectContent(o, dest, signal())
  assert.deepEqual(readFileSync(dest), bytes)
  assert.equal(c.revision, sha(bytes))
})

test('project_content_refuses_changed_or_linked_tree', async () => {
  const { base, root, skill } = skillProject()
  put(base, 'outside/secret.md', 'outside\n')
  const rel = '.claude/skills/caveman'
  const { binding } = await bindingOf(root, 'A')
  const refused = (reason: string) => (e: unknown) => {
    const x = e as { code?: string; reason?: string }
    assert.equal(x.code, 'incomplete', `code for ${reason}: ${x.code} ${(e as Error).message}`)
    assert.equal(x.reason, reason)
    return true
  }

  // Every small injected limit refuses the whole observation
  await assert.rejects(
    observeProjectContent(binding, rel, 'skill', signal(), { fileBytes: 3 }),
    refused('fileBytes')
  )
  await assert.rejects(
    observeProjectContent(binding, rel, 'skill', signal(), { skillBytes: 10 }),
    refused('skillBytes')
  )
  await assert.rejects(
    observeProjectContent(binding, rel, 'skill', signal(), { skillEntries: 2 }),
    refused('skillEntries')
  )
  await assert.rejects(
    observeProjectContent(binding, rel, 'skill', signal(), { depth: 1 }),
    refused('depth')
  )
  put(root, 'A/CLAUDE.md', '# twelve bytes')
  await assert.rejects(
    observeProjectContent(binding, 'CLAUDE.md', 'rule', signal(), { fileBytes: 4 }),
    refused('fileBytes')
  )

  // A junction inside the skill, as the skill folder, and as a folder on the way: never followed
  linkDir(join(base, 'outside'), join(skill, 'assets', 'linked'))
  const inner = await observeFs(() => observeProjectContent(binding, rel, 'skill', signal()))
  refused('linkInside')(inner.error)
  assert.deepEqual(
    inner.calls.filter((c) => inside(c.path, join(skill, 'assets', 'linked'))),
    [],
    'nothing below the junction is read'
  )
  put(root, 'B/.agents/skills/real/SKILL.md', SKILL('real'))
  linkDir(join(root, 'B', '.agents', 'skills', 'real'), join(root, 'A', '.claude', 'skills', 'ln'))
  await assert.rejects(
    observeProjectContent(binding, '.claude/skills/ln', 'skill', signal()),
    refused('link')
  )
  put(root, 'C/elsewhere/rules/x.md', 'x\n')
  mkdirSync(join(root, 'D'))
  linkDir(join(root, 'C', 'elsewhere'), join(root, 'D', '.claude'))
  const { binding: d } = await bindingOf(root, 'D')
  await assert.rejects(
    observeProjectContent(d, '.claude/rules/x.md', 'rule', signal()),
    refused('linkedAncestor')
  )

  // Only lstat/readdir/read-only opens on the item and the folders on the way: nothing follows a link, nothing writes
  const { root: r2, skill: s2 } = skillProject()
  const { binding: b2 } = await bindingOf(r2, 'A')
  const seen = await observeFs(() => observeProjectContent(b2, rel, 'skill', signal()))
  assert.equal(seen.error, undefined)
  assert.deepEqual(seen.calls.filter(isWrite), [])
  assert.deepEqual(
    seen.calls.filter((c) => /stat$|statSync$|realpath/.test(c.fn) && !/lstat/.test(c.fn)),
    []
  )
  for (const c of seen.calls)
    assert.ok(
      samePath(c.path, s2) ||
        inside(c.path, s2) ||
        b2.chain.some((x) => samePath(x.path, c.path)) ||
        inside(s2, c.path),
      `unexpected path ${c.fn} ${c.path}`
    )

  // A change between the observation and the copy is refused, and the partial copy is removed
  const o = await observeProjectContent(b2, rel, 'skill', signal())
  writeFileSync(join(s2, 'assets', 'x.bin'), Buffer.from([9, 9, 9, 9]))
  const dest = join(base, 'lib-a', 'content')
  mkdirSync(join(base, 'lib-a'))
  await assert.rejects(copyProjectContent(o, dest, signal()), { code: 'changedSinceCheck' })
  assert.equal(existsSync(dest), false)

  // A change during the copy (an entry added while a file is read) is refused too
  const o2 = await observeProjectContent(b2, rel, 'skill', signal())
  const dest2 = join(base, 'lib-b', 'content')
  mkdirSync(join(base, 'lib-b'))
  let added = false
  const during = await observeFs(() => copyProjectContent(o2, dest2, signal()), {
    hold: (c) => {
      if (!added && c.fn === 'promises.open' && samePath(c.path, join(s2, 'SKILL.md'))) {
        added = true
        put(s2, 'assets/late.txt', 'late\n')
      }
      return undefined
    }
  })
  assert.ok(added)
  assert.equal((during.error as { code?: string })?.code, 'changedSinceCheck')
  assert.equal(existsSync(dest2), false)

  // The project folder replaced (identical contents): the binding no longer matches
  const { root: r3 } = skillProject()
  const { binding: b3 } = await bindingOf(r3, 'A')
  renameSync(join(r3, 'A'), join(r3, 'A-old'))
  put(r3, 'A/.claude/skills/caveman/SKILL.md', SKILL('caveman'))
  await assert.rejects(observeProjectContent(b3, rel, 'skill', signal()), {
    code: 'projectChanged'
  })
})
