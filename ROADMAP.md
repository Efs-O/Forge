# Forge — Roadmap

**Last verified against code:** 2026-10-27 (0.17.87). Every item names the file
that shows the gap and what "done" means. Shipped work belongs in
[CHANGES.md](CHANGES.md), not here. An item stays only while the gap is still
in the code.

---

## Now: verified gaps, ready to implement

1. **CLI delegation has no rollback checkpoint.** Direct CLI chat snapshots the
   workspace before the CLI starts (`snapshotWorkspaceBefore` in
   `src/agents/WorkspaceCheckpoint.ts`, called only from
   `src/agentLinks/askAgentService.ts`). `runCliDelegation` in
   `src/delegation/CliDelegationRunner.ts` does not, even though the delegate
   runs unrestricted and `ask_local_agent` encourages handing it
   implementation work. As a result, Keep/Undo cannot reverse a delegate's
   edits.
   *Done when:* a CLI delegation takes the same disk-backed checkpoint as
   direct chat, respecting `forge.checkpoint.externalCliEnabled`, and Undo
   restores its edits.
2. **Ollama `:cloud` delegates get the 120 s local timeout.**
   `selectDelegationTimeout` (`src/delegation/LocalDelegationService.ts`)
   gives the 300 s cloud timeout only to `provider === 'cloud'`, while the
   comment in `limits.ts` says Ollama cloud-routed models get it too.
   *Done when:* the timeout follows `localWeights`, or the comment is corrected.
3. **`web_fetch` text loses structure.** `htmlToText` in `src/tools/fetchTool.ts`
   now decodes entities through `src/util/htmlText.ts` (named and numeric), but
   still turns every tag into a space and collapses runs of whitespace, so
   paragraph and line breaks are lost.
   *Done when:* block structure survives — headings, paragraphs, list items and
   `pre` blocks become line breaks. Entity decoding, the SSRF guards and the
   output bounds stay unchanged.

## Next: proposals that need a decision first

- **Persistent agent jobs — the condition-driven half.** The repeating wake
  timer shipped (`src/jobs/**`, `docs/JOBS.md`, `manage_jobs`, and `/jobs` /
  `/job` on Telegram). Still unbuilt: a condition-driven monitor — trigger →
  condition → action → validation → notification, with a deterministic check
  first and a model call only when needed. The design decisions signed off
  2026-09-14 are in `docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md`, which is local
  history and not in the repo.
- **Windows Host Controller ownership.** Decide whether it ships from Forge,
  from HalluScribe, or as a standalone application-neutral repository. Basic
  Telegram remote control must stay independent of it either way.
- **Local image generation beyond the `sdcpp` backend.** A local backend ships
  now (`image_generation.backends`, `sdcpp`, step 10 of `AI_SETUP.md`); cloud
  image generation shipped in 0.16. The ComfyUI plan
  `docs/plans/IMAGE_GENERATION_TOOL_PLAN.md` (local history, not in the repo)
  predates both.

## Gated: open, but not queued until the gate is met

- **Parallel tool dispatch** (MEDIUM). `ToolDispatch.dispatch()` still runs
  calls one at a time (`src/sidebar/ToolDispatch.ts`). The design is in
  Section E of `docs/plans/REVIEW_FOLLOWUP_2026-09-05_PLAN.md`, which is local
  history and not in the repo.
  *Gate:* measured Forge sessions where tool execution, not token generation,
  takes a material share of turn wall-clock time (slow search, cold LSP, MCP
  or network calls). Even then, only reads run concurrently; writes,
  approvals, and stateful tools stay serial. Never use a blanket `Promise.all`.

---

## Removed on 2026-10-27: already implemented, or no longer applicable

| Former item | Where it lives now |
| --- | --- |
| Structured build/test tools are npm-only (`run_tests`, `run_build`, `detectTestRunner`) | Retired into `shell` (`src/sidebar/retiredTools.ts`); no npm-only structured runner remains in `src/tools/**` |
| Persistent agent jobs, Part A (a repeating wake timer) | Shipped: `src/jobs/**`, `docs/JOBS.md`, `manage_jobs`, `/jobs` and `/job` on Telegram |

## Removed on 2026-09-14: already implemented

Kept here for one release so nobody re-adds them from an old review.

| Former item | Where it lives now |
| --- | --- |
| Checkpoint snapshots on disk | `DiskCheckpointStore`, used by `CheckpointStack` for workspace-scale checkpoints |
| `format_file` depends on the active editor | Target-URI `executeFormatDocumentProvider` plus a version-checked `WorkspaceEdit` |
| Git tools need the VS Code Git extension | `runGit` in `src/tools/gitRepo.ts` runs the `git` CLI; the extension only helps discovery |
| FORGE.md hierarchy | `src/llm/forgeInstructionsChain.ts` (FORGE.md / AGENTS.md chain with a shared budget) |
| `/init` for any project | `src/sidebar/initForgeCommand.ts` starts an agent turn that reads the repo and runs its commands, so no language needs a scanner |
| Type while streaming | The prompt textarea is never disabled during a turn (`webview-ui/src/components/InputRow.tsx`) |
