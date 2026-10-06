# Project census — implementer handoff

Recommended model: `gpt-6.1-sol`. Recommended reasoning: `high`, because the filesystem read boundaries, asynchronous IPC and renderer cancellation share contracts. Use one implementer for the sequential plan, followed by independent review. Do not silently substitute an unavailable model or reasoning value.

Use this prompt only after the user has reviewed the implementation plan.

---

Implement the approved Windows project census v1 for Illithid.

Read the applicable AGENTS.md instructions.
Read `docs/superpowers/specs/2026-10-06-project-census-design.md`.
Read `docs/superpowers/plans/2026-10-06-project-census.md`.
Use `superpowers:executing-plans` and the normal TDD workflow if these skills are available in your harness.

Start from the existing isolated worktree on `codex/project-census-design` containing this handoff and the plan.
Verify and record its exact HEAD before changing files.
Verify that the spec checkpoint `09c2d378d194ffb7c1f28560ac89a87ca2d5723f` is an ancestor.
Verify that later commits up to your starting HEAD changed documentation only.
The application code base is published checkpoint `80e8c24a14bfb5931aaf96d42631a77beb41ecd5`.
Preserve that tag and branch history.
Create an implementation branch named `codex/project-census` from your verified documentation checkpoint, using the existing isolated worktree unless it is owned by another active task.
Do not touch the main checkout's private branch.
Preserve `.impeccable/hook.cache.json` and all unrelated changes.
If HEAD, ownership or tracked modifications differ from the expected state, report the discrepancy before overwriting anything.
Do not stash, reset or clean.

Implement the four tasks sequentially.
For each new behavior, write a meaningful failing test, run it and record the expected failure before applying the minimal implementation.
Run the task's targeted checks and commit its passing deliverable before moving to the next task.
Keep shared types and channel names consistent with the plan.
Keep candidate discovery one level deep and metadata-only.
Read configuration content only in explicitly selected projects and only at the specified paths.
Do not follow links or junctions.
Compare complete skill manifests, including every resource and hidden entry.
Keep absent, incomplete and successfully read content distinct.
Make cancellation and superseded replies work through the real backend and renderer, not only test mocks.
Use synthetic profiles and project trees for all tests.
Do not scan real user projects or invoke authenticated agent CLIs.

Global/project delivery is an agreed future increment and is outside this implementation.
Do not add import, synchronization, persistent catalog, export, watchers, marketplaces, new dependencies or startup work.
Do not push, merge, open a PR, publish a release, build an installer or install anything.
If a concrete ambiguity prevents implementation, ask one focused question and continue only independent authorized work.
Do not silently weaken an acceptance criterion to make a test pass.

Finish with the plan's complete gate and a local checkpoint for independent review.
Report branch, exact starting/final HEAD, commits, file changes, red/green evidence, command exit codes, test totals, warnings/skips, dirty/untracked files and known limits.
Distinguish measured results from assumptions and from manual acceptance not yet performed.
Stop there.
