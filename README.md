# Illithid — Windows global rules and skills

An unofficial Windows x64 port of [Illithid by doominkim](https://github.com/doominkim/illithid).

Illithid brings rules and skills from Claude Code, Codex, and OpenCode into a shared library. This fork focuses on global configuration, manual delivery, and human decisions about conflicting content.

The Windows code is based on upstream `v0.3.1`, commit `b2ff4f5eb3115cb7ba6c38f4e1e68e709e8b4886`. The original project remains the source of Illithid. Its README is preserved in [README.upstream.md](README.upstream.md), and its copyright and MIT license are preserved in [LICENSE](LICENSE).

## Windows scope

- Import global rules and ordinary skill folders from confirmed Claude Code, Codex, and OpenCode paths. Keep the originals in place.
- Import skill folders installed as a symlink or junction (for example Caveman) through a guided step. The link and its real target are shown first; the target is read only after an explicit confirmation.
- Keep same-name items with different contents as separate variants. Choose what each tool receives.
- Preview changes before applying them. Preserve local changes until the user decides how to handle them.
- Deliver skills as real copies, without requiring symlinks or administrator rights.
- Back up changes and restore previous content and management state.

This Windows build does not expose project configuration, MCP servers, secrets, hooks, permissions, marketplace browsing, sessions, or automatic synchronization. The broader features described in the upstream README belong to the upstream application.

## Current status

This is an experimental Windows port. No Windows GitHub release has been published yet.

The automated gate runs against synthetic profiles. Manual feedback from a separate Windows PC reports successful skill delivery to Codex and OpenCode, rule-file delivery, restore after choosing a wrong destination, and installation/reinstallation. [Verification summary](docs/windows-verification.md).

### Linked skills

A skill folder that is itself a symlink or junction appears under **Linked skills** in the import dialog, with the link path and its real target. Until you confirm, Illithid reads only the link and the target's metadata, not the target's contents. Linked skills are never preselected, and **Select all** does not include them.

After you select one or more linked skills, **Review** lists every link and target that the confirmation covers. **Cancel** imports nothing and reads nothing. After you confirm, Illithid checks that each target is a skill and shows which ones are ready. Importing copies the whole folder, resources included, into the library. Illithid runs no scripts and leaves the link, the target, and its contents as they were. The variant records the link as its origin and the real target that was read.

The confirmation applies only to the link and target shown, for that import. The backend refuses the import and asks for a new review if any of these change after you saw or confirmed them:

- the link, including a link recreated or re-pointed to identical content;
- the target folder, including a folder replaced in place;
- the content.

These checks are separate filesystem reads, not one atomic operation. They narrow, but do not eliminate, the window in which another process could change the link or target during an import.

Links inside a skill and linked `rules` or `skills` folders are still refused. Broken links, cyclic links, targets without `SKILL.md`, and network or device targets are reported with their own reason. This release handles local Windows folders only. Plugin-cache discovery remains outside this import flow.

## Build on Windows

Requires Windows x64 and Node.js 22 or newer.

```powershell
npm.cmd ci
npm.cmd run build:win
```

The installer is generated in `dist/illithid-0.3.1-setup.exe`. The current package is unsigned. NSIS is configured to install for the current user and preserve app data on uninstall.

```powershell
npm.cmd run dev
```

## Verify

```powershell
npm.cmd run test:windows
npm.cmd run lint
```

`test:windows` builds the app and runs the portable unit runner, Windows startup fixtures, and Electron UI tests. The linked-skill tests create junctions as a standard user. The network-link case needs permission to create symbolic links, such as Windows Developer Mode, and is skipped without it. The fixtures use temporary profiles and do not invoke authenticated agent CLIs or install the app. The unit runner reports its Windows exclusions; this gate is not the complete upstream fixture suite.

The inherited GitHub workflow checks upstream macOS behavior. It is not evidence that this Windows port has passed CI on Windows.

## Contributing

Keep changes focused on the Windows scope above. Use synthetic profiles for automated tests. Describe the tested behavior and any remaining limitations when proposing a change.

Upstream contributions can be proposed through a pull request to [doominkim/illithid](https://github.com/doominkim/illithid). This fork is maintained independently; upstream acceptance is not assumed.

## License

[MIT](LICENSE). Original copyright: © 2026 doominkim.
