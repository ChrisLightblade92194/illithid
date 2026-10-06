# Project Census Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, read-only Windows census of selected projects' local rules and complete skill trees, with exact-content and same-name comparisons.

**Architecture:** A dedicated engine discovers candidates and produces immutable inventory observations. A main-process service holds discovery/run identities, controls asynchronous reads and exposes narrow IPC requests. A separate Windows renderer view presents selection, progress, groups and bounded comparison details without entering the global import/delivery pipeline.

**Tech Stack:** Existing Node.js 22+, TypeScript, Electron, React/Mantine, Node test runner through `tsx`, Playwright Electron tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-project-census-design.md`. Read the entire approved spec before this plan.

## Global Constraints

- Windows census v1 only. Global delivery and the published release remain the baseline.
- Candidates are the root itself and its immediate child folders. Discovery does not recurse into grandchildren or require Git, manifests, or an agent configuration file.
- Nothing is preselected. Only confirmed candidates are scanned. Unselected project contents are not read.
- Implement exactly the spec's path table. Recursive reads occur only inside recognized rules/skill trees; do not search arbitrary project sources.
- Rules compare exact file bytes. Skills compare complete manifests including every resource, hidden entry and `.DS_Store`. No semantic comparison or normalization.
- Read limits: 64 MiB per file, 256 MiB total bytes and 10,000 entries per skill, 64 levels inside a recognized tree. Use binary MiB. The tree root has depth zero and is not counted among its entries; exceeding a limit makes the whole affected skill incomplete.
- Do not follow links or junctions at any covered position, including ancestors. Preserve the published Windows restrictions on local/network/device paths and explain unsupported cases.
- Do not import, copy, write, execute, merge or delete project content. No catalog persistence, export, startup scan, watcher, saved selection or project synchronization.
- Use synthetic fixtures. Never scan real user projects or invoke authenticated agent CLIs for tests.
- Preserve unrelated changes and `.impeccable/hook.cache.json`. No stash/reset/clean, push, merge, PR, release, installer build or installation.
- The application source base is `80e8c24a14bfb5931aaf96d42631a77beb41ecd5`; the initial spec checkpoint is `09c2d378d194ffb7c1f28560ac89a87ca2d5723f`. Later planning commits must change documentation only before implementation.

## Review Focus

1. Spaces, non-ASCII names and Windows case behavior: candidates remain distinct, correctly bound and deterministically ordered. Task 1 tests this.
2. A project/ancestor replaced after discovery, including identical contents: validation refuses it before configuration reads. Tasks 1 and 2 test this.
3. Shared paths and reordered filesystem listings: one physical source has several potential consumers; manifest equality remains stable and includes resources. Task 2 tests this.
4. A rule changed after census but before detail inspection: details refuse stale content rather than mixing snapshots. Task 3 tests this.
5. Replies arriving after Cancel, selection change or navigation: neither old results nor old selections become visible again. Tasks 3 and 4 test this.

## File map and fixed contracts

- `src/engine/census/types.ts`: Node-free public views and engine contracts.
- `src/engine/census/paths.ts`: local-path checks, identity bindings and metadata-only candidate discovery.
- `src/engine/census/scan.ts`: asynchronous bounded reads, full manifests, coverage and incomplete outcomes.
- `src/engine/census/compare.ts`: pure grouping and skill manifest comparison.
- `src/main/censusIpc.ts`: one in-memory discovery and current run, strict request validation, cancellation and detail inspection.
- `src/shared/api.ts`, `src/main/ipc.ts`, `src/main/releaseScope.ts`: typed channels, handler registration and Windows allowlist. Preload derives invoke methods from `CHANNELS`; change it only if a demonstrated need remains.
- `src/renderer/src/windows/CensusView.tsx`, `CensusDetails.tsx`: census flow and read-only details. `WindowsApp.tsx` adds navigation and hides global Import/Apply controls in this view.
- `scripts/project-census-paths.test.ts`, `project-census-scan.test.ts`, `project-census-compare.test.ts`, `project-census-ipc.test.ts`, `windows-project-census.ui.test.ts`: meaningful engine, IPC and UI tests. `scripts/lib/censusFixture.ts` owns synthetic project/observer helpers.
- `package.json`: append the new UI file to the existing serial `test:windows` command. Unit files are discovered automatically by `scripts/run-unit-tests.ts`.
- `README.md`, `docs/windows-verification.md`: coverage, exclusions and measured results after the feature gate.

Define these contracts in Task 1 and use their names consistently:

- `CensusCandidate`: `id`, `path`, `name`, `isRoot`, `status` (`available | linked | unreadable | unsupported`), optional `reason` and `linkText`.
- `CensusDiscovery`: `id`, `root`, `candidates: CensusCandidate[]`.
- `DiscoveryHandle`: `view: CensusDiscovery`, `bindings: ReadonlyMap<string, CandidateBinding>`. `CandidateBinding` holds the path and identity fingerprints needed to recheck its ancestor chain. Bindings stay in main/engine and are not returned to the renderer.
- `CensusEntry`: `path` (slash-separated relative path), `kind` (`dir | file`), and for files `bytes`, `digest`. Canonical ordering is an ordinal sort by relative path; comparison is independent of enumeration order.
- `CensusItem`: `id`, `projectId`, `kind` (`rule | skill`), `name`, `relativePath`, `consumers` (existing Claude/Codex/OpenCode tool IDs), `outcome` (`complete | linked | unreadable | changed | unsupported | limitExceeded`), optional `reason`, `digest`, `manifest`. Only complete items have a comparable digest. Skill manifests include directories; their outer folder name is excluded.
- `CensusGroup`: `id`, `kind`, `itemIds`. A result has `equalGroups`, `sameNameDifferences` (same-name items with different complete digests), and `uniqueItemIds`.
- `CensusSnapshot`: `root`, `startedAt`, `finishedAt`, `projects` (candidate ID/path, complete-item counts, incomplete count, empty-covered-paths status), `items`, and the three grouping collections above. Include coverage labels so absence/uniqueness is scoped to inspected paths.
- `CensusProgress`: project/item counts completed so far and the current relative path. Do not invent a reliable percentage before total work is known.
- `CensusRunView`: `runId`, `status` (`running | completed | cancelled | failed`), `progress`, optional completed `snapshot` or failure `reason`.
- `CensusDetails`: discriminated `kind`. Rules contain two bounded text previews with explicit truncation/encoding indications; skills contain changed/added/removed manifest paths. Details use inventory item IDs, never caller-supplied file paths.

Public API methods all return the existing `GlobalResult<T>` envelope:

| Channel          | Exact request keys                                   | Success value                            |
| ---------------- | ---------------------------------------------------- | ---------------------------------------- |
| `censusDiscover` | `root: string`                                       | `CensusDiscovery`                        |
| `censusStart`    | `discoveryId: string`, `candidateIds: string[]`      | `{ runId: string }`                      |
| `censusPoll`     | `runId: string`                                      | `CensusRunView`                          |
| `censusCancel`   | `runId: string`                                      | `{ runId: string, status: 'cancelled' }` |
| `censusInspect`  | `runId: string`, `leftId: string`, `rightId: string` | `CensusDetails`                          |

Add `CENSUS_CHANNELS` separately from `GLOBAL_CHANNELS`, then include it in `CHANNELS` and the Windows allowlist. Unknown keys, wrong types, duplicate selections, invalid IDs and empty start selections return `invalid` before configuration reads. Unknown/superseded handles return `stale`; a changed binding returns `projectChanged`; a changed inspected rule returns `changedSinceCensus`. IDs correlate backend objects; do not present them as an authenticated security boundary.

## Task 1: Candidate discovery and its read boundary

**Files:** Create `types.ts`, `paths.ts`, `scripts/lib/censusFixture.ts`, `scripts/project-census-paths.test.ts` from the map above.

**Interfaces:** Produce `discoverProjects(root: string): Promise<DiscoveryHandle>` and `validateSelection(discovery: DiscoveryHandle, candidateIds: readonly string[]): Promise<CensusCandidate[]>`. Validation permits only bound available candidates and checks their ancestors/identity again. Invalid input rejects before configuration reads. The engine remains testable with platform-local temporary paths; production census IPC is Windows-only.

- [ ] **Write failing tests.** Fixtures include a root with two non-Git children, a grandchild, spaces/non-ASCII names, a linked child and a child with an injected metadata-read failure. Assert `assert.deepEqual(discovery.view.candidates.map(c => c.isRoot), [true, false, false, false, false])`; assert the grandchild is absent and candidate order is stable. A positive-control read must trigger the observer, then discovery/invalid selection/replaced candidate must produce zero content reads and zero descendant enumeration. Recreate a junction/project to identical contents and require rejection. Windows-specific junction proofs run on Windows and are explicitly skipped elsewhere.
- [ ] **Run the red tests:** `npm.cmd run test:unit -- scripts/project-census-paths.test.ts`. Record exit code and the missing-behavior assertion. Do not treat a broken fixture/observer as proof.
- [ ] **Implement the interfaces** in `paths.ts`, and view/contracts in `types.ts`. Use `lstat`-style checks; inspect linked entries' stored text without resolving targets. Absolute local roots only. Keep identity bindings private and reject linked ancestors. Do not create a library or inspect configuration files.
- [ ] **Run green tests** with the same command. Verify fixture tree signatures remain unchanged and observed reads actually cover every filesystem API used, including `fs/promises` if used. Positive controls must observe production discovery's root enumeration, not merely a filesystem call made directly by the test.
- [ ] **Commit only Task 1 files:** `feat(census): discover manually selected project candidates`.

## Task 2: Bounded inventory and exact comparison

**Files:** Create `scan.ts`, `compare.ts`, `scripts/project-census-scan.test.ts`, `scripts/project-census-compare.test.ts`. Extend Task 1 contracts/helpers as needed without changing signatures.

**Interfaces:** Consume Task 1's handles/validation. Produce `scanProjects(discovery: DiscoveryHandle, candidateIds: readonly string[], options: { signal: AbortSignal; onProgress: (progress: CensusProgress) => void }): Promise<CensusSnapshot>`, `groupItems(items: readonly CensusItem[]): Pick<CensusSnapshot, 'equalGroups' | 'sameNameDifferences' | 'uniqueItemIds'>`, and `diffManifests(left: readonly CensusEntry[], right: readonly CensusEntry[]): { added: string[]; removed: string[]; changed: string[] }`.

- [ ] **Write failing tests.** Cover every spec path, shared-consumer deduplication, a selected root and child, unselected projects, and an arbitrary nested `src/AGENTS.md` that is not read. Assert same rule bytes under different names group together; CRLF versus LF differs; same skill name/resource change differs; identical skill trees under different outer names group together. Assert adding an empty directory, hidden resource or `.DS_Store/payload.bin` changes the manifest. Assert reversed enumeration leaves equality unchanged. Incomplete items never receive a digest or enter comparable groups.
- [ ] **Add boundary/cancellation tests.** Links in containers, ancestors, rules and resource trees must be reported with no target read. First show that the observer catches a real successful production scan's configuration/resource reads through the same IO route; a direct test-module read is not sufficient. A replaced project is refused before scan reads. Unreadable resources make the whole skill incomplete; other successful items survive. Check each spec limit at/above its exact threshold using stat/test seams or sparse files to avoid allocating huge fixtures. An aborted signal prevents the next queued read. Before/after signatures cover fixtures plus synthetic global tool/library/delivery state.
- [ ] **Run red tests:** `npm.cmd run test:unit -- scripts/project-census-scan.test.ts scripts/project-census-compare.test.ts`.
- [ ] **Implement the interfaces.** Use asynchronous file IO and incremental hashing; do not run a synchronous whole-tree scan in Electron main. Record sorted path/kind/length/file-digest manifests. Grouping digests use an unambiguous manifest serialization; equality checks matching complete manifests. Register shared physical sources once with multiple consumer labels. Report incomplete coverage rather than comparing a truncated tree. Attach rejection handling before starting concurrent work; default to sequential reads for predictable cancellation.
- [ ] **Run green tests** with the same command. Recheck no configuration/library writes and no import-pipeline calls. Commit only Task 2 files: `feat(census): inventory and compare complete local configuration`.

## Task 3: Session-local IPC runs, cancellation and details

**Files:** Create `src/main/censusIpc.ts`, `scripts/project-census-ipc.test.ts`. Modify `src/shared/api.ts`, `src/main/ipc.ts`, `src/main/releaseScope.ts`; extend the existing Windows release fixture's allowlist assertions.

**Interfaces:** Produce `censusHandlers(platform: NodeJS.Platform = process.platform): Record<(typeof CENSUS_CHANNELS)[number], (...args: unknown[]) => Promise<unknown>>`, implementing the channel table. Store one current discovery and one current run in the handler instance. Non-Windows census calls return `unsupportedPlatform` without filesystem access. Register through the existing `releaseHandlers` path; expose real filtered handlers to tests only through the existing `ILLITHID_TEST=1` seam.

- [ ] **Write failing IPC tests.** Exercise every exact request shape and refusal code, including `allowLinks`, arbitrary paths, copied IDs, duplicate IDs, empty selections and unknown fields. Assert no configuration reads before validated start and no filesystem access in non-Windows handlers. Hold a scan reply, cancel/start another run, release the old reply, and assert polling the superseded run cannot expose its snapshot. An asynchronous scanner failure becomes a failed run without an unhandled rejection.
- [ ] **Add inspection tests.** Only completed current-run item IDs of the same kind are accepted. Rule inspection revalidates identity and full content digest; editing a rule after census yields `changedSinceCensus`. Skill details compare cached manifests without reading/executing resources. Rule previews show at most 200 KiB per side, marked truncated when larger; comparison still covers the full allowed file. Unknown encoding is labelled rather than presented as an exact decoded diff.
- [ ] **Run red tests:** `npm.cmd run test:unit -- scripts/project-census-ipc.test.ts`; run the modified release fixture with `npm.cmd run test:windows-release` after its required build.
- [ ] **Implement the handlers and registration.** Keep discovery bindings and source paths on the backend. Start returns a run ID promptly; poll returns progress and completed metadata, not growing file content. Cancel marks the run terminal, signals the scanner and discards late completion. New discovery/start invalidates older runs and inspectors. Catch failures inside the job promise. Inspect rules through the bound source and return only bounded display text. Do not enable deferred channels or any startup task.
- [ ] **Run green tests** and `npm.cmd run typecheck`. Confirm preload invoke methods derive from `CHANNELS`. Commit only Task 3 files: `feat(census): expose validated cancellable census runs`.

## Task 4: Windows census view and feature gate

**Files:** Create `CensusView.tsx`, `CensusDetails.tsx`, `scripts/windows-project-census.ui.test.ts`. Modify `WindowsApp.tsx`, `package.json`, `README.md`, `docs/windows-verification.md`.

**Interfaces:** Consume the exact API/channel table. Produce `CensusView(): React.JSX.Element` and `CensusDetails(props: { details: CensusDetails; onClose: () => void }): React.JSX.Element` (alias the imported view type if needed to avoid the component/type name collision).

- [ ] **Write failing Electron tests.** Use synthetic HOME/user-data/project roots and the real registered main handlers. Test navigation, picker-root reply, no preselection, exact backend-selected IDs, one-level candidates, coverage/counts, project/kind/consumer/category filters, duplicate groups, same-name differences, rule text pairs and resource manifest differences. Assert census navigation exposes no global Import/Apply actions and performs no library mutation.
- [ ] **Add late-reply tests.** Hold discover/poll/inspect replies using the existing main handler test seam. Cancel, change selection/root, start a newer run or navigate away before releasing them. Assert no obsolete candidates, results or detail panels appear. Backend cancellation receives the previous run ID. Tests must observe actual IPC arguments, not only checkbox state.
- [ ] **Run red tests** after build: `npm.cmd run build` then `node_modules\.bin\tsx.cmd --test --test-concurrency=1 scripts/windows-project-census.ui.test.ts`. Record the behavioral failure.
- [ ] **Implement the view.** Reuse the picker and Mantine conventions. Add `census` navigation; expose the global import/apply controls only on the existing appropriate global views. Use a request generation and serial 250 ms polling while a run is active. Stop polling on terminal status/unmount and discard superseded replies. Clear stale results on root/selection changes. Display errors/incomplete coverage distinctly from empty configuration; show full paths in details without loading unselected content.
- [ ] **Update gate and documentation.** Append `scripts/windows-project-census.ui.test.ts` to the existing serial UI invocation in `test:windows`. Explain static coverage and session-local results. Record actual commands, counts, skips, warnings and limitations; do not predict new totals or claim agent consumption from census evidence.
- [ ] **Run targeted green UI tests**, then `npm.cmd run test:windows`, `npm.cmd test`, `npm.cmd run lint`, Prettier check on changed files and `git diff --check`. Exit 0 and passing assertions are required; report skips and warnings. Do not repeat a green gate without a subsequent change/failure justifying it.
- [ ] **Commit only feature/documentation files:** `feat(windows): present a read-only project configuration census`. Preserve the unrelated hook cache.

## Handoff and stop condition

Recommended execution: one implementer runs the four dependent tasks sequentially, with a commit after each passing deliverable. Recommended available model: `gpt-6.1-sol`, reasoning `high`, for filesystem/IPC/UI integration. A separate whole-checkpoint review follows; do not create fresh workers and reviewers for every step by default.

This plan contains intended tests and commands; none have been executed by the planner. The current checkpoint changes documentation only. The user reviews the plan before implementation. The accompanying prompt is the handoff text to use after that review.

Stop at a local reviewable branch with commits and a measured gate report. Report the exact HEAD, base, changed files, exit codes, test totals, warnings, skipped tests, remaining limits and dirty/untracked attribution. No push, merge, PR, release, installer build, installation or real-profile scan.
