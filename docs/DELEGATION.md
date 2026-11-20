# Local delegation and CLI agents

The detail behind the README's summary: warm direct-chat processes, protocol
level cancellation, capacity and idle limits, profile targets, and the external
CLI checkpoint settings. Moved out of `README.md` because that file is also the
Marketplace Overview page and `cli_idle_timeout_ms` is not a selling point.

## Current behavior at a glance

Set `permissions.agents.delegate: true` to let the primary agent use `ask_local_agent`. `list_delegation_targets` returns the eligible targets on demand, ranked by cost, so the full catalog is not carried in the tool schema every turn. The always-visible `ask_local_agent` schema names only configured CLI agents.

| Path | What the target gets | Can it change the workspace? | Time limit | Keep/Undo coverage |
| --- | --- | --- | --- | --- |
| Local delegation (llama.cpp / Ollama, including Ollama `:cloud` models) | The task, plus up to 8 context files sent as text (256 KiB each, 1 MiB total). No tool channel. | No, because the request has no `tools` array. | 120 s | Not needed |
| Cloud delegation (openrouter, openai, openai-compatible) | Same bounded request as local | No | 300 s | Not needed |
| CLI delegation (`provider: cli` via `ask_local_agent`) | The task, the context paths as *suggested starting files*, and a short-reply contract | **Yes.** It runs unrestricted with the CLI's own tools and may read, edit, and run commands. | 600 s | **None.** See the warning below. |
| Direct CLI chat (a `cli` model selected in the sidebar) | The conversation, in a warm per-conversation process | **Yes.** Full-rights external agent. | Per turn | **None.** Forge Keep/Undo is not offered for its edits. |
| Linked `ask_agent` to Claude or Codex | The request sent to the linked CLI session | **Yes.** The session has its own tools. | Per ask | **None.** Forge does not snapshot its workspace. |
| Linked `ask_agent` to Copilot | The request sent to the linked session | **Yes.** The session has its own tools. | Per ask | Forge prepares a workspace checkpoint. |

Every delegated answer is capped at 24,000 characters and truncated from the end. A CLI delegate is asked to keep its reply under ~1,500 characters and to write any longer detail to a file, ending with `REPORT: <path>`.

Delegating to a model that loads local weights asks for confirmation first. `DelegationGate` counts slots, not VRAM. Cloud targets, Ollama `:cloud` models, and CLI targets load no local weights and skip the confirmation. Ollama `:cloud` models do use the 120 s local timeout, even though the comment on `CLOUD_DELEGATION_TIMEOUT_MS` says otherwise.

> **Warning: direct CLI chat and CLI delegation are not covered by Forge Keep/Undo.** Both can edit the live workspace with their own tools. Claude Code's native rewind covers its editing tools but not every shell or subagent change; use Git to recover arbitrary changes. When a CLI delegation errors or times out, the tool result says the work may already be done and returns any partial output, and the caller should check `git status` before retrying.

## Details

Worker dispatch was removed in 0.13.1. `dispatch_workers`,
`list_worker_models`, and the coordinator/worker role hierarchy are gone;
`ask_local_agent` is the single delegation path. `permissions.agents.cloud_workers`
is still accepted so existing configs keep booting, but it grants nothing.

A profile such as `model@reviewer` shares the same underlying backend as `model`.

To consult a different direct llama.cpp model without evicting the primary model, configure enough slots, for example `max_simultaneous_models: 2`. Slot availability prevents Forge from evicting the primary backend, but it does not guarantee the machine has enough RAM or VRAM to load the second model; that is why a local-weights delegation asks first.

A model configured with `provider: cli` (Claude Code, Codex) is a full-rights external agent: Forge spawns the already-authenticated CLI locally, and it runs with its OWN tools — Forge does not inject its tool registry or run its own tool loop for it. `cli` models can be selected for direct sidebar chat and are also valid `ask_local_agent` targets. As a delegate, the CLI can implement a task, not only review it.

Direct CLI chat owns one warm process per conversation/model. Claude uses its stream-json stdin protocol; Codex uses `app-server --stdio`. Tabs remain isolated and may generate concurrently. A delegation reuses a warm process too, keyed separately (`<model>#delegate`) so it never inherits or pollutes the chat transcript, and it sends a complete, self-contained task every time. A completed turn confirms the persistent Claude session ID or Codex thread ID. Claude cancellation terminates its process and cold-resumes the last confirmed session on the next turn; Codex uses `turn/interrupt` and keeps a cleanly interrupted app-server warm. Forge never silently replays a failed turn. Closing a conversation, idle eviction, or extension shutdown disposes the processes it owns. Each delegation is still a one-shot request: independent questions share a process, not a transcript.

Warm direct-chat processes are capped by `max_cli_agents` (default `4`, per VS Code window) and idle processes are disposed after `cli_idle_timeout_ms` (default `900000`, or 15 minutes). When the cap is full, Forge evicts only the least-recently-used idle session; if every session is busy, it surfaces a capacity error. By default Forge passes no model override, so the CLI resolves its own configured/default model. Set optional `cli_model` only when an explicit per-entry override is wanted. A separate extension's per-chat model picker is private state and is not treated as configuration.

Authentication is entirely the CLI's own login (`claude`/`codex`), never a key stored in Forge. Direct CLI chat and linked `ask_agent` calls to Claude or Codex start without a Forge workspace scan or rollback checkpoint. Direct chat status contains no routine checkpoint preparation or finalization rows. Forge's native file tools still take path-local checkpoints. Linked Copilot asks retain their workspace checkpoint, and every workspace checkpoint excludes `.forge` and `.forge-*`.

Checkpoint controls remain explicit VS Code settings for paths that still use disk-backed rollback. `forge.checkpoint.externalCliEnabled` defaults to `true`, `forge.checkpoint.maxBytes` defaults to 2 GiB, `forge.checkpoint.maxFiles` defaults to 100,000 files, and `forge.checkpoint.storagePath` optionally selects an absolute storage directory outside the workspace. These settings do not turn Forge Keep/Undo back on for direct CLI chats. Reload the VS Code window after changing them.

