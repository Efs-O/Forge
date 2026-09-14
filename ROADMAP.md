# Forge — Roadmap

**Last verified against code:** 2026-09-14 (0.16.0). Every item names the file
that shows the gap and what "done" means. Shipped work belongs in
[CHANGES.md](CHANGES.md), not here. An item stays only while the gap is still
in the code.

---

## Now: verified gaps, ready to implement

1. **CLI delegation has no rollback checkpoint.** Direct CLI chat snapshots the
   workspace before the CLI starts (`snapshotWorkspaceBefore` in
   `src/agents/CliChatRunner.ts`). `runCliDelegation` in
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
3. **Structured build/test tools are npm-only.** `run_tests` and `run_build`
   always use `npm`/`npx`. `exec_command` can already run pnpm, yarn, or bun
   by hand.
   *Done when:* the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`)
   selects the runner, and the result names the runner it used.
4. **`web_fetch` text is garbled on real pages.** `htmlToText` in
   `src/tools/fetchTool.ts` strips tags with regex, so entities stay encoded
   and paragraph and line breaks are lost.
   *Done when:* entities decode and block structure survives. SSRF guards and
   output bounds stay unchanged.

## Next: proposals that need a decision first

- **Persistent agent jobs** (scheduled or condition-driven monitors).
  Trigger → condition → action → validation → notification, with a
  deterministic check first and a model call only when needed. Design notes
  are in §1.11 of
  [the 0.16 audit](docs/DOCUMENTATION_AND_ROADMAP_AUDIT_0.16.md). Two
  decisions come before any plan: where the scheduler lives (extension host or
  an always-on service), and what "Act" mode may do unattended.
- **Windows Host Controller ownership.** Decide whether it ships from Forge,
  from HalluScribe, or as a standalone application-neutral repository. Basic
  Telegram remote control must stay independent of it either way.
- **Local image generation backend** (ComfyUI).
  [Plan](docs/plans/IMAGE_GENERATION_TOOL_PLAN.md) exists; cloud image
  generation shipped in 0.16.

## Gated: open, but not queued until the gate is met

- **Parallel tool dispatch** (MEDIUM). `ToolDispatch.dispatch()` still runs
  calls one at a time (`src/sidebar/ToolDispatch.ts`). The design is in
  Section E of
  [REVIEW_FOLLOWUP_2026-09-05_PLAN.md](docs/plans/REVIEW_FOLLOWUP_2026-09-05_PLAN.md).
  *Gate:* measured Forge sessions where tool execution, not token generation,
  takes a material share of turn wall-clock time (slow search, cold LSP, MCP
  or network calls). Even then, only reads run concurrently; writes,
  approvals, and stateful tools stay serial. Never use a blanket `Promise.all`.

---

## Removed on 2026-09-14: already implemented

Kept here for one release so nobody re-adds them from an old review.

| Former item | Where it lives now |
| --- | --- |
| Checkpoint snapshots on disk | `DiskCheckpointStore`, used by `CheckpointStack` for workspace-scale checkpoints |
| `format_file` depends on the active editor | Target-URI `executeFormatDocumentProvider` plus a version-checked `WorkspaceEdit` |
| Git tools need the VS Code Git extension | `runGit` in `src/tools/gitRepo.ts` runs the `git` CLI; the extension only helps discovery |
| FORGE.md hierarchy | `src/llm/forgeInstructionsChain.ts` (FORGE.md / AGENTS.md chain with a shared budget) |
| `/initForge` for non-JS projects | `SlashCommandHandler` scans `pyproject.toml`, `Cargo.toml`, `go.mod` |
| `/initForge` tool-call JSON output | `extractMarkdownFromToolCall` fallback |
| Type while streaming | The prompt textarea is never disabled during a turn (`webview-ui/src/components/InputRow.tsx`) |
