# Windows project import and delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the recommended single-implementer execution. Use superpowers:subagent-driven-development only if the user chooses that method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import selected complete census occurrences into the existing library and manually deliver selected variants to selected project/tool destinations, with preview, verified backup and restore.

**Architecture:** Keep the census read-only and expose its completed bindings to a separate import coordinator inside the main process. Add a project delivery subsystem with its own plans, deliveries and operation records under the existing state directory; share the existing exclusive apply lock and check ownership overlap in both scopes. Ship an independently usable import tranche before adding delivery; preserve the global flow and legacy records.

**Tech stack:** Existing TypeScript, Node filesystem APIs, React/Mantine, Electron IPC, `node:test` through `tsx`, and Playwright/Electron fixtures. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-project-delivery-design.md`, approved by the user on 2026-10-06. Source/design base: `f018049faf6d4ec5385c1db8475c5c688e70e444`; application base: `5abf40796c7737f132230f52e3a4395247e41983`.

## Global constraints

- Windows only; reject the new channels on other platforms before filesystem access.
- Root plus immediate folders; one destination root per preview/operation; project roots must already exist.
- Whole rule bytes and whole skill folders, including resources and empty directories; no partial skill transfer.
- No preselected imports or recipients; subsets and per-project tool overrides belong in v1.
- Absent content can be created; identical content needs no write; differing content is skipped by default and can be replaced explicitly with backup.
- Preserve the source, encoding, line endings, frontmatter and references. No reference expansion, semantic conversion, composition or script execution.
- Keep global managed sections and legacy state compatible; project rules use whole files.
- Use `CENSUS_LIMITS`: one file 64 MiB, one skill 256 MiB, 10,000 skill entries, depth 64. An incomplete observation is never comparable or deliverable.
- Every copied entry participates in verification, including hidden entries and `.DS_Store`. Census manifest digests and library `fullTree-v1` digests are distinct contracts.
- No link traversal, arbitrary renderer paths, automatic sync/replay, real-project probes, paid external review, installer generation, installation, push, PR, merge or release.
- Preserve `.impeccable/hook.cache.json` and other sessions' files. Do not use stash, reset or clean.

## Review focus

1. A variant with only project provenance must remain usable in the existing global library and delivery UI, without inventing a `tool` owner. Test in Tasks 1 and 3.
2. A global section inside a project instruction file, or a project delivery inside a confirmed global root, must block ownership overlap in either direction. Test in Tasks 5 and 6.
3. Case-sensitive folders, hard-link aliases and case-only path spellings must not cause duplicate or incorrectly merged writes. Test in Tasks 4 and 5; refuse ambiguous aliases.
4. Cancel or a new census while an import is reading must stop queued work without discarding variants already registered. Test in Tasks 2, 3 and 7.
5. A crash between writing bytes and recording ownership must produce an uncertain/interrupted result and an inspectable backup, without startup replay or a false success. Test in Tasks 6 and 7.

## File structure and interface decisions

Create `src/engine/project/types.ts` for Node-free public contracts and trusted backend-only structures. Create `content.ts`, `import.ts`, `destinations.ts`, `state.ts`, `ownership.ts`, `plan.ts`, `operations.ts` and `restore.ts` in that folder, with the responsibilities in the tasks below. Export only public view types through `src/shared/api.ts`; backend bindings never enter IPC results.

Create `src/main/censusSession.ts` for the existing census session/binding lifecycle and `src/main/projectIpc.ts` for project jobs and exact request validation. Existing `censusHandlers()` remains a compatibility wrapper so the census tests and channel signatures stay valid. `src/main/ipc.ts` constructs one census service and supplies its access object to the project handlers.

Create `ProjectImportDialog.tsx`, `ProjectDeliveryDialog.tsx`, `ProjectPreviewDialog.tsx` and `ProjectOperationsView.tsx` under `src/renderer/src/windows/`. Modify `CensusView.tsx`, `LibraryView.tsx`, `globalUi.ts`, `WindowsApp.tsx` and, where needed for scope navigation, `OperationsView.tsx`. Do not restructure unrelated upstream UI.

Tests live in `scripts/project-*.test.ts` and `scripts/windows-project-delivery.ui.test.ts`. Extend `scripts/lib/censusFixture.ts` only when an existing observer misses a filesystem API used by the new code. Add `scripts/lib/projectFixture.ts` for synthetic projects, library variants and operation failure injection. Retain actual filesystem observations; mocks alone do not prove no-follow behavior.

Contract names used throughout the plan:

- `ProjectOrigin`: `scope:'project'`, `projectRoot`, `relativePath`, absolute source `path`, `consumers:GlobalTool[]`, `importedAt`, `digest`, `digestAlgorithm:'sha256-v1'|'census-skill-v1'`. Do not serialize `tool` or `linkTarget` on this origin.
- `VariantOrigin`: a union of the unchanged legacy global origin and `ProjectOrigin`; legacy absence of scope means global. Add `tool?:never` to the project type if needed to retain source compatibility for existing comparisons; renderer labels must narrow on scope. Global import results retain a specifically global origin type.
- `BoundCensusItem`: `{item:CensusItem, project:CandidateBinding}`. `CensusImportLease`: `{items:readonly BoundCensusItem[], signal:AbortSignal, assertCurrent():void}`. These are main-process/engine inputs, never renderer capabilities or an authentication claim.
- `CensusImportAccess`: `{acquireImport(runId:string,itemIds:readonly string[]):CensusImportLease}`; `createCensusService().access` implements it. `ProjectContentObservation`: `{sourcePath,project,relativePath,kind,identities:PathIdentity[],manifest?:CensusEntry[],bytes:number,censusDigest:string,censusAlgorithm:'sha256-v1'|'census-skill-v1',revision:string,revisionAlgorithm:'sha256-v1'|'fullTree-v1'}`. The copy result describes the verified copied path; preserve the source binding separately for the final source recheck.
- `ProjectDestinationObservation`: `{destination,project,kind,shape:'absent'|'file'|'dir',digest:string|null,digestAlgorithm:'sha256-v1'|'fullTree-v1',identities:PathIdentity[],physicalKey:string,existingAncestor:PathIdentity,localSlots}`. Unsupported entries throw a typed error with a reason; `localSlots` records supported instruction-file path, presence, link status and documented precedence note without reading its text. `ScopeOverlap`: `{scope:'global'|'project',destination:string,recordId:string,reason:string}`.
- `ProjectSelection`: `{candidateId:string, variantId:string, tool:GlobalTool, slot:ProjectSlot}`. `ProjectSlot` is `{type:'default'}` or a supported rule slot: `claudeNested`, `claudeLocal`, `claudeNamedRule` with validated relative `name`, `codexOverride`, `opencodeClaude`. Exact nested keys are required; skill selections accept only `default`.
- `ProjectPlanView`: `{id,kind:'sync'|'restore',createdAt,changes,collisions,excluded}`. Each change has a backend `destinationId`, absolute display path, project label, recipient labels, incoming variants, before/after digest, observed ownership, preview and action. `ProjectStoredPlan` additionally holds all backend bindings and a complete fingerprint; callers cannot construct it through IPC.
- In `ProjectPlanView`, `changes:ProjectPlanChange[]`, `collisions:{destinationId:string,variantIds:string[]}[]`, and `excluded:{selection:ProjectSelection,reason:string}[]`. `ProjectPlanChange` contains `destinationId:string`, `destination:string`, `project:{id:string,path:string,name:string}`, `recipients:GlobalTool[]`, `incoming:{variantId:string,variantRevision:string,kind:GlobalKind,name:string}[]`, `selectedVariantId:string|null`, `beforeDigest:string|null`, `afterDigest:string|null`, `owner:ProjectDeliveryRecord|null`, `preview:GlobalChange['preview']`, and `action:'create'|'unchanged'|'skip'|'replace'|'restore'`. A collision is not an authorization to write any incoming variant.
- `ProjectDecision`: sync decisions `{destinationId,variantId:string|null,action:'create'|'unchanged'|'skip'|'replace'}`; restore decisions `{destinationId,action:'restore'|'skip'}`. Reject actions inconsistent with the observed state, unknown variants and duplicate destination IDs.
- `ProjectDeliveryRecord`: `version:1`, `id`, `scope:'project'`, project binding, physical target binding, `destination`, `kind`, `recipients:GlobalTool[]`, `variantId`, `variantRevision`, `deliveredDigest`, `operationId`, `at`.
- `ProjectOperationRecord`: `version:1`, `scope:'project'`, `id`, `planId`, `kind`, `pid`, timestamps, overall status and per-destination results. Results contain phase, before/after digest, backup reference, previous ownership, created-directory bindings, outcome and reason. Include `interrupted` and `uncertain` display states; persist phase transitions, not file contents in JSON.
- `ProjectJobView`: `{id,kind:'import'|'apply',status:'running'|'completed'|'cancelled'|'failed',progress,result?}`; `ProjectImportResult` holds per-item `imported|refused|failed|notAttempted` outcomes and registered variant IDs. Apply results are the corresponding operation view. Cancellation can report already completed work.
- `ProjectContext`: `{home:string,signal:AbortSignal}`. Public asynchronous engine functions take this context; tests can supply deterministic phase hooks to hold a boundary or inject failure. Do not expose hooks over IPC.
- `ProjectOperationView` is the persisted record with overall status additionally allowing `interrupted`; item results additionally allow `uncertain`. `ProjectPhaseHooks` has optional `afterBackup`, `afterWrite`, `afterRecord`, each `(record:ProjectOperationRecord,index:number)=>void|Promise<void>`. Per-item operation results use `status` and optional `code` consistently with the existing global result naming; an overall refusal also contains its refused item result.

## Task 1: Complete-content reader and compatible provenance

**Files:** Create `src/engine/project/types.ts`, `content.ts`, `scripts/project-content.test.ts`, `scripts/project-provenance.test.ts`, `scripts/lib/projectFixture.ts`. Modify `src/engine/census/scan.ts` only to extract reusable single-item observation, `globalImport.ts`, `globalVariants.ts`, `windows/globalUi.ts` and origin rendering in `LibraryView.tsx`.

**Interfaces:** `observeProjectContent(project:CandidateBinding, relativePath:string, kind:GlobalKind, signal:AbortSignal):Promise<ProjectContentObservation>` returns identity chain, complete manifest for skills, census digest with algorithm, library-compatible revision with algorithm, and bytes. `copyProjectContent(observation:ProjectContentObservation, destination:string, signal:AbortSignal):Promise<ProjectContentObservation>` verifies source before/after copying and destination before returning. `originKey(origin:VariantOrigin):string` includes scope, path and digest format; it cannot equate project and global origins accidentally.

- [ ] **Write failing tests** `project_content_covers_every_entry`, `project_content_refuses_changed_or_linked_tree`, and `project_origin_coexists_with_legacy_origin`. Assertions: adding `assets/extra.txt`, an empty directory or `.DS_Store/payload.bin` changes the skill observation; copied bytes/manifest equal source; a junction and each small injected limit are refused; `assert.equal(projectOrigin.tool, undefined)`; legacy origin JSON is unchanged; equal variants remain separate until explicit merge.
      Assertion fragments within these synthetic tests:
  ```ts
  assert.notEqual(after.censusDigest, before.censusDigest)
  assert.deepEqual(copied.manifest, after.manifest)
  assert.equal(projectOrigin.tool, undefined)
  assert.deepEqual(legacyJsonAfter, legacyJsonBefore)
  ```
- [ ] **Run red:** `.\node_modules\.bin\tsx.cmd --test scripts/project-content.test.ts scripts/project-provenance.test.ts`. Record an assertion failure caused by missing behavior, not just a missing module. Build a minimal export scaffold if necessary to reach that assertion.
- [ ] **Implement the interfaces:** extract the existing bounded async file/tree observation rather than scanning all covered paths to recheck one item. Preserve `manifestKey()` and `census-skill-v1` serialization; compute the library full-tree revision separately. Keep exact copy and cleanup inside the allocated destination, never run source scripts. Narrow origin reads in global deduplication, merge keys and UI labels. Keep legacy globals readable without rewriting their files.
- [ ] **Run green:** the targeted tests, `scripts/project-census-scan.test.ts`, `scripts/global-import.test.ts`, `scripts/global-variants.test.ts`, then `npm.cmd run typecheck`. Require exit 0 and measured pass/skip totals.
- [ ] **Commit only this task's files:** `feat(projects): add verified content observations and project provenance`.

## Task 2: Import selected completed census items

**Files:** Create `src/engine/project/import.ts`, `src/main/censusSession.ts`, `scripts/project-import.test.ts`. Modify `src/main/censusIpc.ts` for session delegation while keeping all five census requests read-only and unchanged.

**Interfaces:** `createCensusService(platform?:NodeJS.Platform, scan?:typeof scanProjects)` returns `{handlers,access}`. `access.acquireImport(runId:string,itemIds:readonly string[]):CensusImportLease` resolves only complete items in the current completed snapshot, checks unique nonempty IDs before I/O, and throws stale when cancelled/superseded. `importProjectItems(ctx:ProjectContext,lease:CensusImportLease):Promise<ProjectImportResult>` writes verified variants into `globalLibraryDir(home)` using the existing `StoredVariant` layout.

- [ ] **Write failing tests** `import_reads_only_selected_occurrences`, `import_stales_after_source_or_run_change`, `import_cancel_keeps_only_registered_successes`. Assertions: import two selected IDs from three eligible occurrences; observer sees no import-time content reads of the third; original source snapshots match; same-name alternatives receive separate IDs; modified resource or replaced root refuses before registration; an injected cancellation after the first registration preserves exactly that variant and leaves no provisional second directory.
  ```ts
  assert.deepEqual(importedItemIds.sort(), selectedItemIds.sort())
  assert.equal(unselectedContentReads.length, 0)
  assert.deepEqual(sourceAfter, sourceBefore)
  assert.equal(registeredAfterCancellation.length, 1)
  assert.equal(provisionalDirectories.length, 0)
  ```
- [ ] **Run red:** `.\node_modules\.bin\tsx.cmd --test scripts/project-import.test.ts scripts/project-census-ipc.test.ts`. Attach rejection handlers immediately to held/concurrent operations; record the intended failing assertions.
- [ ] **Implement the interfaces:** resolve backend bindings without renderer paths; retain the run's abort signal/current-run assertion throughout imports and combine it with the import job cancellation signal. Recheck source identity/content at copy boundaries and just before registration. Allocate unique variant folders; register metadata last and remove unfinished folders on every exit. Save source role through relative path and consumers, without choosing a fake owner or importing referenced files.
- [ ] **Run green:** Task 2 tests plus Task 1 and existing census IPC tests. Exercise replacement with identical bytes, resource-only mutations and observer-held cancellation/new discovery/new census. Require exit 0 and no unhandled rejection.
- [ ] **Commit only this task's files:** `feat(projects): import selected census items into the library`.

## Task 3: Usable import flow, IPC jobs and first checkpoint

**Files:** Create `src/main/projectIpc.ts`, `ProjectImportDialog.tsx`, `scripts/project-ipc.test.ts`, `scripts/windows-project-delivery.ui.test.ts`. Modify `src/shared/api.ts`, `src/main/ipc.ts`, `src/main/releaseScope.ts`, `CensusView.tsx`, `LibraryView.tsx`, `WindowsApp.tsx`, `scripts/windows-release.fixture.ts`, `package.json`.

**Interfaces:** `projectHandlers(home:string,access:CensusImportAccess,platform?:NodeJS.Platform)` returns exact handlers. Initially add `projectImportStart({runId,itemIds}) -> {jobId}`, `projectPoll({jobId}) -> ProjectJobView`, `projectCancel({jobId}) -> ProjectJobView`. Wrap results in existing `GlobalResult<T>`. IDs and job state are backend-owned; a job's result remains pollable after cancellation so partial successes can be shown.

- [ ] **Write failing tests** `project_ipc_rejects_schema_widening`, `project_import_selection_reaches_backend`, `project_origin_can_use_global_delivery`. Assert extra keys, arbitrary paths, empty/duplicate/foreign IDs and non-Windows calls refuse before source I/O; no items are preselected; Select all covers eligible items only; a subset arrives at the actual handler; stale replies cannot restore selections/results. Import a project-only-origin skill and deliver it through the existing global UI to a synthetic global tool folder.
  ```ts
  assert.equal(widenedRequest.ok, false)
  assert.equal(nonWindows.code, 'unsupportedPlatform')
  assert.equal(refusedSourceReads.length, 0)
  assert.deepEqual(receivedItemIds, selectedItemIds)
  assert.deepEqual(deliveredSkillBytes, importedSkillBytes)
  ```
- [ ] **Run red:** targeted IPC tests; compile the unchanged UI with `npm.cmd run build`, then run `.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 scripts/windows-project-delivery.ui.test.ts`. Record a functional assertion failure, not a test setup failure.
- [ ] **Implement the interfaces and UI:** register the same census service once in `ipc.ts`; add `PROJECT_CHANNELS` to shared API and the Windows allowlist. Add explicit confirmation and per-item outcomes. Cancel/new selection/leaving the view invalidates renderer generations; do not navigate away and cancel the census before the confirmed import has resolved its source lease. Reuse the existing frozen `window.api`/main-handler test pattern; expose no production test controls.
- [ ] **Run green:** new targeted tests, the release fixture and existing global/census Electron flows. Add the new UI test file explicitly to `test:windows`; unit files are already discovered by `scripts/run-unit-tests.ts`. Run `npm.cmd run test:windows` for this independently usable import checkpoint.
- [ ] **Commit only this task's files:** `feat(windows): add selected project import flow`. Record the checkpoint SHA, measured counts, skips and remaining delivery scope in the progress log; continue with Task 4 without publishing or installing.

## Task 4: Destination conventions and identity-aware ownership

**Files:** Create `src/engine/project/destinations.ts`, `state.ts`, `ownership.ts`, `scripts/project-destinations.test.ts`, `scripts/project-state.test.ts`. Modify `globalVariants.ts` only for active project references in explicit library merges; retain the global deliveries format.

**Interfaces:** `resolveProjectDestination(project:CandidateBinding,kind:GlobalKind,name:string,tool:GlobalTool,slot:ProjectSlot):string` implements the spec table and alternatives. `inspectProjectDestination(ctx:ProjectContext,project:CandidateBinding,destination:string,kind:GlobalKind):Promise<ProjectDestinationObservation>` returns complete digest, identity/nearest-existing-parent binding, native slot and supported local alternative-slot metadata. `readProjectDeliveries(home:string):ProjectDeliveryRecord[]`, `writeProjectDeliveries(home:string,records:ProjectDeliveryRecord[]):void`, `forgetProjectDelivery(home:string,id:string):void` operate on `<globalStateDir>/project/deliveries.json`. `findScopeOverlap(home:string,destination:string,scope:'global'|'project'):ScopeOverlap|null` checks file/section/container overlap and observed identity in both scopes. This guard reads state and lightweight path metadata synchronously so existing synchronous global apply signatures remain compatible; complete project content reads/copies stay asynchronous.

- [ ] **Write failing tests** `project_slots_are_native_and_bounded`, `project_identity_does_not_lowercase_distinct_folders`, `project_ownership_is_separate_and_bidirectional`. Assert defaults: Claude `CLAUDE.md` and `.claude/skills/caveman`; Codex `AGENTS.md` and `.agents/skills/caveman`; OpenCode `AGENTS.md` and `.opencode/skills/caveman`. Exercise every alternative slot and reject cross-tool slots, traversal, invalid Windows names and extra nested keys. On native case-sensitive fixtures distinguish two physical folders; refuse ambiguous hard-link/case aliases. Existing global state bytes do not change when reading/writing project state.
  ```ts
  assert.equal(codexSkillPath, join(projectB, '.agents', 'skills', 'caveman'))
  assert.equal(codexRulePath, openCodeRulePath)
  assert.notEqual(caseSensitiveA.physicalKey, caseSensitiveB.physicalKey)
  assert.deepEqual(globalStateAfter, globalStateBefore)
  ```
- [ ] **Run red:** `.\node_modules\.bin\tsx.cmd --test scripts/project-destinations.test.ts scripts/project-state.test.ts`. Native feature unavailability must be an explicit skip with reason, never a claimed pass.
- [ ] **Implement the interfaces:** store project plans, operations and backups under `<globalStateDir>/project/`, using the existing lock path. Bind existing entries by actual identity and absent slots by checked existing ancestor plus validated native path. Never equate distinct entries through lowercasing alone. Expose local precedence notes without resolving effective agent context. Include project-managed variants in merge `inUse` checks; mixed provenance still supports explicit equal-content merge when not managed.
- [ ] **Run green:** targeted tests plus existing global variants/plan/restore tests. Test a global managed section inside the intended project `AGENTS.md` and a global folder target overlapping a project skill; test the reversed ownership direction as well.
- [ ] **Commit only this task's files:** `feat(projects): bind native destinations and scoped ownership`.

## Task 5: Concrete project delivery and restore decision plans

**Files:** Create `src/engine/project/plan.ts`, `scripts/project-plan.test.ts`. Modify shared project types and `globalManualSync.ts`/`globalRestore.ts` only to reject project ownership overlaps at preview and execution boundaries; do not change global defaults, sections or digest behavior.

**Interfaces:** `planProjectDelivery(ctx:ProjectContext,discovery:DiscoveryHandle,selections:readonly ProjectSelection[]):Promise<ProjectPlanView>`. `decideProjectPlan(ctx:ProjectContext,planId:string,decisions:readonly ProjectDecision[]):Promise<ProjectPlanView>` returns a newly bound plan and invalidates the old plan. `readProjectPlan(home:string,planId:string):ProjectStoredPlan|null` validates ID, stored schema and fingerprint. `discardProjectPlan(home:string,planId:string):void` consumes its capability without writing recipient content.

- [ ] **Write failing tests** `project_plan_defaults_to_skip`, `shared_agents_is_one_physical_change`, `incoming_collision_requires_choice`, `project_plan_rejects_stale_or_widened_decisions`. Assertions: absent -> Create; equal -> Unchanged with no adoption; different -> Skip even when previously managed. Two equal Codex/OpenCode requests for B/`AGENTS.md` yield exactly one change with both labels; differing variants yield an unresolved collision and no applicable write until explicit choice. Duplicate logical selections fail; distinct tool selections sharing a slot do not fail as duplicates.
  ```ts
  assert.equal(different.changes[0].action, 'skip')
  assert.equal(shared.changes.length, 1)
  assert.deepEqual(shared.changes[0].recipients.sort(), ['codex', 'opencode'])
  assert.equal(conflicting.collisions.length, 1)
  assert.equal(recipientWrites.length, 0)
  ```
- [ ] **Run red:** `.\node_modules\.bin\tsx.cmd --test scripts/project-plan.test.ts`. Also assert no recipient writes/directories during preview, no unselected project content reads, and refusal of corrupt variant metadata pointing outside the library.
- [ ] **Implement the interfaces:** validate all IDs and selections before content I/O. Bind selected variant kind/name/revision, destination/project chains, source and expected destination digests, observed ownership, labels and decisions in a canonical fingerprint. Produce bounded rule previews and complete skill manifest comparisons. Resolve physical collisions before applying choices; preserve one final content/write/backup per actual destination. Add symmetric ownership refusal to global preview/apply/restore, under the shared lock when writing.
- [ ] **Run green:** targeted plan/state/destination tests and existing global plan/apply/restore tests. After preview rename/change a variant, replace a root/ancestor, modify destination bytes, forget ownership or replace its record; every dependent plan must refuse instead of using new content silently. Preview omissions must leave omitted item/project/tool combinations out of the writes.
- [ ] **Commit only this task's files:** `feat(projects): preview explicit delivery decisions and collisions`.

## Task 6: Durable apply, honest partial results and restore

**Files:** Create `src/engine/project/operations.ts`, `restore.ts`, `scripts/project-apply.test.ts`, `scripts/project-restore.test.ts`, `scripts/lib/projectApplyChild.ts`. Extend project state/types and existing primitives only where a compatible extraction avoids duplication; no broad global-engine rewrite.

**Interfaces:** `applyProjectPlan(ctx:ProjectContext,planId:string,hooks?:ProjectPhaseHooks):Promise<ProjectOperationRecord>` handles sync and restore plans. `listProjectOperations(home:string):ProjectOperationView[]` marks non-live records interrupted and retains uncertain item outcomes. `planProjectRestore(ctx:ProjectContext,operationId:string):Promise<ProjectPlanView>` verifies backup and expected delivered/current ownership before proposing restoration. Phase hooks target `afterBackup`, `afterWrite` and `afterRecord` and are backend/test-only.

- [ ] **Write failing tests** `project_apply_backs_up_before_writing`, `project_apply_and_global_apply_share_lock`, `project_apply_reports_partial_cancel_and_crash`, `project_restore_preserves_edits_and_ownership`. Observe before/after bytes and actual backup manifests. Hold the lock in a real child process and assert the other scope refuses. Kill a synthetic child after a persisted backup/write boundary; assert interrupted/uncertain, intact backup and no replay on operation listing. Assert a backup failure causes zero destination writes, and failure after the first write leaves later destinations Not attempted.
  ```ts
  assert.equal(writesAfterFailedBackup.length, 0)
  assert.equal(busy.results[0].code, 'applyInProgress')
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(startupRecipientWrites.length, 0)
  assert.deepEqual(restoredBytes, originalBytes)
  assert.deepEqual(restoredOwnership, previousOwnership)
  ```
- [ ] **Run red:** `.\node_modules\.bin\tsx.cmd --test scripts/project-apply.test.ts scripts/project-restore.test.ts`. Record expected behavioral failures and child exit statuses; no real profiles or projects.
- [ ] **Implement apply:** use `acquireApplyLock(home,operationId)` without lock deletion/takeover. Consume a valid one-shot plan; persist operation state before writes and each phase. For each change recheck binding/source/destination/ownership, create and verify a complete backup, flush copied backup file data before durable metadata publication, recheck again, then replace using a verified staged file/tree and record verified final bytes and ownership. Implement bounded async operations, or a dedicated worker that can observe cancellation, so the main process remains responsive. Do not call blocking whole-tree global copy/hash functions on the Electron main thread for large skills. Stop the queue on failure/cancel and keep accurate completed/refused/failed/not-attempted/uncertain results.
- [ ] **Implement restore:** verify complete backup bytes/manifest and its project/path binding. Bind expected current bytes and ownership; reject edits/newer deliveries/corrupt backups/replaced roots. Restore earlier ownership even when destination bytes already match the backup. For absent-before content, delete only verified delivered entries and prune only recorded, still-unlinked, empty created directories. Do not treat the existing generic lowercasing `pruneEmptyDirs()` as proof of this narrower guarantee.
- [ ] **Run green:** targeted apply/restore and existing global apply/restore/linked import tests. Exercise after-backup swaps to junctions, source/destination mutations during copy, `.DS_Store`, empty directories, no-op restore ownership and failure recovery. Observe real sync/promise/worker filesystem APIs used; assert no provisional leaks or unrelated deletion. Record the unavoidable external-writer race window honestly.
- [ ] **Commit only this task's files:** `feat(projects): apply and restore verified project deliveries`.

## Task 7: Full project flow and final release gate

**Files:** Create `ProjectDeliveryDialog.tsx`, `ProjectPreviewDialog.tsx`, `ProjectOperationsView.tsx`. Extend `projectIpc.ts`, shared API, allowlist/registration, `LibraryView.tsx`, `WindowsApp.tsx`, operations navigation, `scripts/project-ipc.test.ts`, `scripts/windows-project-delivery.ui.test.ts`, release fixture, README and `docs/windows-verification.md`.

**Interfaces:** Extend the same project handler registry with `projectDiscover({root}) -> CensusDiscovery`, `projectPreview({discoveryId,selections}) -> ProjectPlanView`, `projectDecide({planId,decisions}) -> ProjectPlanView`, `projectApplyStart({planId}) -> {jobId}`, `projectDiscardPlan({planId}) -> {planId}`, `projectOperations({}) -> ProjectOperationView[]`, `projectRestorePreview({operationId}) -> ProjectPlanView`, `projectForgetDelivery({deliveryId}) -> {deliveryId}`. Keep `projectPoll`/`projectCancel` for import and apply jobs. Root is the only caller-chosen directory path; native named-rule `name` is the only constrained relative slot string. Bind requests to the current discovery/plan and reject unknown keys throughout.

- [ ] **Write failing tests** `project_delivery_mixed_recipients`, `project_preview_late_reply_cannot_enable_apply`, `project_operation_restore_round_trip`. In Electron import only A's selected Claude skill; select B/C recipients, Codex for B and OpenCode for C, then omit the skill for C. Assert backend selections and bytes: only B/`.agents/skills/caveman` exists. Run a separate explicit mixed-tool delivery, shared AGENTS collision selection, Skip -> Replace confirmation, partial result and restore. Delay actual main handlers, change root/selection, Cancel/close, and assert stale responses cannot re-enable Apply or send obsolete IDs.
  ```ts
  assert.deepEqual(actualTargets, [join(projectB, '.agents', 'skills', 'caveman')])
  assert.deepEqual(sourceAfter, sourceBefore)
  assert.equal(staleApplyRequests.length, 0)
  assert.deepEqual(restoredProject, projectBeforeApply)
  ```
- [ ] **Run red:** targeted IPC tests and compiled Electron UI tests. Run against UI without the new flow first; distinguish expected assertion failure from build/environment failure.
- [ ] **Implement UI and channels:** discovery does metadata only and starts with no selected recipients. Offer common tool choice and per-project overrides, actual paths, alternative rule slots/local precedence notes, per-combination omissions, physical collisions and explicit replacement. Invalidate prior plans/generations on each dependent change in both renderer and backend; a new discovery supersedes old unconsumed plans. Closing/discarding a plan prevents replay. Keep running jobs tied to explicit cancellation rather than silently forgetting their results. Keep successful work visible after cancellation; show project operations separately from global operations and expose previewed restore/forget actions. Maintain rejection handling and platform allowlist tests for every new channel.
- [ ] **Run final gates on final code:** `npm.cmd run test:windows`, `npm.cmd test`, `npm.cmd run lint`, `npm.cmd run typecheck`, Prettier `--check` on changed files and `git diff --check`. Record exit codes, measured counts, actual skip reasons and existing warning attribution. An assertion pass with nonzero process exit is a failed gate. Do not rerun broad gates after documentation-only edits when the final-code SHA is recorded accurately.
- [ ] **Update documentation and commit:** document new flow, measured gates, actual code SHA, residual race/cancellation/crash limits and remaining manual/installer acceptance. Commit `feat(windows): add manual project delivery and restore flow`, then a separate documentation commit if required to record its exact SHA. Preserve the census-only installer and public release unchanged.
- [ ] **Stop at the local checkpoint:** report branch/HEAD, commits, base ancestry, per-task red/green evidence, final gate, dirty/untracked state and limitations. Do not run the independent review, build an installer or publish. The coordinator will review the actual checkpoint next.

## Self-review and deferred work

Spec coverage: import/provenance -> Tasks 1–3; native slots/physical identities/scope ownership -> Tasks 4–5; one-shot preview/backup/apply/restore -> Tasks 5–6; complete UI/IPC/cancellation -> Tasks 3 and 7; regression/release evidence -> Tasks 3, 6 and 7. Every review-focus item has a named test in its owning task. No new external service, dependency or private history is required.

The accepted census `Version` -> `Content` copy change and recording its manual acceptance remain a separate small tranche. Do not fold that change into this implementation without naming it separately. Multi-root delivery and manual Git-like rule composition remain deferred. This plan does not authorize composing files, editing parts of skills, upgrading dependencies or regenerating installers.

Recommended execution: one Claude Opus implementer, effort `high` if the user's harness exposes it, using `superpowers:executing-plans`; independent GPT Sol review with reasoning `high` after the local checkpoint. Record requested versus selectable/actually configured settings; do not claim provider-confirmed effort. The plan is ready for user review; implementation is not started by saving it.
