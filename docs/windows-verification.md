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

## Installer artifact

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

## Manual feedback

The user tested the installer on another Windows PC and reported:

- Skill delivery works with Codex and OpenCode.
- `AGENTS.md` and `CLAUDE.md` arrive with the expected content.
- Restore works after choosing a wrong destination; the user then selected the correct destination and repeated delivery.
- Installation and reinstallation work.

These are user-reported manual observations, not independently recorded automated checks. The concrete versions of the three agent tools, their transcripts, and before/after hashes were not collected. Rule-file delivery alone does not demonstrate agent consumption of those rules. The latest installation/reinstallation report does not explicitly establish every uninstall data-retention check.

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

The gate ran on code commit `445c5af`, after the review fixes. The documentation commit that follows changes only this file.

| Check                        | Observed result                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Targeted global engine tests | 76/76 passed: 59 existing and 17 linked-skill tests                                                                   |
| `npm.cmd run test:windows`   | Exit 0, including build and TypeScript checks                                                                         |
| Portable unit runner         | 128 total: 127 passed, 0 failed, 1 upstream skip (Homebrew cask); 8 deferred-feature files excluded on Windows        |
| Windows release fixtures     | 4/4 passed                                                                                                            |
| Electron UI tests            | 8/8 passed, including linked-skill selection and confirmation, and a held preview reply after deselect, Cancel, close |
| `npm.cmd run lint`           | Exit 0, no errors, the 5 pre-existing warnings in upstream files this change does not touch                           |
| Prettier and `git diff`      | Changed files formatted; `git diff --check` reports nothing                                                           |

The tests ran as a standard user, without elevation. Symbolic-link creation was available on the test machine, so the network-link test ran instead of being skipped.

### Review fixes

An independent review of checkpoint `6517364` reported four findings. Each one was reproduced by a failing test before its fix.

| Finding                                                                                              | Failing test before the fix                                                                                               | Fix                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P1: a late preview reply restored skills that were deselected or cancelled, and the import sent them | Electron UI test with a held IPC reply: 2 skills shown as ready after deselection, and after Cancel, instead of 0         | Every preview request gets a number. Deselection, Cancel and closing advance it, and a stale reply is dropped (`445c5af`) |
| P2: the digest skipped `.DS_Store` entries that the copy includes                                    | A change in `.DS_Store/payload.bin` after the preview left the preview digest unchanged, and the import accepted it       | The linked import uses a digest of every copied entry (`fc74c23`)                                                         |
| P2: the identity was not checked again between the last read and the copy                            | A target replaced after the last read (same `SKILL.md`, one extra file) was listed and copied into the provisional folder | Link and target identity are checked immediately before the copy, which then never starts (`2ebebb3`)                     |
| IPC: extra request keys were silently dropped                                                        | `allowLinks` was accepted by the preview and import channels                                                              | Each channel validates its exact keys and refuses any other key as `invalid` (`e75b655`)                                  |

The close-dialog case is also tested. It already passed before the fix, because closing unmounts the dialog. The test remains as a guard.

### Remaining limits

- The checks are separate filesystem reads, not one atomic operation. Checking identity immediately before the copy narrows the window in which another process can change the link, the target, or its folders, but it does not eliminate it: a change between that check and the copy, or during the copy, is caught only by the checks after the copy. During a preview, such a change can still cause a read in the wrong place. The import is then refused when the checks run again.
- The ordinary import and the delivery comparisons still use the upstream digest, which skips `.DS_Store` entries. This change does not modify them.
- The ordinary import channel still ignores keys it does not use. The renderer sends it the listed items, which carry more fields than the selection.
- In test mode only (`ILLITHID_TEST=1`), the main process exposes its registered IPC handlers so that UI tests can hold a reply.
- Only local Windows folders are supported. A link whose stored text is a network or device path is refused without being resolved. A mapped network drive letter is recognized only after the link has been resolved, which accesses the share's metadata, and is then refused.
- A link stored in the `\\?\C:\…` form is treated as a device path and refused.
- Plugin caches, marketplaces, and per-project configurations remain outside this flow.
- The installer described above predates this change. It has not been regenerated, and no manual test of the guided import has been recorded yet.

## Known limitation

The combined evidence is a tested development checkpoint. It does not establish complete release acceptance or compatibility with every version of the three agent tools.
