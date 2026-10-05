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

## Known limitation

Linked skill directories are refused with `linkedSource`. The reported affected skills include Caveman and other skills installed as links. This is a restriction on traversing a source path, not a semantic compatibility judgment about the skill text. A guided import of the explicitly approved target is being designed; no such implementation is included in this checkpoint.

The combined evidence is a tested development checkpoint. It does not establish complete release acceptance or compatibility with every version of the three agent tools.
