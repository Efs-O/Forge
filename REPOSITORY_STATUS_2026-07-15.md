# Forge Pre-release Repository Audit: 2026-07-15

## Executive summary

Forge is in a healthy automated-build state, but it is not at a clean,
release-ready checkpoint yet.

- The current version is `0.12.28`; the newest repository tag is `v0.12.27`.
- Local `main` is 30 commits ahead of `origin/main` and 0 commits behind.
- The latest committed feature is bounded coding-worker orchestration
  (`4af2d43`, 2026-07-14).
- There is an active, uncommitted Phase 6 change adding the strict
  `apply_line_edits` worker-capable write tool.
- The exact dirty tree passes type-checking, lint, all 289 automated tests,
  normal builds, the release build, and VSIX packaging.
- Manual Extension Development Host / installed-VSIX validation is still the
  principal release blocker. Several older plan checkboxes are stale tracking
  artifacts, not missing implementations.

Overall assessment: **implementation is advanced and automated gates are
green; release confidence is held back by unpublished/uncommitted work and
unfinished live UI/runtime smoke validation.**

## Evidence and audit method

This report is a pre-release snapshot produced from the repository itself, not by accepting status
documents as authoritative. The audit used:

- Git branch, divergence, log, tags, diff, and working-tree state;
- source registration and call paths for tools, workers, permissions,
  checkpoints, and UI messages;
- test files and current test execution;
- package scripts and both GitHub Actions workflows;
- the generated VSIX contents;
- source/test searches for unfinished markers;
- existing plans and reports only as a final reconciliation layer.

## Git and release state

| Item | Current state |
| --- | --- |
| Branch | `main` |
| Upstream divergence | 30 ahead, 0 behind `origin/main` |
| HEAD | `4af2d43 feat: add bounded coding worker orchestration` |
| Package version | `0.12.28` |
| Latest tag | `v0.12.27` |
| `git describe` before this report | `v0.12.27-32-g4af2d43-dirty` |
| Working tree before this report | 9 modified tracked files, 3 untracked files |
| Newly generated package | `forge-llm-0.12.28.vsix`, 6,873,996 bytes |

The branch is therefore neither synchronized nor clean. The 30 local commits
have not reached the configured `origin/main`, and the Phase 6 work has not yet
been committed. This report itself adds one more untracked file until it is
staged or committed.

## What is implemented

### Core product baseline

The codebase contains the expected local-first VS Code extension architecture:
direct llama-server and Ollama routing, opt-in OpenAI-compatible providers,
typed webview/host messages, tool permission and approval gates, checkpoint
Keep/Undo behavior, configuration validation, search/fetch tools, MCP bridging,
and multi-conversation UI support.

The repository currently has 108 TypeScript files under `src`, 14 TypeScript /
TSX webview files, and 40 test files.

### Delegation and worker orchestration

The worker feature is real code, not only a plan. The implementation includes:

- a shared tool-calling loop and worker orchestration service;
- local/cloud model route classification and cloud-worker opt-in checks;
- one- or two-worker dispatch with exact read/write access contracts;
- bounded workspace discovery and diagnostics for workers;
- exact assigned-path enforcement for mutations;
- cancellation, timeout, backend admission, and no-eviction behavior;
- typed worker status events rendered in the webview;
- coordinator review prompts based on verified changed paths;
- direct worker dispatch and model-visible worker tools;
- focused automated coverage for access policy, orchestration, tool registry,
  prompts, approval behavior, backend pooling, and dispatch.

This matches the latest committed feature at `4af2d43`. The many unchecked
boxes in `docs/AGENT_WORKER_ORCHESTRATION_REPORT.md` are explicitly retained as
an acceptance matrix; they should not be interpreted as absent code.

### Active Phase 6 structured-edit work

The dirty tree adds `src/tools/structuredEditTool.ts` and registers
`apply_line_edits`. Its contract is strict and bounded:

- one workspace-contained target file;
- 1–20 ordered, non-overlapping, one-based inclusive operations;
- exact `expected_lines` stale-content checks;
- line, operation, and cumulative character limits;
- rejection of mixed line endings, out-of-range spans, and no-op edits;
- write permission plus mutation metadata for checkpoint/diff integration;
- worker access only for an exactly assigned writable path.

The associated untracked test file supplies eight focused tests. Existing
dispatch and worker-policy tests were also extended to cover one checkpoint
snapshot and exact-path authorization. These tests passed in the full suite.

## Automated verification performed now

The following canonical commands were run against the current dirty tree on
2026-07-15:

| Gate | Result |
| --- | --- |
| `npm run type-check` | Passed for extension and webview |
| `npm run lint` | Passed |
| `npm test` | 40 files passed; 289 tests passed |
| `npm run build` | Extension and webview built |
| `npm run ci` | Passed |
| `npm run package` | Passed; `forge-llm-0.12.28.vsix` produced |

The CI workflow runs `npm run ci` and `npm run package` on Ubuntu, Windows, and
macOS. The publish workflow runs `npm run ci` and then `npm run publish` for
version tags. This local audit confirms the scripts, not the remote matrix.

One non-failing warning remains: Vitest reports that Vite's CommonJS Node API
is deprecated.

## Unfinished jobs and release blockers

### 1. Finish and commit the structured-edit change

The Phase 6 implementation is functional under automated tests but remains an
uncommitted collection of tracked edits plus two untracked source/test files.
It needs a final review, `git diff --check`, and an intentional commit. The
plan's earlier contradiction between its implemented header and proposal-only
status was reconciled during release preparation.

### 2. Run the installed-VSIX worker smoke matrix

The automated suite does not replace the documented live checks. Still open:

- coordinator model discovery and exact-model dispatch;
- a genuinely read-only worker with no writable paths;
- exact-file worker editing followed by Keep and Undo;
- workspace containment for worker file discovery and text search;
- clear behavior when packaged ripgrep is missing;
- Stop during search, startup, generation, approval, and coordinator review;
- cloud catalog filtering and dangerous cloud-worker approval;
- two disjoint worker writes and rejection of overlapping ownership;
- coordinator no-change review without unrelated dirty-tree diffing;
- the new `apply_line_edits` path in the installed extension.

Until these run against the packaged extension, worker orchestration should be
described as implemented and automation-green, not fully release-validated.

### 3. Complete first-run and local-delegation UI validation

The combined implementation plan still identifies real interactive gaps:

- first-run setup with several real GGUF files and Ollama tags;
- Add Model confirmation and backup/preservation against an existing config;
- `ask_local_agent` with same-model/profile and two-direct-model setups;
- capacity rejection and Stop during consultation.

A prior live finding is especially important: tested primary models did not
reliably emit the `ask_local_agent` tool call and incorrectly claimed terminal
permission was required. The service and permission tests pass, but the model-
driven entry point is not yet demonstrated as reliable. The documented product
decision remains to add a direct user command/UI or qualify a model/template
that calls the tool reliably.

### 4. Reconcile and remove temporary/stale artifacts

`.security_review_request.md` is untracked and embeds a stale copy of
`ToolRegistry`: for example, it omits the newer `cloud-worker` permission and
scope-related interfaces. It appears to be a temporary review-input artifact,
not product documentation. Decide whether to delete it or regenerate and name
it as a durable review record; do not commit the stale snapshot accidentally.

Several planning documents intentionally retain old unchecked lists.
Their top-level status blocks are more reliable than their historical
checkboxes, but contradictory wording should be cleaned up so future audits do
not confuse acceptance history with current work.

### 5. Publish or otherwise reconcile local history

Thirty commits are ahead of `origin/main`. After review and live verification,
the local history needs to be pushed or deliberately rebased/reorganized using
the project's normal release process. No push or history rewrite was performed
during this audit.

## Known backlog, not current release blockers

`ROADMAP.md` records unscheduled improvements rather than incomplete work for
the current worker release:

- allow composing the next prompt while a response streams;
- hierarchical `FORGE.md` support;
- improve `/initForge` extraction and non-JavaScript project detection;
- parallelize independent tool calls;
- move checkpoints from RAM to disk for large/binary files;
- make `format_file` independent of the active editor;
- improve Git-tool behavior when the VS Code Git extension is unavailable;
- detect npm alternatives for build/test tools;
- improve HTML-to-text conversion in `web_fetch`.

The safe-worker plan also explicitly defers richer language navigation and
semantic search for worker scope. These are intentional non-goals, not defects
in the current implementation.

## Technical debt and risks observed

- Seven source files exceed the project's practical 350-line guideline:
  `AgentLoop.ts` (630), `SidebarProvider.ts` (585), `nativeCommands.ts` (473),
  `ControlServer.ts` (419), `SlashCommandHandler.ts` (388), `BackendPool.ts`
  (362), and `gitTools.ts` (357). This is refactoring debt, not a current gate
  failure.
- The new structured-edit owner is a dedicated
  `src/tools/structuredEditTool.ts`, while the Phase 6 plan names
  `src/tools/fileEditTools.ts` as owner. `docs/OWNERS.md` is already modified in
  the dirty tree; the final documentation should make the canonical ownership
  unambiguous.
- Automated success was observed on this Windows checkout only. The GitHub
  Actions three-OS matrix was inspected but not executed by this local audit.
- Live behavior depends partly on local model tool-calling quality, which unit
  tests cannot guarantee.

No explicit `TODO`, `FIXME`, `HACK`, skipped test, or todo-test marker was found
in the source/test/workflow scan. Thrown errors found by the broad search are
normal boundary validation and do not themselves indicate unfinished code.

## Recommended completion order

1. Review the Phase 6 diff and reconcile its owner/status documentation.
2. Decide the fate of `.security_review_request.md`.
3. Run `git diff --check`, then commit the structured-edit change as one
   reviewable unit.
4. Install `forge-llm-0.12.28.vsix` and execute the worker plus structured-edit
   smoke matrix.
5. Complete first-run/Add Model/local-delegation UI cases and resolve the
   unreliable `ask_local_agent` entry-point decision.
6. Re-run `npm run ci` and `npm run package` after any fixes.
7. Push the reviewed local commits and create the next tag/release only after
   the installed-VSIX checks pass.

## Bottom line

The repository is not abandoned or broadly half-built. Most planned
delegation, hardening, and worker orchestration work is present and tested. The
current engineering job is narrower: finish the uncommitted structured-edit
slice, validate the real packaged UX/runtime paths, resolve one delegation UX
decision, clean stale status artifacts, and publish the accumulated local
history.
