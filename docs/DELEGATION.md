# Local delegation and CLI agents

The detail behind the README's summary: warm direct-chat processes, protocol
level cancellation, capacity and idle limits, profile targets, and the external
CLI checkpoint settings. Moved out of `README.md` because that file is also the
Marketplace Overview page and `cli_idle_timeout_ms` is not a selling point.

Set `permissions.agents.delegate: true` to let the primary agent use `ask_local_agent` for a bounded, read-only consultation with another configured model. A regular llama.cpp or Ollama delegate receives only the task and selected workspace files and has no tools. A `provider: cli` delegate instead uses the authenticated CLI's own read-only tool set, so it can inspect files and run non-mutating investigations but cannot edit the workspace. In both cases, the response is advisory analysis returned to the primary conversation.

Worker dispatch was removed in 0.13.1. `dispatch_workers`,
`list_worker_models`, and the coordinator/worker role hierarchy are gone;
`ask_local_agent` is the single delegation path. `permissions.agents.cloud_workers`
is still accepted so existing configs keep booting, but it grants nothing.

A profile such as `model@reviewer` shares the same underlying backend as `model`.

To consult a different direct llama.cpp model without evicting the primary model, configure enough slots, for example `max_simultaneous_models: 2`. Slot availability prevents Forge from evicting the primary backend, but it does not guarantee the machine has enough RAM or VRAM to load the second model. Delegation is limited to 120 seconds and returned analysis is capped at 24,000 characters.

A model configured with `provider: cli` (Claude Code, Codex) is a full-rights external agent: Forge spawns the already-authenticated CLI locally, and it runs with its OWN tools — Forge does not inject its tool registry or run its own tool loop for it. `cli` models can be selected for direct sidebar chat and are also valid `ask_local_agent` targets.

Direct CLI chat owns one warm process per conversation/model. Claude uses its stream-json stdin protocol; Codex uses `app-server --stdio`. Tabs remain isolated and may generate concurrently. A completed turn confirms the persistent Claude session ID or Codex thread ID. Claude cancellation terminates its process and cold-resumes the last confirmed session on the next turn; Codex uses `turn/interrupt` and keeps a cleanly interrupted app-server warm. Forge never silently replays a failed turn. Closing a conversation, idle eviction, or extension shutdown disposes the processes it owns. Delegation deliberately remains one-shot.

Warm direct-chat processes are capped by `max_cli_agents` (default `4`, per VS Code window) and idle processes are disposed after `cli_idle_timeout_ms` (default `900000`, or 15 minutes). When the cap is full, Forge evicts only the least-recently-used idle session; if every session is busy, it surfaces a capacity error. By default Forge passes no model override, so the CLI resolves its own configured/default model. Set optional `cli_model` only when an explicit per-entry override is wanted. A separate extension's per-chat model picker is private state and is not treated as configuration.

Authentication is entirely the CLI's own login (`claude`/`codex`), never a key stored in Forge. Before an unrestricted direct-chat CLI starts, Forge inventories the eligible workspace and streams a rollback baseline to Forge-owned disk storage in bounded chunks; it does not retain the workspace as an extension-host memory snapshot. Full-access direct CLI chats use the same checkpoint engine over their eligible workspace paths. Finalization hashes covered files and retains only preimages needed for changed paths. Forge always excludes `.forge` and `.forge-*` from workspace checkpoints.

External CLI checkpoint controls are explicit VS Code settings. `forge.checkpoint.externalCliEnabled` defaults to `true`, `forge.checkpoint.maxBytes` defaults to 2 GiB, `forge.checkpoint.maxFiles` defaults to 100,000 files, and `forge.checkpoint.storagePath` optionally selects an absolute storage directory outside the workspace. Forge checks capacity before launch and refuses the turn with a measured error when safe rollback coverage cannot be established. As an explicit temporary opt-out, setting `forge.checkpoint.externalCliEnabled` to `false` skips the external CLI scan and checkpoint; Forge displays a warning and Keep/Undo cannot restore that CLI's changes. Forge-native tools retain per-file checkpoints. Reload the VS Code window after changing these settings.

