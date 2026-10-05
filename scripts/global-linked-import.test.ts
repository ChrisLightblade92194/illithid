/**
 * Guided import of linked skills (a skill folder that is a symlink or junction under a confirmed skills container).
 * Before the confirmation only the link and its target are inspected (metadata); the target's contents are read only
 * for the links the user confirmed, bound to the link and target shown. Synthetic profiles only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
// The default export is the fs module object other modules call: spies must patch it, not a namespace copy
import fs from 'node:fs'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  globalLibraryDir,
  resolveGlobalPaths,
  type GlobalPathResult
} from '../src/engine/globalPaths'
import {
  importGlobalItems,
  importLinkedSkills,
  listGlobalImportables,
  previewLinkedSkills,
  readStoredVariants,
  type GlobalImportListing,
  type GlobalImportResult,
  type LinkedSkillCandidate,
  type LinkedSkillConfirmation,
  type LinkedSkillPreviewResult
} from '../src/engine/globalImport'
import { dirContentHash } from '../src/engine/skills'
import { applyGlobalSync, planGlobalSync } from '../src/engine/globalManualSync'
import { readGlobalChoices } from '../src/engine/globalVariants'
import { confirmGlobalPath } from '../src/engine/globalPaths'
import { globalLibraryView, setRecipient } from '../src/engine/globalView'
import { globalHandlers } from '../src/main/globalIpc'
import type { GlobalResult } from '../src/shared/api'
import { denyRead, put, snapshot, syntheticHome } from './lib/globalFixture'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a, 0x1a])
const SKILL = '---\nname: caveman\ndescription: talk short\n---\nTalk like caveman.\n'

interface Linked {
  home: string
  /** Real folder the junction points to (outside every tool root) */
  target: string
  /** The junction under ~/.claude/skills */
  link: string
  paths: GlobalPathResult[]
}

/** A Claude profile with one ordinary skill and one skill installed as a junction to a shared folder */
function linkedHome(): Linked {
  const home = syntheticHome()
  const target = join(home, 'shared skills', 'caveman')
  put(target, 'SKILL.md', SKILL)
  // Would leave a marker next to the shared folder if anything ran it
  put(target, 'scripts/run.cmd', '@echo off\r\necho ran> "%~dp0..\\..\\ran.txt"\r\n')
  put(target, 'assets/logo.png', PNG)
  put(target, 'ref/notes ü.md', 'notes\n')
  put(home, '.claude/skills/plain/SKILL.md', '---\nname: plain\n---\nplain\n')
  const link = join(home, '.claude/skills/caveman')
  symlinkSync(target, link, 'junction')
  return {
    home,
    target: realpathSync.native(target),
    link,
    paths: resolveGlobalPaths(home, {}, {})
  }
}

const confirmOf = (c: LinkedSkillCandidate): LinkedSkillConfirmation => ({
  tool: c.tool,
  linkPath: c.linkPath,
  targetPath: c.targetPath,
  linkFingerprint: c.linkFingerprint
})

const libEntries = (home: string): string[] =>
  existsSync(globalLibraryDir(home)) ? readdirSync(globalLibraryDir(home)) : []

/** Metadata calls allowed on a link target before the confirmation (never on anything inside it) */
const META = new Set([
  'statSync',
  'lstatSync',
  'existsSync',
  'readlinkSync',
  'realpathSync',
  'realpathSync.native'
])
const SPIED = [
  'readdirSync',
  'opendirSync',
  'readFileSync',
  'openSync',
  'copyFileSync',
  'cpSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'readlinkSync',
  'accessSync',
  'realpathSync'
]

interface FsCall {
  fn: string
  path: string
}

/** Runs fn recording every spied fs call (by the engine and by node:fs users alike) with its path argument */
function fsCalls<T>(fn: () => T): { value: T; calls: FsCall[] } {
  const calls: FsCall[] = []
  const fsm = fs as unknown as Record<string, ((...a: unknown[]) => unknown) & { native?: unknown }>
  const saved = SPIED.map((k) => fsm[k])
  const savedNative = fs.realpathSync.native
  SPIED.forEach((k, i) => {
    const wrapped = (...a: unknown[]): unknown => {
      if (typeof a[0] === 'string') calls.push({ fn: k, path: a[0] })
      return saved[i](...a)
    }
    fsm[k] = wrapped
  })
  fsm['realpathSync'].native = (...a: unknown[]): unknown => {
    if (typeof a[0] === 'string') calls.push({ fn: 'realpathSync.native', path: a[0] })
    return (savedNative as (...x: unknown[]) => unknown)(...a)
  }
  try {
    return { value: fn(), calls }
  } finally {
    SPIED.forEach((k, i) => (fsm[k] = saved[i]))
    fs.realpathSync.native = savedNative
  }
}

/** Calls that enumerate or read the contents of dir (metadata on dir itself is allowed) */
function contentAccess(calls: FsCall[], dir: string): string[] {
  const root = resolve(dir)
  return calls
    .filter((c) => {
      const r = relative(root, resolve(c.path))
      if (r === '') return !META.has(c.fn)
      return !r.startsWith('..') && !isAbsolute(r)
    })
    .map((c) => `${c.fn} ${c.path}`)
}

test('linked skill: the listing shows the link and its real target without reading the target', () => {
  const { home, target, link, paths } = linkedHome()
  const before = snapshot(target)
  const { value: listing, calls } = fsCalls(() => listGlobalImportables(home, paths))
  assert.deepEqual(contentAccess(calls, target), [])
  assert.deepEqual(
    listing.linked.map((c) => [c.tool, c.name, c.linkPath, c.targetPath]),
    [['claude', 'caveman', link, target]]
  )
  assert.match(listing.linked[0].linkFingerprint, /^[0-9a-f]{64}$/)
  // Linked skills are not ordinary items: "Select all" (every item) never reaches them
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ['plain']
  )
  assert.deepEqual(listing.errors, [])
  // Without a confirmation (cancel) nothing is imported and the originals stay as they are
  const all = fsCalls(() => importGlobalItems(home, listing.items, paths))
  assert.deepEqual(contentAccess(all.calls, target), [])
  assert.deepEqual(
    all.value.items.map((i) => i.name),
    ['plain']
  )
  assert.deepEqual(snapshot(target), before)
  assert.equal(readlinkSync(link), target)
  assert.equal(
    readStoredVariants(home).variants.some((v) => v.name === 'caveman'),
    false
  )
})

test('linked skill: the ordinary import refuses a linked folder, whatever the renderer adds to the request', async () => {
  const { home, target, link } = linkedHome()
  confirmGlobalPath(home, 'claude', join(home, '.claude'))
  const h = globalHandlers(home)
  const forged = {
    tool: 'claude',
    kind: 'skill',
    name: 'caveman',
    sourcePath: link,
    sourceDigest: dirContentHash(target),
    allowLinks: true,
    linkTarget: target
  }
  // The handler body runs synchronously inside the spy; only its result is awaited
  const pending = fsCalls(() => h.globalImport([forged]))
  assert.deepEqual(await pending.value, {
    ok: true,
    value: { items: [], errors: [{ path: link, code: 'linkedSource' }] }
  })
  assert.deepEqual(contentAccess(pending.calls, target), [])
  assert.deepEqual(libEntries(home), [])
})

test('linked skill: an approved import through a junction copies every resource and leaves link and target as they were', (t) => {
  const { home, target, link, paths } = linkedHome()
  const level = spawnSync('whoami', ['/groups'], { encoding: 'utf8' }).stdout ?? ''
  t.diagnostic(`elevated: ${level.includes('S-1-16-12288')}`)
  const targetBefore = snapshot(target)
  const toolsBefore = snapshot(join(home, '.claude'))
  const listing = listGlobalImportables(home, paths)
  const confirmation = confirmOf(listing.linked[0])
  // The preview reads only what was confirmed, and writes nothing
  const stateBefore = snapshot(join(home, '.config'))
  const preview = previewLinkedSkills(home, [confirmation], paths)
  assert.deepEqual(preview.errors, [])
  assert.equal(preview.items.length, 1)
  const p = preview.items[0]
  assert.deepEqual(
    [p.name, p.linkPath, p.targetPath, p.sourceDigest],
    ['caveman', link, target, dirContentHash(target)]
  )
  assert.deepEqual(libEntries(home), [])
  assert.deepEqual(snapshot(join(home, '.config')), stateBefore)

  const r = importLinkedSkills(home, [{ ...confirmation, sourceDigest: p.sourceDigest }], paths)
  assert.deepEqual(r.errors, [])
  assert.equal(r.items.length, 1)
  const s = r.items[0]
  assert.equal(s.kind, 'skill')
  assert.equal(s.name, 'caveman')
  assert.deepEqual(readdirSync(s.storedPath).sort(), ['SKILL.md', 'assets', 'ref', 'scripts'])
  assert.equal(readFileSync(join(s.storedPath, 'SKILL.md'), 'utf8'), SKILL)
  assert.deepEqual(readFileSync(join(s.storedPath, 'assets/logo.png')), PNG)
  assert.equal(readFileSync(join(s.storedPath, 'ref/notes ü.md'), 'utf8'), 'notes\n')
  assert.equal(
    readFileSync(join(s.storedPath, 'scripts/run.cmd'), 'utf8'),
    readFileSync(join(target, 'scripts/run.cmd'), 'utf8')
  )
  assert.equal(dirContentHash(s.storedPath), p.sourceDigest)
  // Logical provenance (the link) and the real folder that was read
  assert.deepEqual(
    [s.origin.tool, s.origin.path, s.origin.linkTarget, s.origin.digest],
    ['claude', link, target, p.sourceDigest]
  )
  const stored = readStoredVariants(home).variants.find((v) => v.id === s.id)!
  assert.deepEqual(stored.origins[0].linkTarget, target)
  // Link, target and contents untouched; no script ran
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), target)
  assert.deepEqual(snapshot(target), targetBefore)
  assert.deepEqual(snapshot(join(home, '.claude')), toolsBefore)
  assert.equal(existsSync(join(home, 'shared skills', 'ran.txt')), false)
  assert.equal(existsSync(join(home, 'ran.txt')), false)
  // The confirmation was used once: the same content is not imported twice, nothing general was stored
  const again = importLinkedSkills(home, [{ ...confirmation, sourceDigest: p.sourceDigest }], paths)
  assert.deepEqual(
    again.errors.map((e) => e.code),
    ['alreadyImported']
  )
  assert.equal(libEntries(home).length, 1)
})

test('linked skill: variants saved before and after this change stay readable side by side', () => {
  const { home, paths } = linkedHome()
  const listing = listGlobalImportables(home, paths)
  importGlobalItems(home, listing.items, paths)
  const c = confirmOf(listing.linked[0])
  const p = previewLinkedSkills(home, [c], paths).items[0]
  importLinkedSkills(home, [{ ...c, sourceDigest: p.sourceDigest }], paths)
  const { variants, errors } = readStoredVariants(home)
  assert.deepEqual(errors, [])
  assert.deepEqual(variants.map((v) => v.name).sort(), ['caveman', 'plain'])
  const plain = variants.find((v) => v.name === 'plain')!
  assert.equal('linkTarget' in plain.origins[0], false)
})

test('linked skill: a confirmation that names another path or another target is refused without reading it', () => {
  const { home, target, paths } = linkedHome()
  const other = join(home, 'other folder')
  put(other, 'SKILL.md', SKILL)
  // A link outside the skills containers, to the same target
  const stray = join(home, 'stray link')
  symlinkSync(target, stray, 'junction')
  const shown = confirmOf(listGlobalImportables(home, paths).linked[0])
  const cases: [LinkedSkillConfirmation, string][] = [
    [{ ...shown, targetPath: realpathSync.native(other) }, 'linkChanged'],
    [{ ...shown, linkFingerprint: '0'.repeat(64) }, 'linkChanged'],
    [{ ...shown, linkPath: target }, 'notListed'],
    [{ ...shown, linkPath: stray }, 'notListed'],
    [{ ...shown, linkPath: join(home, '.claude/skills/plain') }, 'notListed'],
    // Not normalized on purpose: the backend compares the path it would list, it does not resolve the one it gets
    [{ ...shown, linkPath: `${join(home, '.claude/skills/plain')}\\..\\caveman` }, 'notListed'],
    [{ ...shown, tool: 'codex' }, 'notListed']
  ]
  const digest = dirContentHash(target)
  for (const [c, code] of cases) {
    const pv = fsCalls(() => previewLinkedSkills(home, [c], paths))
    assert.deepEqual(
      pv.value.errors.map((e) => e.code),
      [code],
      JSON.stringify(c)
    )
    assert.deepEqual(pv.value.items, [])
    const im = fsCalls(() => importLinkedSkills(home, [{ ...c, sourceDigest: digest }], paths))
    assert.deepEqual(
      im.value.errors.map((e) => e.code),
      [code],
      JSON.stringify(c)
    )
    for (const calls of [pv.calls, im.calls]) {
      assert.deepEqual(contentAccess(calls, target), [])
      assert.deepEqual(contentAccess(calls, other), [])
    }
  }
  assert.deepEqual(libEntries(home), [])
})

/** Plain recursive copy (fs.cpSync crashes Node 22 on non-ASCII paths like the synthetic HOME) */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const n of readdirSync(from)) {
    const s = join(from, n)
    if (lstatSync(s).isDirectory()) copyDir(s, join(to, n))
    else copyFileSync(s, join(to, n))
  }
}

/** Same bytes in a second folder */
function twinOf(target: string, where: string): string {
  copyDir(target, where)
  return realpathSync.native(where)
}

function repoint(link: string, to: string): void {
  unlinkSync(link)
  symlinkSync(to, link, 'junction')
}

test('linked skill: a link changed after it was shown is refused, even towards identical content', () => {
  const { home, target, link, paths } = linkedHome()
  const shown = confirmOf(listGlobalImportables(home, paths).linked[0])
  const twin = twinOf(target, join(home, 'twin', 'caveman'))
  assert.equal(dirContentHash(twin), dirContentHash(target))
  repoint(link, twin)
  const { value, calls } = fsCalls(() => previewLinkedSkills(home, [shown], paths))
  assert.deepEqual(
    value.errors.map((e) => [e.path, e.code]),
    [[link, 'linkChanged']]
  )
  assert.deepEqual(contentAccess(calls, twin), [])
  assert.deepEqual(contentAccess(calls, target), [])
  assert.deepEqual(libEntries(home), [])
})

test('linked skill: a link or target changed after the confirmation is refused before the copy', () => {
  const changes: [string, (l: Linked) => void][] = [
    [
      'link to identical content elsewhere',
      (l) => repoint(l.link, twinOf(l.target, join(l.home, 'twin', 'caveman')))
    ],
    ['link recreated to the same target', (l) => repoint(l.link, l.target)],
    [
      'target replaced in place by identical content',
      (l) => {
        renameSync(l.target, join(l.home, 'old caveman'))
        copyDir(join(l.home, 'old caveman'), l.target)
      }
    ]
  ]
  for (const [what, change] of changes) {
    const l = linkedHome()
    const c = confirmOf(listGlobalImportables(l.home, l.paths).linked[0])
    const p = previewLinkedSkills(l.home, [c], l.paths).items[0]
    change(l)
    const { value, calls } = fsCalls(() =>
      importLinkedSkills(l.home, [{ ...c, sourceDigest: p.sourceDigest }], l.paths)
    )
    assert.deepEqual(
      value.errors.map((e) => [e.path, e.code]),
      [[l.link, 'linkChanged']],
      what
    )
    assert.deepEqual(value.items, [], what)
    assert.deepEqual(contentAccess(calls, l.target), [], what)
    assert.deepEqual(libEntries(l.home), [], what)
  }
})

test('linked skill: a link swapped while the copy runs is refused and the provisional folder is removed', () => {
  const l = linkedHome()
  const c = confirmOf(listGlobalImportables(l.home, l.paths).linked[0])
  const p = previewLinkedSkills(l.home, [c], l.paths).items[0]
  const twin = twinOf(l.target, join(l.home, 'twin', 'caveman'))
  let provisional: string[] = []
  const r = importLinkedSkills(l.home, [{ ...c, sourceDigest: p.sourceDigest }], l.paths, {
    afterCopy: () => {
      provisional = libEntries(l.home)
      repoint(l.link, twin)
    }
  })
  assert.equal(provisional.length, 1, 'the hook runs after the copy into the library')
  assert.deepEqual(
    r.errors.map((e) => [e.path, e.code]),
    [[l.link, 'linkChanged']]
  )
  assert.deepEqual(libEntries(l.home), [])
})

test('linked skill: content changed after the preview is refused and leaves no provisional folder', () => {
  // Changed before the import starts
  const a = linkedHome()
  const ca = confirmOf(listGlobalImportables(a.home, a.paths).linked[0])
  const pa = previewLinkedSkills(a.home, [ca], a.paths).items[0]
  writeFileSync(join(a.target, 'ref/notes ü.md'), 'edited after the preview\n')
  const ra = importLinkedSkills(a.home, [{ ...ca, sourceDigest: pa.sourceDigest }], a.paths)
  assert.deepEqual(
    ra.errors.map((e) => [e.path, e.code]),
    [[a.link, 'changedSincePreview']]
  )
  assert.deepEqual(libEntries(a.home), [])
  assert.equal(readFileSync(join(a.target, 'ref/notes ü.md'), 'utf8'), 'edited after the preview\n')

  // Changed between the checks and the copy: the copy no longer matches the preview
  const b = linkedHome()
  const cb = confirmOf(listGlobalImportables(b.home, b.paths).linked[0])
  const pb = previewLinkedSkills(b.home, [cb], b.paths).items[0]
  const rb = importLinkedSkills(b.home, [{ ...cb, sourceDigest: pb.sourceDigest }], b.paths, {
    beforeCopy: () => writeFileSync(join(b.target, 'SKILL.md'), 'changed during the import\n')
  })
  assert.deepEqual(
    rb.errors.map((e) => [e.path, e.code]),
    [[b.link, 'changedSincePreview']]
  )
  assert.deepEqual(libEntries(b.home), [])

  // A resource that can no longer be read: an error, and nothing left behind
  const d = linkedHome()
  const cd = confirmOf(listGlobalImportables(d.home, d.paths).linked[0])
  const pd = previewLinkedSkills(d.home, [cd], d.paths).items[0]
  const undo = denyRead(join(d.target, 'assets/logo.png'))
  try {
    const rd = importLinkedSkills(d.home, [{ ...cd, sourceDigest: pd.sourceDigest }], d.paths)
    assert.deepEqual(
      rd.errors.map((e) => e.code),
      ['EPERM']
    )
    assert.deepEqual(rd.items, [])
  } finally {
    undo()
  }
  assert.deepEqual(libEntries(d.home), [])
})

test('linked skill: the digest covers every entry that is copied, .DS_Store included', () => {
  // A change inside .DS_Store after the preview is refused like any other change
  const a = linkedHome()
  put(a.target, '.DS_Store/payload.bin', 'v1\n')
  const ca = confirmOf(listGlobalImportables(a.home, a.paths).linked[0])
  const pa = previewLinkedSkills(a.home, [ca], a.paths).items[0]
  writeFileSync(join(a.target, '.DS_Store/payload.bin'), 'v2, changed after the preview\n')
  assert.notEqual(
    previewLinkedSkills(a.home, [ca], a.paths).items[0].sourceDigest,
    pa.sourceDigest,
    'the preview digest ignores .DS_Store'
  )
  const ra = importLinkedSkills(a.home, [{ ...ca, sourceDigest: pa.sourceDigest }], a.paths)
  assert.deepEqual(
    ra.errors.map((e) => [e.path, e.code]),
    [[a.link, 'changedSincePreview']]
  )
  assert.deepEqual(ra.items, [])
  assert.deepEqual(libEntries(a.home), [])
  assert.equal(readStoredVariants(a.home).variants.length, 0)

  // Unchanged: preview, copy, recorded variant and later checks agree on the same content
  const b = linkedHome()
  put(b.target, '.DS_Store/payload.bin', 'v1\n')
  const cb = confirmOf(listGlobalImportables(b.home, b.paths).linked[0])
  const pb = previewLinkedSkills(b.home, [cb], b.paths).items[0]
  const rb = importLinkedSkills(b.home, [{ ...cb, sourceDigest: pb.sourceDigest }], b.paths)
  assert.deepEqual(rb.errors, [])
  const s = rb.items[0]
  assert.equal(readFileSync(join(s.storedPath, '.DS_Store/payload.bin'), 'utf8'), 'v1\n')
  assert.equal(s.origin.digest, pb.sourceDigest)
  assert.equal(
    readStoredVariants(b.home).variants.find((v) => v.id === s.id)!.origins[0].digest,
    pb.sourceDigest
  )
  const again = importLinkedSkills(b.home, [{ ...cb, sourceDigest: pb.sourceDigest }], b.paths)
  assert.deepEqual(
    again.errors.map((e) => e.code),
    ['alreadyImported']
  )
  // A later change there is new content: a new preview, a new variant, never "already imported"
  writeFileSync(join(b.target, '.DS_Store/payload.bin'), 'v2\n')
  const pb2 = previewLinkedSkills(b.home, [cb], b.paths).items[0]
  assert.notEqual(pb2.sourceDigest, pb.sourceDigest)
  const rb2 = importLinkedSkills(b.home, [{ ...cb, sourceDigest: pb2.sourceDigest }], b.paths)
  assert.deepEqual(rb2.errors, [])
  assert.equal(readFileSync(join(rb2.items[0].storedPath, '.DS_Store/payload.bin'), 'utf8'), 'v2\n')
  assert.equal(libEntries(b.home).length, 2)
})

test('linked skill: a link inside the selected skill is still refused and never followed', () => {
  const { home, target, link, paths } = linkedHome()
  const outside = join(home, 'outside shared')
  put(outside, 'secret.md', 'do not read\n')
  symlinkSync(outside, join(target, 'shared'), 'junction')
  const listing = listGlobalImportables(home, paths)
  assert.deepEqual(
    listing.linked.map((x) => x.linkPath),
    [link]
  )
  const c = confirmOf(listing.linked[0])
  const pv = fsCalls(() => previewLinkedSkills(home, [c], paths))
  assert.deepEqual(pv.value.items, [])
  assert.deepEqual(
    pv.value.errors.map((e) => [e.path, e.code]),
    [[join(target, 'shared'), 'externalLink']]
  )
  const digest = dirContentHash(target)
  const im = fsCalls(() => importLinkedSkills(home, [{ ...c, sourceDigest: digest }], paths))
  assert.deepEqual(
    im.value.errors.map((e) => [e.path, e.code]),
    [[join(target, 'shared'), 'externalLink']]
  )
  for (const calls of [pv.calls, im.calls]) assert.deepEqual(contentAccess(calls, outside), [])
  assert.deepEqual(libEntries(home), [])
})

test('linked skill: linked rules and skills containers stay refused and their links are not offered', () => {
  const home = syntheticHome()
  const extSkills = join(home, 'external skills')
  const target = join(home, 'shared skills', 'caveman')
  put(target, 'SKILL.md', SKILL)
  mkdirSync(extSkills, { recursive: true })
  symlinkSync(target, join(extSkills, 'caveman'), 'junction')
  const extRules = join(home, 'external rules')
  put(extRules, 'x.md', 'external rule\n')
  put(home, '.claude/CLAUDE.md', 'own\n')
  symlinkSync(extSkills, join(home, '.claude/skills'), 'junction')
  symlinkSync(extRules, join(home, '.claude/rules'), 'junction')
  const paths = resolveGlobalPaths(home, {}, {})
  const { value: listing, calls } = fsCalls(() => listGlobalImportables(home, paths))
  assert.deepEqual(listing.linked, [])
  assert.deepEqual(
    listing.errors.map((e) => [e.path, e.code]).sort(),
    [
      [join(home, '.claude/rules'), 'linkedSource'],
      [join(home, '.claude/skills'), 'linkedSource']
    ].sort()
  )
  for (const d of [extSkills, extRules, target]) assert.deepEqual(contentAccess(calls, d), [])
  // A confirmation naming a link inside the linked container is refused the same way
  const forged: LinkedSkillConfirmation = {
    tool: 'claude',
    linkPath: join(home, '.claude/skills/caveman'),
    targetPath: realpathSync.native(target),
    linkFingerprint: '0'.repeat(64)
  }
  const pv = fsCalls(() => previewLinkedSkills(home, [forged], paths))
  assert.deepEqual(
    pv.value.errors.map((e) => [e.path, e.code]),
    [[join(home, '.claude/skills'), 'linkedSource']]
  )
  assert.deepEqual(contentAccess(pv.calls, target), [])
})

test('linked skill: broken, cyclic and self-containing links are reported with their own codes and not offered', () => {
  const home = syntheticHome()
  const skills = join(home, '.claude/skills')
  mkdirSync(skills, { recursive: true })
  // Broken: the target was removed
  const gone = join(home, 'gone')
  mkdirSync(gone)
  symlinkSync(gone, join(skills, 'broken'), 'junction')
  fs.rmdirSync(gone)
  // Cycle: two junctions pointing at each other
  const other = join(home, 'cycle other')
  symlinkSync(other, join(skills, 'loop'), 'junction')
  symlinkSync(join(skills, 'loop'), other, 'junction')
  // Self-containing: the target holds the link itself
  symlinkSync(join(home, '.claude'), join(skills, 'up'), 'junction')
  // Not a skill: listed (its contents are unknown before the confirmation), refused by the preview
  const plainDir = join(home, 'just a folder')
  put(plainDir, 'readme.txt', 'no skill here\n')
  symlinkSync(plainDir, join(skills, 'noskill'), 'junction')
  const paths = resolveGlobalPaths(home, {}, {})
  const listing = listGlobalImportables(home, paths)
  assert.deepEqual(
    listing.errors.map((e) => [e.path, e.code]).sort(),
    [
      [join(skills, 'broken'), 'brokenLink'],
      [join(skills, 'loop'), 'linkCycle'],
      [join(skills, 'up'), 'linkCycle']
    ].sort()
  )
  assert.deepEqual(
    listing.linked.map((c) => c.name),
    ['noskill']
  )
  const { value: pv, calls } = fsCalls(() =>
    previewLinkedSkills(home, [confirmOf(listing.linked[0])], paths)
  )
  assert.deepEqual(
    pv.errors.map((e) => [e.path, e.code]),
    [[realpathSync.native(plainDir), 'notASkill']]
  )
  // A confirmed target without SKILL.md (a whole drive, a home folder) is refused before being walked
  assert.deepEqual(
    calls.filter((c) => c.fn === 'readdirSync' || c.fn === 'opendirSync').map((c) => c.path),
    []
  )
  assert.deepEqual(libEntries(home), [])
})

test('linked skill: a link to a network path is refused without resolving it', (t) => {
  const home = syntheticHome()
  const skills = join(home, '.claude/skills')
  mkdirSync(skills, { recursive: true })
  const link = join(skills, 'remote')
  try {
    symlinkSync('\\\\illithid-test.invalid\\share\\caveman', link, 'dir')
  } catch (e) {
    t.skip(`symbolic links need Developer Mode here (${(e as NodeJS.ErrnoException).code})`)
    return
  }
  const paths = resolveGlobalPaths(home, {}, {})
  const { value: listing, calls } = fsCalls(() => listGlobalImportables(home, paths))
  assert.deepEqual(
    listing.errors.map((e) => [e.path, e.code]),
    [[link, 'unsupportedLinkTarget']]
  )
  assert.deepEqual(listing.linked, [])
  assert.deepEqual(
    calls
      .filter((c) => c.fn.startsWith('realpath') || c.fn === 'statSync')
      .filter((c) => resolve(c.path) === link),
    []
  )
})

test('linked skill: an imported linked variant is never delivered back through the link; other tools get a real copy', () => {
  const { home, target, link } = linkedHome()
  mkdirSync(join(home, '.codex'), { recursive: true })
  confirmGlobalPath(home, 'claude', join(home, '.claude'))
  confirmGlobalPath(home, 'codex', join(home, '.codex'))
  const paths = resolveGlobalPaths(home, {}, {})
  const c = confirmOf(listGlobalImportables(home, paths).linked[0])
  const p = previewLinkedSkills(home, [c], paths).items[0]
  const id = importLinkedSkills(home, [{ ...c, sourceDigest: p.sourceDigest }], paths).items[0].id
  const targetBefore = snapshot(target)
  assert.deepEqual(
    setRecipient(home, { kind: 'skill', name: 'caveman', tool: 'claude', variantId: id }, {}),
    { ok: true }
  )
  assert.deepEqual(
    setRecipient(home, { kind: 'skill', name: 'caveman', tool: 'codex', variantId: id }, {}),
    { ok: true }
  )
  const view = globalLibraryView(home, {})
  const states = view.groups
    .find((g) => g.name === 'caveman')!
    .recipients.map((r) => [r.tool, r.status, r.reason ?? null])
  assert.deepEqual(
    states.find((s) => s[0] === 'claude'),
    ['claude', 'conflict', 'link']
  )
  const plan = planGlobalSync(home, readGlobalChoices(home), { paths })
  assert.deepEqual(
    plan.changes.map((x) => [x.tool, x.op]),
    [['codex', 'create']]
  )
  assert.equal(applyGlobalSync(home, plan).status, 'completed')
  assert.equal(readFileSync(join(home, '.codex/skills/caveman/assets/logo.png')).equals(PNG), true)
  assert.equal(lstatSync(join(home, '.codex/skills/caveman')).isSymbolicLink(), false)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.deepEqual(snapshot(target), targetBefore)
})

test('linked skill: the IPC channels take only the link, target and fingerprint shown, re-checked by the backend', async () => {
  const { home, target, link } = linkedHome()
  confirmGlobalPath(home, 'claude', join(home, '.claude'))
  const h = globalHandlers(home)
  const listing = (await h.globalImportables()) as GlobalResult<GlobalImportListing>
  assert.ok(listing.ok)
  const c = confirmOf(listing.value.linked[0])
  const code = (r: unknown): string | null => {
    const x = r as GlobalResult<unknown>
    return x.ok ? null : x.code
  }
  /** Calls a handler; its body runs synchronously inside the spy, only its result is awaited */
  const spied = async (fn: () => Promise<unknown>): Promise<{ r: unknown; calls: FsCall[] }> => {
    const pending = fsCalls(fn)
    return { r: await pending.value, calls: pending.calls }
  }
  const digest = dirContentHash(target)
  // Malformed requests and requests with keys outside each channel's contract are refused before anything is read
  const refused: [string, () => Promise<unknown>][] = [
    ['preview: not a list', () => h.globalLinkedPreview({})],
    ['preview: wrong type', () => h.globalLinkedPreview([{ ...c, linkFingerprint: 5 }])],
    ['preview: allowLinks', () => h.globalLinkedPreview([{ ...c, allowLinks: true }])],
    [
      'preview: allowLinks and another target',
      () => h.globalLinkedPreview([{ ...c, allowLinks: true, targetPath: join(home, 'elsewhere') }])
    ],
    ['preview: import-only key', () => h.globalLinkedPreview([{ ...c, sourceDigest: digest }])],
    ['import: digest missing', () => h.globalLinkedImport([c])],
    [
      'import: allowLinks',
      () => h.globalLinkedImport([{ ...c, sourceDigest: digest, allowLinks: true }])
    ],
    [
      'import: linkTarget',
      () => h.globalLinkedImport([{ ...c, sourceDigest: digest, linkTarget: target }])
    ]
  ]
  for (const [what, fn] of refused) {
    const { r, calls } = await spied(fn)
    assert.equal(code(r), 'invalid', what)
    assert.deepEqual(contentAccess(calls, target), [], what)
  }
  assert.deepEqual(libEntries(home), [])
  const pv = (await h.globalLinkedPreview([c])) as GlobalResult<LinkedSkillPreviewResult>
  assert.ok(pv.ok)
  assert.deepEqual(
    pv.value.items.map((i) => i.targetPath),
    [target]
  )
  const im = (await h.globalLinkedImport([
    { ...c, sourceDigest: pv.value.items[0].sourceDigest }
  ])) as GlobalResult<GlobalImportResult>
  assert.ok(im.ok)
  assert.deepEqual(
    im.value.items.map((i) => [i.name, i.origin.path, i.origin.linkTarget]),
    [['caveman', link, target]]
  )
})
