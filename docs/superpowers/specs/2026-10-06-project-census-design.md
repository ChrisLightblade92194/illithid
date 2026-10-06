# Project rules and skills census — Windows v1

Date: 2026-10-06. Status: proposed written specification, pending user review.

Base: published Windows preview checkpoint `80e8c24a14bfb5931aaf96d42631a77beb41ecd5`. Design branch: `codex/project-census-design`.

## Purpose and agreed scope

Help a Windows user see which rules and skills their projects contain, identify exact duplicates across projects, and notice differing versions with the same name. Differences can be intentional. Illithid presents evidence and leaves the decision to the user.

The user approved these choices:

- The user selects a root folder and confirms the projects to examine.
- Candidates are the root itself and its immediate child folders. Discovery does not recurse into grandchildren or require Git, manifests, or an agent configuration file.
- The user can select a deeper workspace as a new root to examine its immediate projects.
- The first census reads instruction files at each selected project's root and its recognized local rules/skills directories. It does not search arbitrary source directories for nested instruction files.
- Rules are compared as exact file bytes. Skills are compared as complete trees, including resources.
- Equal content is recognized across different names. Same-name items with different content are reported as differences, not conflicts requiring a fix.
- The census is informative. It does not import, deliver, edit, merge, delete, or execute anything in a project.

## Approach

Add a dedicated **Project census** section to the existing Windows app. The user runs each census manually and receives a snapshot in the app. Reuse the directory picker, visual conventions, tool labels and filesystem validation helpers where appropriate. Keep project inventory separate from the global library, ownership records, delivery plans and restore operations.

A plain file list would identify locations but leave comparison work to the user. A recursive project-wide inventory would cover more instructions but require discovery/exclusion policies for arbitrary source trees. The selected first version combines a comparative view with a fixed set of local paths.

This is a new read-only subsystem. The existing upstream workspaces represent whole configuration libraries; they are not project directories and must not be repurposed as census projects.

## User flow

1. The user opens **Project census** and chooses a local root folder.
2. Illithid lists the root and its immediate folders with their paths. Discovery reads directory metadata only. It does not read configuration content or inspect grandchildren. The root is clearly distinguished from its child candidates.
3. No candidate is preselected. The user selects candidates and chooses **Run census**. Linked or otherwise unsupported candidates remain visible with a reason and cannot be scanned.
4. Illithid reads the fixed local paths only in the confirmed projects and shows progress. The user can cancel the operation.
5. Results show the selected root, projects, scan time, scan coverage and counts for rules, skills and incomplete items. Empty projects are shown as having no matching local configuration in the covered paths.
6. The user can filter results by project, kind, potential tool consumer and comparison category. Each item shows its project and relative path; its full path is available in details.
7. A duplicate group lists all its occurrences. A same-name difference group shows the distinct versions and where they occur. A rule's detail view can show the two texts side by side. A skill's detail view shows the file/resource differences; binary resources are identified by path and digest rather than rendered or executed.
8. **Rescan** repeats the census only after the user requests it. Changing the root or project selection invalidates the previous confirmation and results. New results are not combined silently with an earlier snapshot.

Results and selection are session-local in v1. There is no saved catalog, export, background watcher, scheduled scan or startup scan.

## Paths covered inside each confirmed project

All paths below are relative to the selected project folder. Project discovery stays one level deep; recursive reads are limited to the indicated rules and skill trees.

| Kind             | Local paths                                                           | Convention / potential consumers                                           |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Instruction file | `AGENTS.md`, `AGENTS.override.md`                                     | Codex conventions; `AGENTS.md` is also an OpenCode convention              |
| Instruction file | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`                   | Claude Code conventions; OpenCode documents compatibility with `CLAUDE.md` |
| Rule files       | `.claude/rules/**/*.md`                                               | Claude Code rules, including nested files inside this rules directory      |
| Skill trees      | `.claude/skills/<folder>/SKILL.md` and each such folder's full tree   | Claude Code convention; OpenCode-compatible location                       |
| Skill trees      | `.agents/skills/<folder>/SKILL.md` and each such folder's full tree   | Codex convention; OpenCode-compatible location                             |
| Skill trees      | `.opencode/skills/<folder>/SKILL.md` and each such folder's full tree | OpenCode convention                                                        |

A skill candidate is an immediate folder in a listed skill container. Its whole tree participates in the comparison. A folder without `SKILL.md` is reported as a non-skill candidate and is not traversed for comparison. Custom skill paths and alternative layouts are not inferred.

One physical configuration at a shared path is one inventory occurrence with multiple potential-consumer labels. It is not duplicated in the inventory once per tool. These labels describe documented conventions, not proof that a particular agent session loads the file.

The census does not resolve instruction imports, globs/URLs from configuration, custom fallback filenames, parent/global instructions, plugin caches, marketplace sources, managed settings, account sync or additional directories passed to an agent. It does not evaluate instruction precedence, path conditions, overrides or effective agent context. Both an instruction and its override can be present in the inventory even if the tool would load only one.

Sources used to define the static coverage: [Claude Code memory and rules](https://code.claude.com/docs/en/memory), [Claude Code skills](https://code.claude.com/docs/en/skills), [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [OpenCode rules](https://opencode.ai/docs/rules/), [OpenCode skills](https://opencode.ai/docs/skills/). Runtime behavior and compatibility can evolve; the v1 coverage is the explicit table above.

## Comparison model

- Each occurrence records the project, kind, display name, project-relative path, potential consumers and read outcome. Only a complete successful read has a comparable content digest.
- Rule equality includes every byte, including line endings, encoding markers and frontmatter. There is no text normalization or semantic/AI comparison.
- Skill equality includes the root-relative paths, directories and all file bytes. The outer skill folder name is excluded from the tree digest so differently named folders can have identical trees. `SKILL.md`, including its frontmatter, and all resources participate. No `.DS_Store` or hidden-file exclusion is applied.
- A skill observation carries a sorted manifest of relative paths, entry kinds, file lengths and per-file digests. Equality requires matching complete manifests. A grouping digest must use an unambiguous representation of that manifest; a hash of concatenated raw contents alone is insufficient. The same manifest supports the resource-difference detail view.
- Rules and skills are separate kinds and are never grouped as equal to one another.
- Equal-content groups use kind and complete content digest, regardless of the item's display name or project. Repeated occurrences are shown individually with their locations.
- Same-name groups use kind and a case-insensitive name, consistent with the Windows scope. A rule's name is its project-relative path; a skill's name is its outer folder name. Therefore `CLAUDE.md` and `.claude/CLAUDE.md` are distinct rule names, although they can still belong to an equal-content group.
- A same-name group has a difference when it contains at least two successfully read content digests. Equal-content groups and same-name groups are independent views; an occurrence can participate in both.
- A unique item has one complete occurrence of its content in the selected snapshot. Any incomplete coverage is displayed alongside that result, so uniqueness is not presented as a claim about unread content or other projects.
- Linked, unreadable, changed-during-read, unsupported and cancelled items have no comparable digest. Illithid must not classify them as empty, identical or different based on missing data.

The results are observations of files read at the displayed scan time, not a transaction over the entire filesystem. Where a change during a read is detected, mark the item incomplete and invite a new scan. Separate filesystem checks cannot eliminate every concurrent-change window.

## Read boundaries and error behavior

Only local Windows folders within the root and selected candidates are supported in v1. Network and device paths follow the same exclusions as the Windows release. Discovery may enumerate immediate folders of the chosen root, but it must not inspect the contents of unselected candidates.

Do not follow symlinks or junctions in project candidates, path ancestors, configuration containers, rules or skill trees. Show a linked entry and its stored link text when available. Resolving or reading its target is not authorized by census selection. The existing guided linked import remains a separate global-library operation; the census must not call that import pipeline.

The backend owns discovery results and validates that census selections refer to candidates actually returned for the chosen root. It checks path identity again before reading. A changed root or replaced candidate requires discovery/confirmation again. Renderer-supplied arbitrary absolute paths and unknown request fields are rejected before configuration reads.

An absent known path is an ordinary absence. Access denied, linked ancestors, invalid entries or limits reached are visible incomplete outcomes. One item's failure does not discard readable results from other items. A skill with any unreadable or linked entry remains incomplete as a whole; a partial tree cannot be compared as a full skill.

The implementation must bound reads and keep the UI responsive. Proposed v1 limits are 64 MiB for one file, 256 MiB total bytes and 10,000 entries for one skill, and 64 levels inside a recognized tree. Exceeding a limit reports an incomplete item with the specific reason. These are read limits, not exclusions producing a smaller comparable digest.

Cancellation stops further queued reads and prevents late replies from restoring cancelled results. A new run or a changed selection supersedes the previous request. Do not promise immediate cancellation of a filesystem call already in progress.

## Integration boundaries

- A project census engine owns candidate discovery, path checks, inventory observations and grouping. It does not depend on global variant registration or delivery ownership.
- A dedicated IPC contract exposes discovery, confirmed census runs and cancellation. The backend binds each run to its discovery and selected candidate identities. Request and response types live with the shared API; only the needed channels are added to the Windows allowlist.
- A census renderer view owns root selection, candidate selection, progress, filters and comparison details. Import and **Preview & apply** actions do not appear in this view.
- Existing hashing helpers can be reused only after enforcing census read boundaries and the complete-manifest equality contract. Existing global hashing/delivery behavior remains covered by its regression tests and is not changed by this census.
- The published release tag and installer remain the baseline. This specification does not change application code or authorize a new installer/release.

## Acceptance evidence required from the implementation

Use synthetic project trees. Do not scan the user's real project collection or invoke authenticated agent CLIs during automated tests.

1. Root plus immediate folders are candidates, including non-Git folders. Grandchildren are not discovered. Candidate ordering is deterministic. Discovery does not read configuration content.
2. Only explicitly selected candidates are scanned. Invalid selections, changed candidate identities and extra IPC fields are refused before content reads.
3. Every path in the coverage table is represented. Arbitrary nested source instructions and configured external references are not read. A shared source yields one occurrence with multiple potential-consumer labels.
4. Equal rule bytes and equal whole skill trees group across projects and names. Same-name differing bytes produce a difference. Line-ending changes and resource-only changes remain observable.
5. Skill resources, hidden files and `.DS_Store` participate. A linked or unreadable resource prevents a complete skill comparison. Limits cannot produce false equality from a truncated tree.
6. Links and junctions in every covered position are reported without reading the target. Read observers must intercept all filesystem APIs used by the engine, not only imports in the test module.
7. Empty configuration and unreadable configuration remain distinct. One failure preserves the other successful inventory results. Counts and uniqueness expose incomplete coverage.
8. UI tests cover root choice, manual project selection, an equal-content group, a same-name difference group and cancellation/superseded replies. Assertions check the actual backend selections and displayed results.
9. Before/after hashes verify that all fixture project files, global configuration, library and delivery state remain unchanged. No provisional import directory or ownership record is created.
10. The existing Windows gate remains green. Run build/typecheck, relevant census tests, Windows fixtures/UI tests and lint. Installer generation and manual acceptance of a future census installer are separate steps.

## Next stage

The user reviews this written specification. After approval, prepare an implementation plan and a scoped implementer handoff. Product code, installation and publication are outside this design-only checkpoint.
