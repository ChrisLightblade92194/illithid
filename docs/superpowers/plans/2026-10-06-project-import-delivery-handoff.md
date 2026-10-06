# Project import and delivery: implementer prompt

Recommended implementer: Claude Opus, effort `high` if selectable in your harness. Recommended execution: one native implementer session; the components share contracts and state. Recommended independent reviewer after the checkpoint: GPT Sol, reasoning `high`. This prompt does not launch a review.

Copy the prompt below after the user approves the implementation plan. The design branch identifies the local documentation checkpoint; verify its full SHA and documentation-only ancestry before implementation.

```text
Implement the approved Illithid Windows project import and delivery v1 specification.

Read the repository's applicable instructions before changing files.
Read docs/superpowers/specs/2026-10-06-project-delivery-design.md.
Read docs/superpowers/plans/2026-10-06-project-import-delivery.md.
Read both documents completely; the plan's task interfaces and global constraints are part of the handoff.

Recommended model family is Claude Opus.
Requested effort is high if your harness exposes that setting.
At startup report your actual model and selectable/configured effort, or state that they cannot be verified.
Do not silently substitute another model or claim that a requested setting was provider-confirmed.

Repository:
C:\Users\chies\Documents\Programmazione\Progetti AutoIA\plugin_condivisione_tools
Existing isolated worktree:
C:\Users\chies\Documents\Programmazione\Progetti AutoIA\plugin_condivisione_tools\.claude\worktrees\linked-skill-import
Design branch: codex/project-delivery-design
Required documentation checkpoint: the local codex/project-delivery-design ref prepared by the coordinator
Approved spec commit: f018049faf6d4ec5385c1db8475c5c688e70e444
Reviewed application base: 5abf40796c7737f132230f52e3a4395247e41983

Before editing, resolve git rev-parse codex/project-delivery-design and record that full SHA as the starting checkpoint.
Verify that the current branch is codex/project-delivery-design and HEAD equals that resolved checkpoint.
Verify the worktree path.
Verify that f018049 and 5abf407 are ancestors.
Verify that commits after 5abf407 contain documentation only before your implementation starts.
Record the tracked and staged state and the hash of .impeccable/hook.cache.json if present.
Preserve unrelated work and ignored artifacts.
If HEAD or tracked state differs unexpectedly, stop with the discrepancy and do not reset, clean or stash.
When the starting checks match, create codex/project-import-delivery from this checkpoint inside this same isolated worktree.
Do not modify the main checkout or the codex/project-census branch.

Use superpowers:executing-plans if available and apply the plan task by task in one implementer session.
Do not spawn a fresh implementation/review agent for every task by default.
Tasks share interfaces, state and ownership; follow their order.
Keep a concise progress log in an ignored local folder.
Complete the usable import checkpoint in Tasks 1–3 before adding project delivery in Tasks 4–7.
Do not stop merely at scaffolding, a proposal or tests without implementation.
For each task write meaningful regression tests, observe the intended red assertions, implement the minimal behavior, observe green with exit 0, and commit only that task's files.
If a test is already green, report it as baseline protection rather than red/green evidence.
Do not replace behavioral assertions with mocks of the implementation.

Implement selected whole-rule/whole-skill imports and manual deliveries through the existing library.
Support individual selections, subsets, multiple projects and per-project Claude/Codex/OpenCode choices in v1.
Use the native destinations in the spec, including .agents/skills for project Codex skills.
Default differing destinations to Skip; require explicit Replace and a verified durable backup.
Treat shared AGENTS.md as one physical destination; require a choice between differing incoming variants.
Keep global managed sections, legacy variants and operation/restore records compatible.
Check global/project ownership overlap in both directions, including whole files containing global sections.
Do not follow links or accept renderer-supplied arbitrary source/destination paths.
Recheck content, identities and ownership at write boundaries, verify complete trees, preserve originals and clean unfinished variants/staging.
Reuse the existing Windows exclusive apply lock without deleting or stealing it.
Report partial, cancelled, interrupted and uncertain work honestly; do not promise atomicity or automatic rollback/replay.
Restore only verified delivered destinations and previous ownership; preserve edits, unrelated files and populated/pre-existing directories.
Keep large filesystem work cancellable and the Electron main process responsive.

Use synthetic fixtures only.
Run the targeted checks and final gates listed in the plan, including the full Windows gate and existing global/census regressions.
Record exact commands, exit codes, measured totals, warnings and skips.
If an environment limitation prevents a gate, preserve the checkpoint and report the exact limitation; do not claim a pass.
Do not upgrade dependencies or run fresh installs just to bypass an environment issue without reporting the necessity first.

Do not change the pending census Version-to-Content wording in this tranche.
Do not add multi-root operations, automatic sync, marketplace/cache support, reference expansion or rule composition.
Do not build or install an installer.
Do not scan real projects or run authenticated agent CLIs.
Do not launch paid external reviews, model/provider calls or automatic review tools.
This handoff's scope does not include external review even if a generic local workflow recommends it.
Do not push, merge, open a PR, create a release or publish.

At the final local checkpoint report:
- branch, full HEAD, starting checkpoint, ancestry and commits;
- behavior implemented and the usable import checkpoint;
- red/green evidence for each task and final measured gates;
- remaining tracked/untracked/ignored state and preservation hashes;
- concrete limitations, skips and incomplete manual/installer acceptance.
Stop for the coordinator's independent review.
```
