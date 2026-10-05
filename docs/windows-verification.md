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
- **Binding checked by the backend:** the backend binds a confirmation to the identity of the link, the stored link text, the resolved target, and the target folder's identity. It derives the candidate again from the confirmed `skills` folder. Its checks run before reading the target, before copying, and after copying, and they refuse the following:
  - a path that was not listed;
  - a link changed after it was shown or confirmed, including one re-pointed to an identical copy, recreated to the same target, or swapped during the copy;
  - a target folder replaced in place;
  - content changed after the preview or during the copy.
- **Copy:** an approved import through a junction, created and run without administrator rights, copies the whole tree, resources included. The copy is verified against the previewed digest before the variant record is written. The origin records the link and the real target. The link, the target, and its contents stay unchanged, and no script of the skill runs. Variants saved before this change remain readable.
- **Still refused:** links inside the skill and linked `rules` or `skills` folders. Broken links, cyclic or self-containing links, targets without `SKILL.md`, and network targets get their own codes and readable messages. A network target is refused from the stored link text, before any resolution.
- **No leftovers:** every refusal or error leaves no provisional folder in the library. The tests cover changed content, an unreadable resource, and a link swapped during the copy.
- **Delivery:** a linked-origin variant is never delivered back through its link. That destination stays a `link` conflict. Other tools receive a real copy.

### Automated results

The gate ran on code commit `1bdcc55`. The documentation commit that follows changes only `README.md` and this file.

| Check                        | Observed result                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Targeted global engine tests | 74/74 passed: 59 existing and 15 new linked-skill tests                                     |
| `npm.cmd run test:windows`   | Exit 0                                                                                      |
| Portable unit runner         | 126 total: 125 passed, 0 failed, 1 upstream skip (Homebrew cask)                            |
| Windows release fixtures     | 4/4 passed                                                                                  |
| Electron UI tests            | 5/5 passed, including multiple selection, cancel and explicit confirmation of linked skills |
| `npm.cmd run lint`           | Exit 0, no errors, the 5 pre-existing warnings in upstream files this change does not touch |
| Prettier                     | Changed files formatted                                                                     |

The tests ran as a standard user, without elevation. Symbolic-link creation was available on the test machine, so the network-link test ran instead of being skipped.

### Remaining limits

- The checks are separate filesystem reads, not one atomic operation. They narrow the window in which another process can change the link, the target, or its folders, but they do not eliminate it. During a preview, such a change can still cause a read in the wrong place. The import is then refused when the checks run again.
- Only local Windows folders are supported. A link whose stored text is a network or device path is refused without being resolved. A mapped network drive letter is recognized only after the link has been resolved, which accesses the share's metadata, and is then refused.
- A link stored in the `\\?\C:\…` form is treated as a device path and refused.
- Plugin caches, marketplaces, and per-project configurations remain outside this flow.
- The installer described above predates this change. It has not been regenerated, and no manual test of the guided import has been recorded yet.

## Known limitation

The combined evidence is a tested development checkpoint. It does not establish complete release acceptance or compatibility with every version of the three agent tools.
