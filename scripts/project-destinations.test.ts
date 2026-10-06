/**
 * Project import/delivery, Task 4 (spec 2026-10-06 project delivery §Project destination conventions, §Physical
 * collisions and existing content; criteria 5, 8): native slots per tool, validated alternative rule slots, and
 * destination observations bound to observed filesystem identity — never through a link, never merging distinct
 * case-sensitive folders, refusing ambiguous case and hard-link aliases. Synthetic projects only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { globalTreeDigest } from '../src/engine/globalDigest'
import {
  inspectProjectDestination,
  parseProjectSlot,
  resolveProjectDestination
} from '../src/engine/project/destinations'
import type { ProjectSlot } from '../src/engine/project/types'
import {
  bindingOf,
  inside,
  isContent,
  isWrite,
  linkDir,
  observeFs,
  projectWorkspace,
  put,
  samePath,
  SKILL
} from './lib/projectFixture'

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
const ctx = (home: string): { home: string; signal: AbortSignal } => ({
  home,
  signal: new AbortController().signal
})
const D: ProjectSlot = { type: 'default' }

/** Enables NTFS per-directory case sensitivity on an empty folder; null when the system does not offer it */
function caseSensitiveDir(dir: string): string | null {
  mkdirSync(dir, { recursive: true })
  const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], {
    encoding: 'utf8'
  })
  return r.status === 0
    ? null
    : `fsutil setCaseSensitiveInfo unavailable (${r.status}): ${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

test('project_slots_are_native_and_bounded', async () => {
  const { root } = projectWorkspace()
  mkdirSync(join(root, 'B'))
  const { binding: projectB } = await bindingOf(root, 'B')
  const B = projectB.path
  const codexSkillPath = resolveProjectDestination(projectB, 'skill', 'caveman', 'codex', D)
  assert.equal(codexSkillPath, join(projectB.path, '.agents', 'skills', 'caveman'))
  assert.equal(
    resolveProjectDestination(projectB, 'skill', 'caveman', 'claude', D),
    join(B, '.claude', 'skills', 'caveman')
  )
  assert.equal(
    resolveProjectDestination(projectB, 'skill', 'caveman', 'opencode', D),
    join(B, '.opencode', 'skills', 'caveman')
  )
  const codexRulePath = resolveProjectDestination(projectB, 'rule', 'style.md', 'codex', D)
  const openCodeRulePath = resolveProjectDestination(projectB, 'rule', 'style.md', 'opencode', D)
  assert.equal(codexRulePath, join(B, 'AGENTS.md'))
  assert.equal(codexRulePath, openCodeRulePath)
  assert.equal(
    resolveProjectDestination(projectB, 'rule', 'x.md', 'claude', D),
    join(B, 'CLAUDE.md')
  )

  // Every supported alternative rule slot, for its own tool only
  const alt: [string, ProjectSlot, string][] = [
    ['claude', { type: 'claudeNested' }, join(B, '.claude', 'CLAUDE.md')],
    ['claude', { type: 'claudeLocal' }, join(B, 'CLAUDE.local.md')],
    [
      'claude',
      { type: 'claudeNamedRule', name: 'team/style.md' },
      join(B, '.claude', 'rules', 'illithid', 'team', 'style.md')
    ],
    ['codex', { type: 'codexOverride' }, join(B, 'AGENTS.override.md')],
    ['opencode', { type: 'opencodeClaude' }, join(B, 'CLAUDE.md')]
  ]
  for (const [tool, slot, want] of alt)
    assert.equal(
      resolveProjectDestination(projectB, 'rule', 'x.md', tool as 'claude', slot),
      want,
      JSON.stringify(slot)
    )
  const refusedSlots: [string, string, unknown][] = [
    ['codex', 'rule', { type: 'claudeNested' }],
    ['claude', 'rule', { type: 'codexOverride' }],
    ['codex', 'rule', { type: 'opencodeClaude' }],
    ['opencode', 'rule', { type: 'claudeLocal' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: '../escape.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'a/../../b.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'C:\\abs.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: '/abs.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'con.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'a:b.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'notes.txt' }],
    ['claude', 'rule', { type: 'claudeNamedRule', name: 'x.md', extra: 1 }],
    ['claude', 'rule', { type: 'default', name: 'x.md' }],
    ['claude', 'rule', { type: 'claudeNamedRule' }],
    ['claude', 'rule', { type: 'elsewhere' }],
    ['claude', 'skill', { type: 'claudeNested' }],
    ['claude', 'skill', { type: 'claudeNamedRule', name: 'x.md' }]
  ]
  for (const [tool, kind, slot] of refusedSlots)
    assert.throws(
      () =>
        resolveProjectDestination(
          projectB,
          kind as 'rule',
          'x.md',
          tool as 'claude',
          parseProjectSlot(slot)
        ),
      { code: 'invalid' },
      `${tool} ${kind} ${JSON.stringify(slot)}`
    )
  // Skill names are one valid segment
  for (const bad of ['../up', 'a/b', 'con', 'trailing.', ''])
    assert.throws(() => resolveProjectDestination(projectB, 'skill', bad, 'codex', D), {
      code: 'invalid'
    })
})

test('project destinations observe whole content, identities and local slots without following links', async () => {
  const { base, home, root } = projectWorkspace()
  const B = join(root, 'B')
  put(B, 'AGENTS.md', '# b\r\n')
  put(B, 'AGENTS.override.md', '# override\n')
  put(B, '.agents/skills/caveman/SKILL.md', SKILL('caveman'))
  put(B, '.agents/skills/caveman/.DS_Store', Buffer.from([1]))
  mkdirSync(join(B, '.agents/skills/caveman/empty'))
  const { binding } = await bindingOf(root, 'B')

  const file = await inspectProjectDestination(ctx(home), binding, join(B, 'AGENTS.md'), 'rule')
  assert.equal(file.shape, 'file')
  assert.equal(file.digest, sha('# b\r\n'))
  assert.equal(file.digestAlgorithm, 'sha256-v1')
  const slots = Object.fromEntries(file.localSlots.map((s) => [s.path, s]))
  assert.equal(slots['AGENTS.override.md'].present, true)
  assert.match(slots['AGENTS.override.md'].note ?? '', /override/i)
  assert.equal(slots['CLAUDE.md'].present, false)

  const dir = await inspectProjectDestination(
    ctx(home),
    binding,
    join(B, '.agents', 'skills', 'caveman'),
    'skill'
  )
  assert.equal(dir.shape, 'dir')
  assert.equal(dir.digestAlgorithm, 'fullTree-v1')
  assert.equal(dir.digest, globalTreeDigest(join(B, '.agents', 'skills', 'caveman')))
  assert.ok(dir.manifest!.some((e) => e.path === 'empty'))

  const absent = await inspectProjectDestination(
    ctx(home),
    binding,
    join(B, '.claude', 'skills', 'caveman'),
    'skill'
  )
  assert.equal(absent.shape, 'absent')
  assert.equal(absent.digest, null)
  assert.ok(samePath(absent.existingAncestor.path, B))
  assert.deepEqual(absent.remaining, ['.claude', 'skills', 'caveman'])

  // A junction as the destination, as a folder on the way, or inside a skill: refused, never followed
  put(base, 'elsewhere/skills/caveman/SKILL.md', SKILL('caveman'))
  linkDir(join(base, 'elsewhere'), join(B, '.opencode'))
  const observed = await observeFs(() =>
    inspectProjectDestination(
      ctx(home),
      binding,
      join(B, '.opencode', 'skills', 'caveman'),
      'skill'
    )
  )
  assert.equal((observed.error as { reason?: string })?.reason, 'linkedAncestor')
  assert.deepEqual(
    observed.calls.filter((c) => inside(c.path, join(B, '.opencode'))),
    [],
    'nothing below the junction is touched'
  )
  assert.deepEqual(observed.calls.filter(isWrite), [])
  mkdirSync(join(B, '.claude', 'skills'), { recursive: true })
  linkDir(join(base, 'elsewhere', 'skills', 'caveman'), join(B, '.claude', 'skills', 'linked'))
  await assert.rejects(
    inspectProjectDestination(ctx(home), binding, join(B, '.claude', 'skills', 'linked'), 'skill'),
    { reason: 'linkedDestination' }
  )
  linkDir(join(base, 'elsewhere'), join(B, '.agents', 'skills', 'caveman', 'inner'))
  await assert.rejects(
    inspectProjectDestination(ctx(home), binding, join(B, '.agents', 'skills', 'caveman'), 'skill'),
    { reason: 'linkInside' }
  )
  // A file where a folder of the path belongs, a folder where a rule file belongs
  put(B, 'notdir', 'x')
  await assert.rejects(
    inspectProjectDestination(ctx(home), binding, join(B, 'notdir', 'x.md'), 'rule'),
    { reason: 'invalidContainer' }
  )
  mkdirSync(join(B, 'CLAUDE.local.md'))
  await assert.rejects(
    inspectProjectDestination(ctx(home), binding, join(B, 'CLAUDE.local.md'), 'rule'),
    { reason: 'notAFile' }
  )
  // Only metadata of B and the destination's own content are read
  const reads = await observeFs(() =>
    inspectProjectDestination(ctx(home), binding, join(B, 'AGENTS.md'), 'rule')
  )
  assert.deepEqual(
    reads.calls.filter(
      (c) =>
        isContent(c) &&
        !samePath(c.path, B) &&
        !samePath(c.path, join(B, 'AGENTS.md')) &&
        !inside(join(B, 'AGENTS.md'), c.path)
    ),
    []
  )
})

test('project_identity_does_not_lowercase_distinct_folders', async (t) => {
  const { home, root } = projectWorkspace()
  const B = join(root, 'B')
  mkdirSync(join(B, '.agents'), { recursive: true })
  const skills = join(B, '.agents', 'skills')
  const why = caseSensitiveDir(skills)
  const { binding } = await bindingOf(root, 'B')
  if (why) t.skip(why)
  else {
    put(skills, 'Caveman/SKILL.md', SKILL('Caveman'))
    put(skills, 'caveman/SKILL.md', SKILL('caveman'))
    const caseSensitiveA = await inspectProjectDestination(
      ctx(home),
      binding,
      join(skills, 'Caveman'),
      'skill'
    )
    const caseSensitiveB = await inspectProjectDestination(
      ctx(home),
      binding,
      join(skills, 'caveman'),
      'skill'
    )
    assert.notEqual(caseSensitiveA.physicalKey, caseSensitiveB.physicalKey)
    assert.notEqual(caseSensitiveA.digest, caseSensitiveB.digest)
    // An absent name next to a case-only twin is distinct there too, but it is never guessed: refused as ambiguous
    put(skills, 'Other/SKILL.md', SKILL('Other'))
    await assert.rejects(
      inspectProjectDestination(ctx(home), binding, join(skills, 'other'), 'skill'),
      { reason: 'ambiguousCase' }
    )
  }

  // On an ordinary (case-insensitive) folder a case-only spelling is the same entry: refused as ambiguous
  const { root: r2, home: h2 } = projectWorkspace()
  put(r2, 'C/.claude/skills/Caveman/SKILL.md', SKILL('Caveman'))
  put(r2, 'C/Agents.md', '# c\n')
  const { binding: c } = await bindingOf(r2, 'C')
  await assert.rejects(
    inspectProjectDestination(ctx(h2), c, join(r2, 'C', '.claude', 'skills', 'caveman'), 'skill'),
    { reason: 'ambiguousCase' }
  )
  await assert.rejects(inspectProjectDestination(ctx(h2), c, join(r2, 'C', 'AGENTS.md'), 'rule'), {
    reason: 'ambiguousCase'
  })
  // Hard-link aliases: one file with two names is never a destination
  put(r2, 'C/CLAUDE.md', '# shared\n')
  linkSync(join(r2, 'C', 'CLAUDE.md'), join(r2, 'C', 'CLAUDE.local.md'))
  await assert.rejects(inspectProjectDestination(ctx(h2), c, join(r2, 'C', 'CLAUDE.md'), 'rule'), {
    reason: 'hardLinked'
  })
  await assert.rejects(
    inspectProjectDestination(ctx(h2), c, join(r2, 'C', 'CLAUDE.local.md'), 'rule'),
    { reason: 'hardLinked' }
  )
})
