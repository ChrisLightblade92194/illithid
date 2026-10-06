# Windows verification summary

Date: 2026-10-05. This summary accompanies the unofficial Windows x64 port of Illithid based on upstream `v0.3.1` (`b2ff4f5eb3115cb7ba6c38f4e1e68e709e8b4886`).

The public Windows branch consolidates the local porting commits into one contribution on the upstream base. The original development history, detailed reports, and screenshots remain in the local development checkout. They are not included in the public branch because they contain local account names and paths.

## Automated gate

The gate was run on the application and test changes later committed as local checkpoint `7080778dd4c1cfd95a01f67373f1acdb66690fe2`.

| Check                       | Observed result                                     |
| --------------------------- | --------------------------------------------------- |
| `npm.cmd run test:windows`  | Exit 0                                              |
| Build and TypeScript checks | Completed                                           |
| Portable unit runner        | 111 total: 110 passed, 0 failed, 1 upstream skip    |
| Windows release fixtures    | 4/4 passed                                          |
| Electron UI tests           | 4/4 passed                                          |
| `npm.cmd run lint`          | Exit 0, no errors, 5 pre-existing upstream warnings |

The Windows unit runner excludes eight deferred-feature test files: `hooks-actions`, `hooks-import`, `hooks-library`, `hooks-sync`, `hooks-view`, `market-hooks`, `permissions-sync`, and `scripts-library`. The gate does not run the three upstream `test:fixtures` fixtures. It does not represent a fresh complete `npm test` run.

The Electron tests use synthetic `ILLITHID_HOME` and `ILLITHID_USER_DATA` profiles. They cover variant selection, preservation of existing content, refusal after the destination changes since preview, restoration of previous management state when content is already unchanged, and recovery after an ACL-induced partial failure. No authenticated agent CLI is invoked.

The restricted sandbox did not support the required filesystem behavior for the full gate. The successful gate ran outside that sandbox on the same checkout, still using synthetic profiles.

## Initial installer artifact

`npm.cmd run build:win` completed with exit 0 from local checkpoint `7080778`. The generated artifact is local and has not been uploaded as a GitHub release.

| Property                    | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Filename                    | `illithid-0.3.1-setup.exe`                                         |
| Size                        | 118,996,995 bytes                                                  |
| SHA256                      | `a91382464b64aa33fb32e55150cef509776e8aab6679bee92943c1ccba408c39` |
| Electron / electron-builder | `39.8.10` / `26.15.3`                                              |
| Authenticode                | Not signed                                                         |
| NSIS configuration          | x64 application, per-user, preserves app data on uninstall         |

7-Zip tested the embedded archive successfully (exit 0, 80 files). It reported trailing data in the executable container. Extraction also completed with exit 0. All seven compiled files matched the files extracted from the installer byte for byte. The extracted application executable has PE Machine `0x8664` (x64). The ASAR SHA256 is `bb24edb0c587e7d93bfff23a4a6ac779a4bd4fd8e6f9ebe919a8bf0b9024cb9a`.

## Manual feedback on the initial installer

The user tested the installer on another Windows PC and reported:

- Skill delivery works with Codex and OpenCode.
- `AGENTS.md` and `CLAUDE.md` arrive with the expected content.
- Restore works after choosing a wrong destination; the user then selected the correct destination and repeated delivery.
- Installation and reinstallation work.

These are user-reported manual observations, not independently recorded automated checks. The concrete versions of the three agent tools, their transcripts, and before/after hashes were not collected. Rule-file delivery alone does not demonstrate agent consumption of those rules. The latest installation/reinstallation report does not explicitly establish every uninstall data-retention check.

## Updated installer with linked-skill import

The installer was regenerated from build checkpoint `332d62a09b4f66471f7a2ad20b1f303617be013a`, which includes the linked-import review fixes and the delivery resource digest fix. The only application-packaging change after `1537404` excludes the local design-hook cache; the cache itself was preserved.

Command: `npm.cmd run build:win -- --publish never --config.nsis.artifactName=illithid-0.3.1-windows-332d62a-setup.exe`. Exit 0, including fresh application build and TypeScript checks. No installer was executed or installed, and no artifact was published.

| Property                    | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Filename                    | `illithid-0.3.1-windows-332d62a-setup.exe`                         |
| Size                        | 119,015,849 bytes                                                  |
| SHA256                      | `b7b6483f6f024462cf59e8371b8ec60821ac2a8b1d167a74e0863de720995216` |
| Electron / electron-builder | `39.8.10` / `26.15.3`                                              |
| Authenticode                | Not signed                                                         |
| NSIS configuration          | x64 application, per-user, preserves app data on uninstall         |

7-Zip tested and extracted both the executable container and the embedded x64 application archive with exit 0; the application archive contains 80 files. This verification reported no container warnings. All seven compiled files extracted from the actual installer match the fresh `out` files byte for byte. The packaged MIT license matches the source license, including the original copyright notice. Local Git, design-hook and verification metadata are absent from the application archive. The application executable has PE Machine `0x8664` (x64). The ASAR SHA256 is `ab622da0451cd8cdad93caa890b6d66b9233cb1dcd7824fe0e457a13e704660d`.

A checksum sidecar and a local verification manifest accompany the artifact. The version remains `0.3.1`; the filename and checksum distinguish this package from the initial installer.

### Manual feedback on the updated installer

On 2026-10-05, after receiving this updated installer, the user reported that the linked skill was imported and recognized by both Codex and OpenCode. In OpenCode, invoking `/caveman` with a question produced the expected terse Caveman response. The user also observed that invoking the skill through a slash command displays its expanded instructions in the user message; this behavior was present before the import change and with other skills.

This feedback supports guided import, delivery, discovery by both tools, and actual application of the skill in the reported OpenCode invocation. It is user-reported evidence. Tool versions, transcripts and before/after hashes were not collected. A separate installation/reinstallation result for this updated package and the Cancel path were not explicitly reported; the earlier installer has its own installation/reinstallation feedback above.

## Guided import of linked skills

Added on branch `codex/linked-skill-import`, on top of the public base `d88c02ad26633e533f7be282c84d1de5db15a6ae`. Before this change, linked skill directories such as Caveman were refused with `linkedSource`. That refusal concerned reading a source through a link. It was not a judgment about the skill's content.

### Behavior verified

- **Listing:** a skill folder that is itself a symlink or junction under a confirmed `skills` folder is listed apart, with its link path and real target. Before confirmation, the import reads only metadata: the link itself, the target's resolved path, and the target folder's identity. Tests intercept the `fs` calls of every module involved and assert that nothing inside the target is enumerated or read.
- **Selection and confirmation:** linked skills are never preselected. **Select all** does not include them, and the ordinary import channel refuses a linked folder even when the request carries extra fields such as `allowLinks`. After a multiple selection, the confirmation lists every link and target it covers. Cancelling imports nothing and leaves links and targets unchanged.
- **Pending preview:** a preview reply that arrives after the user deselected a linked skill, cancelled the confirmation, or closed the dialog is discarded. The import then sends only previews of links that are still selected.
- **IPC contract:** the preview channel accepts only `tool`, `linkPath`, `targetPath` and `linkFingerprint`. The linked import channel accepts the same keys plus `sourceDigest`. Both channels refuse any other key, such as `allowLinks`, as `invalid` before reading a target.
- **Binding checked by the backend:** the backend binds a confirmation to the identity of the link, the stored link text, the resolved target, and the target folder's identity. It derives the candidate again from the confirmed `skills` folder. Its checks run before reading the target, immediately before the copy starts, and after copying, and they refuse the following:
  - a path that was not listed;
  - a link changed after it was shown or confirmed, including one re-pointed to an identical copy, recreated to the same target, or swapped during the copy;
  - a target folder replaced in place;
  - content changed after the preview or during the copy.
- **Copy:** an approved import through a junction, created and run without administrator rights, copies the whole tree, resources included. The preview, the check before the copy, the verification of the copy and the recorded origin use one digest that covers every copied entry, `.DS_Store` entries included. The copy is verified against the previewed digest before the variant record is written. The origin records the link and the real target. The link, the target, and its contents stay unchanged, and no script of the skill runs. Variants saved before this change remain readable.
- **Still refused:** links inside the skill and linked `rules` or `skills` folders. Broken links, cyclic or self-containing links, targets without `SKILL.md`, and network targets get their own codes and readable messages. A network target is refused from the stored link text, before any resolution.
- **No leftovers:** every refusal or error leaves no provisional folder in the library. The tests cover changed content, an unreadable resource, and a link swapped during the copy.
- **Delivery:** a linked-origin variant is never delivered back through its link. That destination stays a `link` conflict. Other tools receive a real copy.

### Automated results

The latest gate ran on code commit `e33d11f`, after the review fixes and the delivery digest fix below. The documentation commit that follows changes only this file.

| Check                      | Observed result                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Global engine tests        | 80/80 passed within the unit runner: 59 existing and 21 linked-skill tests                                            |
| `npm.cmd run test:windows` | Exit 0, including build and TypeScript checks                                                                         |
| Portable unit runner       | 132 total: 131 passed, 0 failed, 1 upstream skip (Homebrew cask); 8 deferred-feature files excluded on Windows        |
| `npm.cmd test`             | Exit 0; unit runner and the Git, model-stats and session-scan fixtures passed on synthetic profiles                   |
| Windows release fixtures   | 4/4 passed                                                                                                            |
| Electron UI tests          | 8/8 passed, including linked-skill selection and confirmation, and a held preview reply after deselect, Cancel, close |
| `npm.cmd run lint`         | Exit 0, no errors, the 5 pre-existing warnings in upstream files this change does not touch                           |
| Prettier and `git diff`    | Changed files formatted; `git diff --check` reports nothing                                                           |

The tests ran as a standard user, without elevation. Symbolic-link creation was available on the test machine, so the network-link test ran instead of being skipped.

### Draft preparation gate

On 2026-10-05, the gate was repeated on branch `codex/linked-skill-import` at `e60f558`, with only this verification document being updated. `npm.cmd run test:windows`, `npm.cmd test`, and `npm.cmd run lint` each exited 0. The Windows run again reported 132 unit tests (131 passed, one upstream Homebrew skip), 4/4 release fixtures, and 8/8 Electron UI tests. Lint reported zero errors and the same five upstream warnings. Node also emitted its experimental SQLite warning.

The unchanged installer checksum was verified again. All seven compiled files from the fresh build matched the hashes recorded from the verified installer payload. The release draft therefore uses the already tested installer from `332d62a`; later commits update documentation only. No new installer was built for this documentation update.

### Review fixes

An independent review of checkpoint `6517364` reported four findings. Each one was reproduced by a failing test before its fix.

| Finding                                                                                              | Failing test before the fix                                                                                               | Fix                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P1: a late preview reply restored skills that were deselected or cancelled, and the import sent them | Electron UI test with a held IPC reply: 2 skills shown as ready after deselection, and after Cancel, instead of 0         | Every preview request gets a number. Deselection, Cancel and closing advance it, and a stale reply is dropped (`445c5af`) |
| P2: the digest skipped `.DS_Store` entries that the copy includes                                    | A change in `.DS_Store/payload.bin` after the preview left the preview digest unchanged, and the import accepted it       | The linked import uses a digest of every copied entry (`fc74c23`)                                                         |
| P2: the identity was not checked again between the last read and the copy                            | A target replaced after the last read (same `SKILL.md`, one extra file) was listed and copied into the provisional folder | Link and target identity are checked immediately before the copy, which then never starts (`2ebebb3`)                     |
| IPC: extra request keys were silently dropped                                                        | `allowLinks` was accepted by the preview and import channels                                                              | Each channel validates its exact keys and refuses any other key as `invalid` (`e75b655`)                                  |

The close-dialog case is also tested. It already passed before the fix, because closing unmounts the dialog. The test remains as a guard.

### Delivery resource digest fix

The review of `5e26bac` reproduced a resource-only variant change that was imported correctly but not delivered. Two variants differing inside `.DS_Store` were assigned the same library revision. Selecting the second variant planned an adoption without copying it: Apply completed and the recipient appeared synced while still containing the first variant's resource.

Three regression tests failed before the fix: the second Apply left the old resource in place, a local resource edit caused no conflict, and a library resource edit after preview did not invalidate Apply. A fourth test protects legacy backup compatibility and already passed before the fix.

The global Windows flow now shares `globalTreeDigest` across ordinary and linked import, library revisions, destination reads, delivery planning, temporary-copy verification, backup and restore. It covers every copied entry and keeps the upstream hash format, so trees without `.DS_Store` retain their digest. Upstream callers of the directory delivery helper retain their existing hash by default; global Windows delivery supplies the complete hash explicitly.

All four tests pass. They verify the actual resource bytes after the second Apply and after restore, refusal of a corrupted backup resource, preservation of a local resource edit, rejection of a stale library preview, and restoration of a legacy backup including its original resources and instructions.

New directory backups record `digestAlgorithm: fullTree-v1`. Backups without that field are verified with their original upstream digest. A new restore preview then binds the complete tree that will be copied. Existing records are not rewritten automatically.

### Remaining limits

- The checks are separate filesystem reads, not one atomic operation. Checking identity immediately before the copy narrows the window in which another process can change the link, the target, or its folders, but it does not eliminate it: a change between that check and the copy, or during the copy, is caught only by the checks after the copy. During a preview, such a change can still cause a read in the wrong place. The import is then refused when the checks run again.
- Existing delivery records or previews made with the old digest can require a new preview and an explicit conflict decision when `.DS_Store` is present. Legacy backup verification retains the original digest's exclusions; new backups verify every entry.
- The ordinary import channel still ignores keys it does not use. The renderer sends it the listed items, which carry more fields than the selection.
- In test mode only (`ILLITHID_TEST=1`), the main process exposes its registered IPC handlers so that UI tests can hold a reply.
- Only local Windows folders are supported. A link whose stored text is a network or device path is refused without being resolved. A mapped network drive letter is recognized only after the link has been resolved, which accesses the share's metadata, and is then refused.
- A link stored in the `\\?\C:\…` form is treated as a device path and refused.
- Plugin caches, marketplaces, and per-project configurations remain outside this flow.
- The updated installer has user-reported linked-import and tool-discovery feedback, including an OpenCode invocation that applied the skill. Its separate installation/reinstallation and Cancel checks were not explicitly reported.

## Project census

Date: 2026-10-06. Branch `codex/project-census`, started from the documentation checkpoint `5be3e62` (spec `docs/superpowers/specs/2026-10-06-project-census-design.md`, plan `docs/superpowers/plans/2026-10-06-project-census.md`). The application base is `80e8c24`. The census is a read-only view; it adds no import, delivery, persistence, watcher or startup work. No installer was built for it, and the published installer remains the baseline.

### Behavior verified

- **Discovery:** the candidates are the chosen root and its immediate folders, listed from folder metadata only. The tests intercept the `fs.promises`, synchronous and callback `fs` calls of every module. A positive control observes the production enumeration of the root. Nothing inside a candidate is enumerated or read, and grandchildren are not examined. Linked and unreadable folders stay visible with their reason. Order is deterministic, including spaces, non-ASCII names and, in a case-sensitive folder, `Proj` and `proj` as two candidates.
- **Selection:** unknown, foreign, duplicate, linked or unreadable ids are refused before any filesystem access. Each binding records the identity of every folder from the filesystem root to the candidate. A project, the root or an ancestor that is replaced is refused before any read, even when it is recreated with identical contents or becomes a junction to the same folder.
- **Coverage:** a positive control shows that a production scan opens exactly the covered files of the selected projects. Unselected projects, nested `src/AGENTS.md`, non-`.md` files in `.claude/rules` and folders without `SKILL.md` are not read. A shared path is one item with several potential consumers.
- **Comparison:** rules are compared byte for byte, so a CRLF version differs from an LF version. Skills are compared by complete manifest: paths, folders, lengths and per-file digests, with the outer name excluded. Empty folders, hidden files and `.DS_Store/payload.bin` change the manifest. Reversed directory listings do not change any result.
- **Incomplete items:** links in ancestors, containers, rules, skill folders and skill contents are reported with their stored text, and their targets are never touched. Unreadable (injected and ACL-denied), changed-during-read and over-limit items carry no digest and join no group. Other items keep their results. An empty project and an unreadable one are reported differently.
- **Limits:** each limit is tested at and above its threshold: 64 MiB per file, 256 MiB and 10,000 entries per skill, and 64 levels. The default values are also tested, using extended files. Nothing over a limit is opened. Two skills that would match only after truncation are both incomplete.
- **IPC:** requests are single objects with exact keys. Extra keys such as `allowLinks`, paths given as ids, copied ids and empty selections are refused before any configuration read. Non-Windows platforms refuse every census channel without filesystem access. In the IPC tests, a real scan with a held reply cannot expose its snapshot after Cancel, a newer start or a new discovery. An asynchronous scanner failure becomes a failed run without an unhandled rejection.
- **Details:** they accept only two different complete items of one kind from the completed current run. Rule details recheck project identity and the full-content digest, and refuse a rule edited since the census. They show at most 200 KiB per side, cut on a character boundary. The labels cover encoding (UTF-8, UTF-8/UTF-16 with BOM, or unrecognized, which is not decoded), line endings and truncation. Skill details compare the cached manifests without any filesystem access.
- **Windows view:** the Electron tests use the real registered handlers, a synthetic profile and synthetic project trees. They cover the root choice, the one-level candidate list with nothing preselected, and the exact candidate ids received by the backend. They also cover counts, coverage, the project, kind, consumer and category filters, an equal-content group across names, same-name differences for a rule and a skill, rule texts side by side and skill resource differences. Held replies after Cancel, a selection change, a newer run, a root change or leaving the view never show obsolete candidates, results or details. The backend receives the cancellation of the previous run. Projects, global tool folders, the library and delivery state stay unchanged, and the census view shows no Import or Apply action.

Each behavior was first reproduced by a failing test: 8/8 discovery tests, 18/18 inventory and comparison tests, 11/11 IPC tests, the extended release fixture and 3/3 Electron tests failed before their implementation. One comparison test passed before its implementation because it compared two empty scans. It was strengthened until it failed. A mutation check that removed the generation guard from census polling made the late-reply UI test fail.

### Automated results

The gate ran on the final Task 4 changes on `codex/project-census`, before they were committed with this document.

| Check                      | Observed result                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run test:windows` | Exit 0, including build and TypeScript checks                                                                        |
| Portable unit runner       | 169 total: 168 passed, 0 failed, 1 upstream skip (Homebrew cask); 8 deferred-feature files excluded; 37 census tests |
| Windows release fixtures   | 5/5 passed, including the exact Windows allowlist with the five census channels                                      |
| Electron UI tests          | 11/11 passed: the 8 existing global-flow tests and 3 census tests                                                    |
| `npm.cmd test`             | Exit 0; unit runner as above; the Git, model-stats and session-scan fixtures passed                                  |
| `npm.cmd run lint`         | Exit 0, no errors, the 5 pre-existing warnings in upstream files this change does not touch                          |
| Prettier and `git diff`    | All 21 changed files formatted; `git diff --check` reports nothing                                                   |

The tests ran as a standard user, without elevation. Junction, file-symlink (Developer Mode was available), ACL-denial and per-folder case-sensitivity tests ran; none was skipped. Node emitted its experimental SQLite warning.

### Census review fixes

An independent review of checkpoint `765f074` reported three P2 findings. A failing regression test reproduced each one before its fix.

| Finding                                                                                                                                                                                                               | Failing test before the fix                                                                                                                      | Fix                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2: an existing folder of a covered path that is not a folder, and `ENOTDIR`, counted as absence. A project with plain files named `.claude`, `.agents` and `.opencode` was reported as empty with nothing incomplete | Two scan tests: the five incomplete items were missing (the project reported `incomplete=0, empty=true`), and an injected `ENOTDIR` left no item | Only `ENOENT` is an absence. A file where a folder belongs yields an unsupported item (`ancestorNotAFolder`) with that path; `ENOTDIR` yields an unreadable item. Truly absent folders and link checks are unchanged (`a302634`)                                     |
| P2: the project filter kept the candidate id of an earlier root. After a filtered census of root A, a census of root B counted one rule but listed nothing, while the select showed "All projects"                    | Electron test with two synthetic roots: the list was `[]` instead of `q1:AGENTS.md`                                                              | Choosing a root resets the project filter; each completed snapshot keeps it only if that project is in the snapshot, so the applied filter is the one shown (`efd9685`)                                                                                              |
| P2: rule details continued after Cancel. An inspection held on its first `promises.open` opened the second rule after Cancel and returned both texts with `ok: true`                                                  | IPC test observing the module's real `fs.promises` calls: the second rule was opened after Cancel, and details were returned                     | Rule reads use the run's abort signal, which Cancel, a new discovery and a new start abort. After each asynchronous step the run must still be current and completed; an aborted read is refused as `stale`. A call already under way is not interrupted (`4e771ea`) |

The gate below ran on the final code at `4e771ea`. This document update follows it and changes only this file.

| Check                      | Observed result                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Census unit tests          | 40/40 passed (37 earlier, 2 for the first finding, 1 covering Cancel, new discovery and new start for the third) |
| `npm.cmd run test:windows` | Exit 0, including build and TypeScript checks                                                                    |
| Portable unit runner       | 172 total: 171 passed, 0 failed, 1 upstream skip (Homebrew cask); 8 deferred-feature files excluded              |
| Windows release fixtures   | 5/5 passed                                                                                                       |
| Electron UI tests          | 12/12 passed: the 8 global-flow tests and 4 census tests                                                         |
| `npm.cmd test`             | Exit 0; unit runner as above; the Git, model-stats and session-scan fixtures passed                              |
| `npm.cmd run lint`         | Exit 0, no errors, the 5 pre-existing warnings in upstream files this change does not touch                      |
| Prettier and `git diff`    | The 6 files changed by the fixes are formatted; `git diff --check` reports nothing                               |

The tests ran natively as a standard user; no sandbox `EPERM` occurred. Node emitted its experimental SQLite warning.

### Remaining limits

- Manual acceptance of the census in an installed build has not been performed. No census installer exists.
- A filesystem call already under way when a census or an inspection is cancelled completes; only the reads queued after it are prevented.
- The identity and change checks are separate filesystem reads, not one atomic operation. A file is compared by identity, length and modification time before and after its read, and a skill is listed again after it is hashed. A change that keeps length and modification time during the read is not detected.
- A root on a mapped network drive is refused when its resolved path is a network path. No mapped drive was available to test this.
- Encoding and line-ending labels describe the part shown in the preview (at most 200 KiB). Equality always covers the whole file.
- A link or unreadable folder above several covered paths, such as a linked `.claude`, produces one incomplete item per covered path.
- Files in `.claude/rules` match `*.md` case-insensitively. A folder without `SKILL.md` is listed as an unsupported item and counted as incomplete.
- Selecting the root together with one of its folders named like a covered folder (for example `.claude`) can list the same physical file under both projects.
- In test mode only (`ILLITHID_TEST=1`), the main process exposes its registered IPC handlers so that UI tests can hold replies.

## Project import and delivery

Date: 2026-10-06. Branch `codex/project-import-delivery`, started from the documentation checkpoint `c90aec3` (spec `docs/superpowers/specs/2026-10-06-project-delivery-design.md`, approved `f018049`; plan `docs/superpowers/plans/2026-10-06-project-import-delivery.md`). The application base is the reviewed census checkpoint `5abf407`. The usable import checkpoint is `68deb31` (Tasks 1–3); delivery, apply and restore follow. No installer was built, nothing was installed or published, and no real project or authenticated agent CLI was used: every test runs on synthetic projects and profiles.

### Behavior verified

- **Content contract:** one rule or skill is observed completely with the census reader (no link followed, census limits, metadata listed before and after the reads). One pass yields the census digest (`sha256-v1` / `census-skill-v1`) and the library revision (`sha256-v1` / `fullTree-v1`, the global tree format); the two formats are carried by name and never compared with each other. Resource-only, hidden-file, empty-folder and `.DS_Store` changes change both. A copy is verified file by file and read back completely.
- **Provenance:** a project origin records the project, relative path, potential consumers, import time, digest and its format, and carries no tool. Origin keys include scope, path and digest format. Legacy global variant records are read without being rewritten; equal variants stay separate until an explicit merge, which keeps both origins. A project-only skill was delivered through the existing global UI to a synthetic Codex folder with identical bytes.
- **Import:** only the selected complete occurrences are read again (an unselected item of the same project is not opened); the request carries the census run and item ids only and is refused before any read when widened, duplicated, empty, foreign or stale. A changed source, a replaced project folder and a skill swapped for an identical copy during the copy are refused. Cancel after a registration, Cancel during a copy, a new census and a new discovery each keep exactly the variants already registered and leave no provisional folder.
- **Destinations:** the native defaults and every alternative rule slot, for its own tool only; traversal, absolute, reserved and non-Markdown names and extra slot keys are refused. Links at the destination, on the way and inside an existing skill are refused without touching anything below them. Two folders differing only in case in a native case-sensitive folder keep distinct physical keys; a case-only spelling and a file with several hard links are refused.
- **Ownership:** project deliveries have their own state file; the global state keeps its bytes. Overlap is found in both directions: a global section inside a project whole file, nested folders, and a project destination inside a confirmed global root. The global preview, apply and restore refuse destinations a project delivery owns; an explicit merge refuses a variant a project delivery uses.
- **Plans:** absent → Create, equal → Unchanged without adoption, different → Skip even when managed; one physical `AGENTS.md` for Codex and OpenCode is one change; two different incoming variants are a collision that blocks Apply until chosen or skipped. Decisions are exactly keyed and must fit the observed state. A changed destination, variant content or name, project folder, or a recorded, forgotten or replaced ownership makes the dependent plan stale. A variant record pointing outside the library (also with Windows separators) is refused without reading outside.
- **Apply:** a backup is complete and verified while the destination still holds its original bytes; a failed backup writes nothing; a failure after one write leaves later destinations not attempted; Cancel keeps recorded work and does not attempt the rest. The shared lock held by a real child process (project or global) refuses the other scope. A crash after the write and before the record is listed as interrupted and uncertain, with an intact backup, no ownership record and no replay; a crash after the backup is listed as not attempted. A junction swapped in after the backup and a library variant changed while staged are refused; destinations sharing missing folders apply in one operation; no staged or aside entry is left behind.
- **Restore:** whole files and skills come back from verified backups, in reverse order; absent-before content is removed only while unchanged, and only the operation's own empty folders are pruned (pre-existing and populated folders stay). Earlier ownership comes back, also when the bytes were already restored by hand. Local edits, newer deliveries, corrupt backups and replaced project folders are refused; a restore preview is itself bound and refused when the destination changes after it.
- **Windows view:** the Electron tests use the real handlers on synthetic trees: subset import with nothing preselected; delivery of A's Claude skill to C's Codex layout with D's OpenCode combination omitted (only `C/.agents/skills/caveman` written, the source and an unselected project unchanged); late preview replies after a selection or root change discarded by id and never enabling Apply; a shared `AGENTS.md` collision chosen, Skip then confirmed Replace, a partial result (a denied folder) and the restore round trip from the project operations view.

Each task's behavior was first reproduced by failing tests (recorded in the local progress log); two self-review fixes in apply (folders created earlier in the same operation, a staged source change) were each shown failing with the fix disabled.

### Remaining limits

- The checks before each write are separate filesystem operations, not one atomic step. They narrow, but do not remove, the window in which another program can change a destination between the last check and the rename. Applying several destinations is not atomic; nothing is rolled back automatically.
- Cancel is observed between steps and during copies; once a destination starts changing it is finished, read back and recorded. An interrupted apply is reported, never resumed; an uncertain destination needs inspection and a restore preview.
- A case-only name difference under a case-sensitive folder is refused even when the two names would be distinct there, instead of being guessed.
- Tool labels describe folder conventions; the preview does not resolve which instructions a session loads (parent folders, settings, precedence).
- One destination root per preview; delivering under several roots needs several previews. Rule composition and partial skill transfer are not part of this release.
- In test mode only (`ILLITHID_TEST=1`), the main process exposes its registered IPC handlers so that UI tests can hold replies.
- Manual acceptance in an installed build has not been performed; no installer exists for this change.

## Known limitation

The combined evidence is a tested development checkpoint. It does not establish complete release acceptance or compatibility with every version of the three agent tools.
