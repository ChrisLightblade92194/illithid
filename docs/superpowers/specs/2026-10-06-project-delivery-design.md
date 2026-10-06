# Windows project import and delivery v1

Date: 2026-10-06. Status: approved by the user on 2026-10-06, permitting preparation of the implementation plan. Application baseline: `5abf40796c7737f132230f52e3a4395247e41983`, the independently reviewed project-census checkpoint. This document specifies a new increment; it does not authorize product implementation, installation or publication.

## Intended outcome and approved choices

The user wants to reuse selected rules and skills between projects and agent tools. For example, a skill in project A's `.claude/skills/caveman` can be imported into the common library and delivered to project B's `.agents/skills/caveman` for Codex. The original source stays intact.

The conversation established these choices:

- Use the existing common library as the intermediary. Imports and deliveries are separate explicit actions.
- Select one item, a subset or all items. Never infer permission to import or deliver every item in a project.
- Copy each selected rule as a whole file and each selected skill as a whole folder, including resources and empty directories. Selecting a subset of skills does not select portions of their contents.
- Choose global recipients through the existing global flow, or one or more project recipients through the new flow.
- Offer a common tool selection for project recipients, with per-project overrides for Claude Code, Codex and OpenCode.
- Preview concrete changes before applying. Absent content can be created; identical content needs no write; differing content is skipped by default and can be replaced explicitly with backup.
- Keep composition out of v1. The next requested spike will investigate a manual, Git-like rule composition experience.

Success means the user can control which content is copied, where it goes, and which existing content is replaced, with inspectable results and a usable restore path. Choosing a tool describes its destination convention; it does not prove exclusive visibility or actual loading by that tool.

## Scope

This increment adds Windows-only project import into the common library and manual delivery of library content into selected projects. It reuses the existing global delivery behavior without changing its defaults or whole-file/managed-section semantics. Whole-file replacement in this specification applies to the new project destinations.

Project discovery remains root plus immediate folders, including folders without Git or existing agent configuration. A selected project folder must already exist. Illithid can create missing configuration subfolders inside it during an approved Apply. It does not create a new project root.

Use one destination root per project-delivery preview. It may differ from the last census root. To deliver to projects under another root, choose that root and make another preview. Accumulating recipients from several roots in one operation is deferred.

Excluded: automatic sync, watchers, startup scans, semantic conversion between agents, expansion of `@` imports or external references, automatic merge, partial-skill transfer, plugin/marketplace caches, secrets, scripts or authenticated agent invocations. The census itself remains read-only; writing actions are explicit transitions into import or delivery.

## User flow

### Import selected census items

1. Complete a census and select the particular complete occurrences to import. Show project and relative path, including when an occurrence belongs to an equal-content or same-name group.
2. Review the selected items and confirm import into the common library. Nothing is preselected by opening a comparison.
3. Copy and verify each item, then register its library variant. Report success or refusal per item; a failed item cannot leave a registered partial variant or provisional directory.
4. The user can proceed to the library and choose destinations. Import does not deliver automatically.

Import complete occurrences only. Linked, unsupported, unreadable, over-limit or changed items remain ineligible. The guided linked global import is a separate existing feature; this increment does not authorize following project links.

The import request identifies the current completed census and item IDs, not renderer-provided source paths or digests trusted without backend checks. The backend rechecks project/ancestor identity, the complete source content and the current run before copying. Recheck identity and content at the copy boundaries and verify the copied result before registration. A changed source requires another census and confirmation. Respect the census read limits and no-follow rules throughout.

Cancellation prevents new queued reads or registrations after it is observed. An already registered successful item remains in the library and is reported as such. An in-progress filesystem call may finish; unfinished imports are cleaned up. The UI must show a partial import accurately rather than suggesting that Cancel undid previous successes.

### Deliver library items to projects

1. Select the library variants to deliver. This also works for variants imported earlier from global configuration.
2. Choose project delivery and a local destination root. Discover root plus immediate folders using metadata only. Select the project recipients explicitly; no recipient is preselected.
3. Select the recipient tools, with a common selection and per-project overrides. Show each selected variant's actual target path. Allow the user to omit individual variant/project/tool combinations without changing the library selection.
4. Build the preview. Show creations, already-present content, skipped differences, explicit replacements and refusals. Existing differing content starts as Skip even if it was previously delivered by Illithid.
5. Resolve conflicting incoming choices. Refresh the preview after every choice that changes the writes. Apply is enabled only for a concrete plan without unresolved collisions among its selected writes.
6. Apply the confirmed plan and show the result per physical destination. The user can open the corresponding restore preview afterward.

Global and project delivery are separate operations in v1. They use the same selected library content but keep their existing/new destination rules explicit. Selecting a root for census does not authorize writes to it; the project-delivery preview and Apply are the write confirmation.

## Project destination conventions

All paths below are relative to a confirmed project root. These are explicit v1 defaults, not a claim about effective instruction precedence.

| Recipient convention | Whole instruction-file default | Skill-folder default               |
| -------------------- | ------------------------------ | ---------------------------------- |
| Claude Code          | `CLAUDE.md`                    | `.claude/skills/<variant-name>/`   |
| Codex                | `AGENTS.md`                    | `.agents/skills/<variant-name>/`   |
| OpenCode             | `AGENTS.md`                    | `.opencode/skills/<variant-name>/` |

For rules, the user can explicitly choose a supported alternative slot before preview: Claude `.claude/CLAUDE.md`, `CLAUDE.local.md` or a named file under `.claude/rules/`; Codex `AGENTS.override.md`; OpenCode `CLAUDE.md`. Named Claude rule targets use a validated relative Markdown name under `.claude/rules/illithid/`. No arbitrary absolute paths, parent traversal or configured external paths are accepted.

The preview lists other supported local instruction slots that are already present, using metadata without following links, and explains documented local precedence where relevant. It does not resolve ancestor instructions, custom settings or the effective context of an agent session.

Do not silently choose a different file based on precedence or existing configuration. Preserve and display the original rule location/role. A rule imported from an override, local instruction file or conditional Claude rule is still copied as bytes: its original override/path semantics are not translated to another slot or tool. Preserve encoding, line endings, frontmatter and references. Do not generate wrapper instructions, rewrite skill metadata, expand references or copy referenced files that were not separately selected.

The preview names the actual files/folders and labels convention overlap. In particular, Codex and OpenCode share the default `AGENTS.md`; OpenCode also recognizes skills from `.claude/skills` and `.agents/skills`. Tool selection therefore chooses layouts, not exclusive access. v1 uses the canonical skill paths above and does not silently eliminate one requested folder in favor of another tool's compatibility path. Runtime precedence and duplicate-name handling remain tool behavior, not Illithid's promise.

Sources checked for this design: [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Claude memory and rules](https://code.claude.com/docs/en/memory), [Claude skills](https://code.claude.com/docs/en/skills), [OpenCode rules](https://opencode.ai/docs/rules), [OpenCode skills](https://opencode.ai/docs/skills).

## Physical collisions and existing content

One physical destination has one selected final content and one backup/write in an operation. If Codex and OpenCode request identical content in the same project `AGENTS.md`, show one change with both recipient labels. If different selected variants request that path, the user must choose one incoming content or skip that destination. Do not concatenate rules or decide by selection/import order.

Apply the same collision rule to same-name skills and explicit rule slots. Identical content alone does not silently merge or delete library variants; the existing explicit library merge behavior remains intact.

Distinguish these destination states:

| Observation                                                               | Default and available action                        |
| ------------------------------------------------------------------------- | --------------------------------------------------- |
| Absent, valid destination                                                 | Create in the approved plan                         |
| Complete and identical                                                    | Already present; no content or ownership change     |
| Complete but different                                                    | Skip; user can choose whole replacement with backup |
| Link, invalid container, unreadable, ambiguous casing or unsupported path | Refuse with a reason                                |
| Changed after preview, including management state                         | Refuse as stale; require a new preview              |
| Several differing incoming contents for one destination                   | Require a choice; no implicit winner                |

A physical file owned as a global whole-file or managed-section destination cannot simultaneously acquire project whole-file ownership. Refuse that scope overlap and leave the existing global state untouched. A project operation must not invalidate global section records by replacing their containing file. Check overlap across all affected file/section records, not just an exact destination-key match.

Do not incorrectly collapse different folders on a case-sensitive Windows directory merely because their spelling differs only in case. Destination grouping must respect observed filesystem identity and native slot identity. Ambiguous aliases are refused rather than guessed. The same actual project selected twice cannot produce duplicate writes.

## Content, provenance and ownership

Imported content participates in the existing variant library: stable variant ID, actual current content revision, same-name coexistence and explicit merge suggestions. Preserve old variants and origin records. Extend provenance compatibly so a project origin can record the project, relative path, potential consumers, import time, full source digest and its digest format. Do not pretend that a shared source has one proven runtime owner. The UI must distinguish project origins from legacy global origins without rewriting legacy files just to display them.

A census skill digest, library revision and destination digest need not use the same serialization. Each comparison must use the appropriate complete-content contract and record the format where it crosses subsystems. Never compare unrelated hash formats as strings or hash only `SKILL.md` for a skill.

Delivery metadata lives in Illithid's state, not in project instruction content or the skill tree. Project delivery records identify scope, project binding, normalized physical destination, recipient labels, variant ID/revision, delivered digest and operation ID. Legacy records without project scope keep their global meaning. Ordinary identical unmanaged content is not silently adopted; Skip does not change management state.

Keep physical ownership conflicts visible across scopes while displaying global and project operations distinctly. A forgotten delivery invalidates an earlier preview's ownership expectation. Restore also restores the previous ownership state, including when the bytes are already back to their earlier value.

## Preview, Apply and restore guarantees

The backend owns source, project-recipient and preview bindings. Accept exact request schemas and IDs issued by the backend. Reject unknown keys, foreign/stale IDs, duplicate logical selections, empty selections and arbitrary source/destination paths before content reads or writes. Distinct recipient-tool selections sharing one physical file use the collision rules above; they are not invalid duplicate selections. Reject every new channel on non-Windows without touching the filesystem.

A preview binds selected variant IDs, kinds, names and revisions; confirmed recipient identities and native slots; expected whole destination digests; observed ownership; and explicit conflict decisions. Bind the complete plan with an unambiguous fingerprint. Renderer-supplied paths, flags or decisions cannot widen that plan. Use a one-shot Apply: a used or cancelled plan cannot be replayed.

Before creating destination directories or changing content, recheck the project and existing ancestor chain. Recheck source revision, destination digest and ownership at the write boundary, including after backup. Read selected library content only from validated storage inside the common library; refuse corrupt metadata, path escapes and linked content. Never follow links in either destination ancestors or skill resources. A linked destination is not a route for delivery. Limit reads as in the census; an incomplete tree cannot supply a valid preview or backup. Verify delivered whole content before recording success and ownership.

Use the existing Windows exclusive apply-lock primitive to serialize global and project applies/restores sharing one Illithid state. Do not reintroduce lock deletion or stale takeover. A lock does not make filesystem observations atomic or coordinate other independent Illithid stores and external editors.

Before each content change, durably store and verify its backup: complete file/folder bytes, manifest when needed, whether the destination was absent, project/path identity and previous ownership. Do not write that destination if its backup fails. Record what actually completed. Multi-destination Apply is not atomic: on failure, stop further writes and report completed/refused/failed/not-attempted destinations with their recoverable backups. Never display whole-operation success when only some writes completed.

Cancellation after writes begin follows the same boundary: stop further queued writes, preserve the operation record and successful backups, and report partial work. Cancel does not promise automatic rollback. An interrupted operation is reported as interrupted and is not replayed automatically at startup. If a crash leaves an item's write outcome uncertain, report that uncertainty and require fresh inspection/restore preview; do not infer that nothing changed.

Restore is an explicit new preview and Apply. Check backup integrity, recipient/ancestor identity, current bytes and current ownership. Preserve local edits and newer deliveries by refusing stale expectations. Restore an absent-before destination by removing only the still-verified delivered content; never remove unrelated project content. Restore previous bytes and management state, or report why an item cannot be restored. Remove directories created by the operation only when they are still unlinked and empty; keep pre-existing or subsequently populated directories.

## Integration and UI boundaries

Add a project-import coordinator for confirmed census items and a project-delivery coordinator for recipient discovery, plans and operation results. Reuse complete hashing, library storage, verified backup/write primitives and Windows locking where their contracts fit. Do not route project inputs through global path validation or grant generic filesystem access to the renderer. Keep scope-specific validation explicit.

Extend shared API/result types and the Windows allowlist only for the required import/delivery actions. Keep the ordinary census channels read-only. Separate stale-request generations for import, recipient discovery and preview/detail responses; cancellation, new selections, new roots or leaving a view cannot restore obsolete results or silently restart work. Keep the UI responsive during large trees with bounded asynchronous reads.

The library can show project provenance and launch either existing global delivery or new project delivery. Project previews show source variant, project, native destination, recipient labels and the human decision. Existing global previews and restore records remain readable and behave as before.

The accepted census wording improvement (`Version` to `Content`, explicitly comparing current content across projects) and the record of manual census acceptance are still separate pending work. They may be included in a separately identified small tranche; they are not evidence that project import/delivery is implemented or verified.

## Acceptance evidence required

Use synthetic projects and profiles. No real project collection, authenticated CLI, installer execution or paid external review is required by this design.

1. Import exactly selected complete occurrences, including subsets and same-name alternatives. During import, do not reread the unselected items already observed by census. Identical library variants are not implicitly merged.
2. Refuse stale census/project/source bindings and schema-widening fields before copying. Detect resource-only, hidden-file, empty-directory and `.DS_Store` changes. No provisional directory or partial registered variant survives refusal or cancellation.
3. Show and preserve project provenance alongside legacy origins. Existing variants, global managed sections and global delivery/restore behavior remain compatible.
4. Deliver the full selected skill from A's Claude layout to B's Codex layout, resources included; keep A unchanged. Verify multiple recipients and different per-project tool choices. Verify omitted item/recipient combinations are untouched.
5. Exercise each default and alternative rule slot, whole-file bytes, and preserved reference/frontmatter content. No import expansion, semantic translation, script execution or automatic composition occurs.
6. Group a shared Codex/OpenCode `AGENTS.md` into one physical write/backup for identical incoming content. Refuse unresolved different incoming contents. Preserve active global file/section ownership on scope overlap.
7. Verify Create, Already present, Skip and explicit Replace, including no implicit ownership adoption. Change source, destination, project identity or ownership after preview and require refusal.
8. Exercise links/junctions at every relevant ancestor/container/skill position, network/device exclusions, unreadable/invalid entries and read limits. Observe all filesystem APIs actually used. Respect case-sensitive project identities; do not merge distinct physical destinations by case alone.
9. Verify the exclusive lock with concurrent applies/restores, failed backup, a failure after one successful write, cancellation and interrupted execution. Confirm truthful results and complete backups without unhandled asynchronous failures.
10. Restore whole files and skills, resource changes, absent-before destinations and previous management state. Refuse corrupt backups, replacement project roots, local edits and newer ownership. Keep unrelated files and populated/pre-existing directories.
11. Verify actual backend selections and writes in Electron: subset import, mixed recipient-tool choices, conflict decisions, preview refresh, operation results, restore, and stale replies after selection/root/view changes.
12. Run targeted tests then the existing full Windows gate, complete tests, lint, formatting and diff checks at the final code checkpoint. Installer generation and manual acceptance are separate later steps, not inferred from automated gates.

## Requested follow-on spike: manual rule composition

After whole-file project import/delivery is stable, investigate a Git-like composition interface for rules: side-by-side inputs, explicit selection/editing of blocks and a preview of the resulting file. The spike must distinguish a two-way comparison from a genuine three-way merge, which requires an evidenced common base. It must preserve human intent, project-specific text, encoding and import/reference syntax, and define what can be restored.

That spike needs its own approved question and bounded probe. It does not authorize automatic merge, AI rewriting, conflict-marker insertion or partial skill transfer in this increment. Its result should be a concrete feasibility checkpoint, not an untested promise that all Markdown/frontmatter can be combined safely.

## Next stage

The user approved this written specification, including one recipient root per operation, native rule slots, shared physical targets and partial-operation behavior. The next checkpoint is the implementation plan and scoped implementer handoff for user review. No product code, dependencies, installer, installation or publication are changed by this design checkpoint.
