# Forge LLM

> **The VS Code coding agent built for people who run their own models.**

Load GGUF models through llama.cpp, share one loaded model across VS Code
windows, use tool calling hardened for local-model context limits, and review
file-changing turns with visible diffs and Keep/Undo checkpoints. Forge has no
telemetry and requires no cloud account.

This is the official Forge LLM extension by [Efsoo](https://github.com/Efs-O),
licensed under Apache License 2.0. Cloud and OpenAI-compatible providers are
available only when you explicitly configure them.

## Why Forge

- **First-class llama.cpp control.** Forge starts, monitors, shares, restarts,
  and unloads `llama-server`; it does not treat your local runtime as merely
  another API URL.
- **Tools engineered for local models.** Strict schemas, per-slot context
  budgeting, truncated-call recovery, bounded results, and chunked writes keep
  smaller local models productive through long coding turns.
- **Reversible agent work.** Confirmation gates, inline diffs, and per-turn
  Keep/Undo checkpoints make file-changing actions visible and recoverable.
- **Bring the runtime you prefer.** Use direct GGUF loading, local or
  daemon-routed Ollama, an explicitly configured OpenAI-compatible provider, or
  an already-authenticated Claude Code or Codex CLI.

Local execution is the default. Search, fetch, cloud providers, and external
CLI agents run only when you configure or invoke them, and Forge sends no
telemetry, analytics, or auto-update pings.

![Forge agent loop in action](assets/readme/demo.gif)

## Screenshots

|          Agent loop + Clanker Mode          |                  Model picker                   |
| :-----------------------------------------: | :---------------------------------------------: |
| ![Agent loop](assets/readme/agent-loop.jpg) | ![Model picker](assets/readme/model-picker.jpg) |

|                   Slash commands                    |                  Marketplace                  |
| :-------------------------------------------------: | :-------------------------------------------: |
| ![Slash commands](assets/readme/slash-commands.jpg) | ![Marketplace](assets/readme/marketplace.jpg) |

## Highlights

- Single execute-style workflow with no mode switching
- Multi-tab chat with independent streaming per tab
- Per-action confirmation gate, plus `/clanker` full-auto mode
- Per-turn checkpoints with Keep and Undo
- Inline chat diffs after write tools
- Direct `llama-server` lifecycle management
- Ollama local and Ollama cloud routing through the local daemon
- Optional cloud or self-hosted providers: `xai`, `openrouter`, `openai`, `openai-compatible`
- External CLI agents (`provider: cli` — Claude Code, Codex) as full-rights direct-chat models and read-only delegation targets using each CLI's own authentication
- Localhost control server for external orchestrators and shared model lifecycle
- Reasoning token display and optional thinking-channel stripping
- Optional Tavily or Brave web search with keys stored in VS Code SecretStorage
- Local semantic code search and reindex support
- External MCP tool servers: bridge tools from any MCP stdio server into the agent's tool catalog with explicit capability classification
- Optional private-owner remote control through Telegram; see [remote control setup and security](docs/REMOTE_CONTROL.md)

## What's New Since v0.12.3

- Added opt-in, private-owner remote control with durable FIFO execution, deduplication,
  notification outbox, multi-window fencing, and the existing Forge approval gate
- Added Telegram Bot API long polling with SecretStorage-backed setup and local pairing
- Added an experimental WhatsApp linked-device adapter with encrypted authentication state
- Added OpenAI-compatible cloud-provider support, including `xai`, `openrouter`, `openai`, and generic `openai-compatible`
- Added automatic xAI token resolution and refresh support
- Added localhost control-server support for load-on-demand model orchestration
- Added control-server commands in VS Code for ensure, release, and status
- Expanded Ollama support, including local daemon usage and cloud routing through the local Ollama daemon
- Added shared llama-server runtimes across VS Code windows with explicit ownership, leases, and crash recovery
- Hardened backend lifecycle, readiness, and release behavior
- Added semantic code search reindexing flow and slash command support
- Improved diff display, checkpoint handling, and multi-tab chat behavior
- Added an MCP client bridge (`mcp_servers` in `config.yaml`): tools from external MCP stdio servers are auto-discovered with read-only access by default and can be explicitly classified for sensitive capabilities
- Verified Cerebras Cloud as an `openai-compatible` provider (per-model `endpoint: https://api.cerebras.ai`) and split sampling defaults so cloud providers no longer receive local-only params (`top_k`, `min_p`)
- Added persistent direct-chat CLI sessions: Claude stream-json and Codex app-server processes stay warm per conversation/model, with isolated concurrent tabs, protocol-aware cancellation, cold resume, LRU capacity control, and idle cleanup

## Requirements

- VS Code 1.90 or later
- One of:
  - `llama-server` plus one or more GGUF files
  - a running Ollama daemon
  - an already-running OpenAI-compatible server
  - an explicitly configured cloud provider model
  - an authenticated Claude Code or Codex CLI for `provider: cli`

### Optional: ffmpeg, for `view_video`

The `view_video` tool samples still frames from a workspace video clip and sends
them to a vision model. It needs **ffmpeg and ffprobe** on `PATH` (Windows:
`winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`), or an explicit
`video.ffmpeg_path` in `config.yaml`. Nothing else in Forge uses ffmpeg, so
skip it if you do not need video.

Frames cost prompt tokens — an unscaled 1080p clip can exceed a 16k context on
its own. `video.frame_max_dimension` (default 640) is the knob; see the measured
table in `config/config.example.yaml`.

## Backend Modes

### 1. Direct GGUF mode

Forge starts and manages `llama-server` itself.

Best for:

- local GGUF workflows
- direct control over server args
- keeping everything on your own machine

### 2. Ollama mode

Forge talks to the local Ollama daemon at `http://127.0.0.1:11434`.

Best for:

- local Ollama models
- Ollama cloud routes after `ollama auth login`
- users who want model management outside Forge

### 3. Optional cloud / OpenAI-compatible providers

Forge can also call explicitly configured cloud providers, or any
already-running OpenAI-compatible server (pre-managed local servers, custom
wrappers, external infra) via the `openai-compatible` provider with an
`endpoint`.

Supported provider values:

- `xai`
- `openrouter`
- `openai`
- `openai-compatible`

`openai-compatible` covers any endpoint that speaks the OpenAI chat API — for
example Cerebras Cloud (`endpoint: https://api.cerebras.ai`, key stored in
SecretStorage under the name you set as `api_key_secret`).

This is opt-in. Nothing uses a cloud provider unless you configure a model that points to one and provide its token through VS Code SecretStorage.

## Sharing one llama-server across windows

Opt-in, off unless you enable it:

```yaml
shared_runtime:
  enabled: true
```

With it on, a second VS Code window asking for a model another window already
loaded **borrows that running llama-server** instead of spawning its own. One
copy of the weights in VRAM. The borrowing window takes a lease; the owner will
not shut the server down while a lease is outstanding, and a lease left behind
by a window that crashed is reclaimed once its process is confirmed gone.

### What is and is not shared

**Conversation history is not shared.** Each window keeps its own tabs, its own
messages, its own checkpoints. Windows share the loaded weights, nothing else.

**KV cache slots are shared, and this is the part that surprises people.**
`--parallel` divides `--ctx-size` into N slots, and every borrowing window draws
from that same pool. With the default single slot, two windows take turns on one
cache, and llama.cpp picks up whatever the last conversation left behind by
prefix similarity:

```
slot get_availabl: id 0 | selected slot by LCP similarity, f_sim_best = 0.949
```

Alternating windows evict each other's cached prefix, so each pays full prompt
re-processing — an 8k prompt costs about 10 s of eval on a miss instead of near
zero on a hit. Answers stay correct (the whole prompt is sent every time); you
only lose the cache speedup.

### How the token counter behaves

Each window counts **its own** conversation against `perSlotContext()` —
`num_ctx / n_parallel`, not `num_ctx`. Both windows compute the same per-slot
ceiling and measure only their own messages, so compaction triggers per window
on that window's history. A borrowing window has no idea the other exists.

That number describes the _slot_. With `--parallel 1` there is one slot serving
both windows: neither is over its limit, but they contend for one cache.
Compaction stays correct — it simply cannot see the contention.

### If you have VRAM to spare

`max_simultaneous_models` is **not** the setting for this. It controls how many
_different_ models Forge keeps loaded at once. Two windows asking for the same
model resolve to the same runtime key and share one server regardless — that is
the feature working as designed.

Two real options:

- **Independent servers** — set `shared_runtime.enabled: false`. Each window
  spawns its own llama-server with its own full context and no contention, at
  double the VRAM. That is precisely the cost sharing exists to avoid.
- **Keep sharing, drop the thrashing** — raise `--parallel` to 2 or more so each
  window gets its own slot. `--ctx-size` is the _total_ and gets divided, so
  `--parallel 2` halves each window's context unless you raise `--ctx-size` to
  match.

For two windows on a large card the second option is the better trade: one copy
of the weights, two independent caches.

## Quick Start

### 1. Install the extension

Install Forge from the VS Code Marketplace or Open VSX, or load the packaged VSIX.

### 2. Create `.forge/config.yaml`

Forge looks for:

`<workspace>/.forge/config.yaml`

The setup wizard can generate it for you, or you can start from [`config/config.example.yaml`](config/config.example.yaml).

Minimal direct GGUF example:

```yaml
active_model: my-model

llama_server:
  binary: /path/to/llama-server
  host: 127.0.0.1
  port: 8080
  n_gpu_layers: -1
  default_num_ctx: 32768
  n_batch: 512
  n_parallel: 4
  type_k: q8_0
  type_v: q8_0
  flash_attn_default: true

models:
  my-model:
    gguf_path: /path/to/model.gguf
    num_ctx: 8192
    flash_attn: true
    think: false
    strip_thinking_channels: true
    sampling:
      temperature: 0.6
      top_p: 0.95
      top_k: 64
      max_tokens: 8192
```

Ollama example:

```yaml
models:
  gemma4:26b:
    provider: ollama
    endpoint: http://127.0.0.1:11434
    num_ctx: 262144
    think: true
    reasoning_effort: medium
```

Already-running OpenAI-compatible server example:

```yaml
models:
  my-local-server:
    provider: openai-compatible
    endpoint: http://127.0.0.1:8080/v1
    api_key_secret: my-local-server-token # only if the server requires one
```

For larger examples, including control-server and cloud-provider patterns, use
[`config/config.example.yaml`](config/config.example.yaml).

### 3. Open the sidebar

Click the Forge icon in the activity bar and send a prompt.

If the config is missing or invalid, Forge will guide you through setup instead of silently failing.

## Cloud and Token Setup

Cloud or hosted OpenAI-compatible providers are explicit and credentialed through SecretStorage, not YAML.

- Use `Forge: Set Cloud Provider Token` to store a bearer token.
- Set `api_key_secret` on the model entry in `config.yaml`.
- For `openai-compatible`, also set `endpoint`.

Example:

```yaml
models:
  grok-code-fast:
    provider: xai
    api_key_secret: xai

  hosted-coder:
    provider: openai-compatible
    endpoint: https://example-host/v1
    api_key_secret: hosted-coder-token
```

## Control Server

Forge can expose a localhost model-control API so an external orchestrator can ask it to load a model and report the active endpoint.

Example:

```yaml
control_server:
  enabled: true
  port: 8799
```

Routes:

- `GET /healthz`
- `GET /models`
- `POST /ensure` with `{ "model": "..." }`
- `POST /release` with `{ "model": "..." }`

This is especially useful in multi-process local setups where an external process needs Forge to warm or release a model on demand.

## Search and Semantic Code Search

Forge supports:

- Tavily search
- Brave Search
- local semantic code search with a separate embedding model

Search API keys are stored in VS Code SecretStorage.

Use:

- `Forge: Set Search API Key`
- `/reindex` to rebuild the semantic index

## Image attachments

Image input requires a vision-capable model. For llama.cpp models, configure a
compatible `mmproj_path`; for other providers, declare the `vision` capability
only when that model accepts images. Forge stops before starting a request and
shows this setup guidance when an image is attached to a text-only model.

## Local tool-schema audit

Forge includes an opt-in local-model harness that advertises the same native
tool constructors assembled by `registerAllTools.ts`. It asks the configured
model to emit calls but does not execute handlers or side effects.

```powershell
npm run test:local-tools -- --list
npm run test:local-tools -- --base-url http://127.0.0.1:8080 --strict-args
```

`--strict-args` uses structural comparison, so JSON object-key order is
irrelevant while array order remains significant. External MCP processes are
never started by default. Use `--include-mcp` explicitly (and optionally
`--config <path>`) to include configured MCP schemas in the inventory or model
sweep. Reports identify native versus MCP tools and state that the mode is
schema emission only.

Generate the canonical native coverage matrix by merging dated evidence:

```powershell
npm run test:local-tools -- --list `
  --coverage-report docs/TOOL_COVERAGE.md `
  --model-evidence docs/live-reports/<dated-tool-report>.json `
  --capability-evidence docs/live-reports/<dated-capability-report>.json
```

Add `--include-mcp` for a local, configuration-dependent MCP inventory. The
coordinator, delegation, vision, and semantic-search checks are
hardware-dependent and skipped in ordinary CI. Run them explicitly against a
local model and embedding endpoint:

```powershell
$env:FORGE_LIVE_CAPABILITIES = '1'
$env:FORGE_LIVE_ENDPOINT = 'http://127.0.0.1:8080'
$env:FORGE_LIVE_EMBEDDING_ENDPOINT = 'http://127.0.0.1:8091'
$env:FORGE_LIVE_MODEL = '<configured-model-name>'
$env:FORGE_LIVE_REPORT = 'docs/live-reports/capabilities-YYYY-MM-DD-HHMM.json'
npx vitest run test/live/GemmaCapabilities.live.test.ts --reporter=verbose
```

## MCP Tool Servers

Forge can consume tools from external [MCP](https://modelcontextprotocol.io) stdio servers. Configure them in `config.yaml`:

```yaml
mcp_servers:
  - name: my-mcp-server
    command: C:/path/to/my-mcp-server.exe
    # args: [--flag]              # optional
    # max_result_chars: 24000     # optional; default 24000
    # tool_permissions:           # optional; unlisted tools are read-only
    #   dispatch_subagent: delegate
```

On activation Forge spawns each server, auto-discovers its tools via the MCP handshake, and registers unclassified tools under the read-only permission tier — no per-server code needed. Classify a sensitive tool with `tool_permissions`; for example, `delegate` requires `permissions.agents.delegate: true` before the tool is advertised or dispatched. Connection happens in the background: a slow or missing server binary never delays startup; its tools simply appear on the next chat turn once connected. A server that fails to connect logs an error and shows a warning toast, and duplicate tool names are skipped. Spawned server processes are stdio children of Forge (no network) and are terminated on extension deactivation.

Tool results are capped at `max_result_chars` (default 24000) before entering the conversation — oversized payloads are truncated with a visible marker so a verbose MCP server cannot overflow a local model's per-slot context window (`num_ctx / n_parallel` in direct llama.cpp mode).

## Local Delegation

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

## Slash Commands

Type `/` in chat to open the built-in command list.

| Slash command | What it does                                     |
| ------------- | ------------------------------------------------ |
| `/unload`     | Stop all backends and release loaded models      |
| `/restart`    | Restart or reconnect the backend                 |
| `/reindex`    | Rebuild the local semantic search index          |
| `/new`        | Open a new conversation tab                      |
| `/rename`     | Rename the active conversation                   |
| `/context`    | Add a file, selection, tabs, or files as context |
| `/config`     | Open the active Forge config                     |
| `/logs`       | Show the Forge backend output                    |
| `/clear`      | Clear the active tab only                        |
| `/review`     | Run an immediate review prompt                   |
| `/compact`    | Summarize and compress the current chat          |
| `/undo`       | Restore files from the last checkpoint           |
| `/keep`       | Keep current checkpoint changes                  |
| `/reload`     | Reload the VS Code window                        |
| `/initForge`  | Generate the active repository's `FORGE.md`      |
| `/clanker`    | Toggle full-auto mode for confirmations          |

## VS Code Commands

These commands are currently contributed by the extension.

### Core sidebar and backend

| Command                       | Description                          |
| ----------------------------- | ------------------------------------ |
| `Forge: Open Sidebar`         | Open the Forge sidebar               |
| `Forge: Start Backend`        | Start the active backend             |
| `Forge: Stop Backend`         | Stop the active backend              |
| `Forge: Show Backend Console` | Reveal backend logs or console       |
| `Forge: Restart Backend`      | Restart the managed backend          |
| `Forge: Open Config`          | Open the active config file          |
| `Forge: Validate Config`      | Validate the active config           |
| `Forge: Pick Model`           | Pick the active model                |
| `Forge: Pick GGUF Model File` | Pick a GGUF file during setup        |
| `Forge: Setup Wizard`         | Run the first-run or repair flow     |
| `Forge: Unload Model`         | Stop all backends and release models |
| `Forge: New Chat`             | Open a new conversation tab          |
| `Forge: Clear Active Chat`    | Clear the active tab                 |
| `Forge: Undo Last Turn`       | Restore the previous checkpoint      |
| `Forge: Keep Changes`         | Accept the current checkpoint        |

### Control-server commands

| Command                                | Description                                  |
| -------------------------------------- | -------------------------------------------- |
| `Forge: Ensure Model (load on demand)` | Ask the control server to load a model       |
| `Forge: Release Model`                 | Ask the control server to release a model    |
| `Forge: Control Server Status`         | Show control-server status and active models |

### Tokens, search, and setup helpers

| Command                           | Description                         |
| --------------------------------- | ----------------------------------- |
| `Forge: Set Search API Key`       | Store a Tavily or Brave API key     |
| `Forge: Set Cloud Provider Token` | Store a cloud-provider bearer token |

### Editor and review helpers

| Command                                   | Description                                  |
| ----------------------------------------- | -------------------------------------------- |
| `Forge: Explain Selection`                | Explain the active selection                 |
| `Forge: Review Selection`                 | Review the active selection                  |
| `Forge: Generate Tests For Selection`     | Draft tests for the selection                |
| `Forge: Refactor Selection`               | Refactor the selection                       |
| `Forge: Run Explain Selection`            | Execute the explain flow immediately         |
| `Forge: Run Review Selection`             | Execute the review flow immediately          |
| `Forge: Run Generate Tests For Selection` | Execute the test-generation flow immediately |
| `Forge: Run Refactor Selection`           | Execute the refactor flow immediately        |
| `Forge: Explain Diagnostic`               | Explain an editor diagnostic                 |
| `Forge: Propose Fix For Diagnostic`       | Draft a fix for a diagnostic                 |
| `Forge: Run Fix For Diagnostic`           | Execute a fix flow for a diagnostic          |
| `Forge: Propose Fix For File Diagnostics` | Review diagnostics across the active file    |
| `Forge: Use Current File As Context`      | Prefill context with the current file        |
| `Forge: Use Selection As Context`         | Prefill context with the selection           |
| `Forge: Use Open Tabs As Context`         | Prefill context from open tabs               |
| `Forge: Pick Files For Context`           | Pick context files manually                  |
| `Forge: Draft Plan In Scratch Document`   | Generate a planning scratch doc              |
| `Forge: Draft Review In Scratch Document` | Generate a review scratch doc                |

## Checkpoints, Diffs, and Clanker Mode

- Every write turn can produce a checkpoint that you can Keep or Undo.
- External Claude/Codex turns become backend-ready only after their rollback checkpoint is safely prepared. Preparation and finalization progress appears in the chat activity stream.
- When `forge.checkpoint.externalCliEnabled` is explicitly disabled, external Claude/Codex turns start without scanning the workspace and without Forge Keep/Undo coverage; the chat activity stream displays a warning.
- External CLI checkpoints are isolated by conversation, stored outside the workspace, and removed on Keep, successful Undo, conversation close, or normal extension shutdown.
- If workspace contents change concurrently while Forge is preparing or finalizing a checkpoint, Forge stops and surfaces the conflict rather than claiming unsafe rollback coverage.
- Undo restores each requested mutation path to its state at the start of the turn. For tools that create missing parent directories, those empty implementation-created parents may remain after undo; requested files and directories are restored or removed exactly.
- File writes produce inline diff cards in the chat.
- Confirmation gates protect writes, terminal actions, and git actions.
- `/clanker` disables those prompts for the session, except recursive deletes which still require approval.

## Responsibility and Risk

**Forge runs an AI agent that edits and deletes files, runs commands, and makes
git changes on your machine. Use it at your own risk. The authors accept no
responsibility for lost work, deleted or corrupted files, destructive commands,
unwanted git operations, leaked information, or any other damage or loss
arising from its use.** This restates in plain language what the Apache 2.0
licence already says: the software is provided "AS IS", WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, and no contributor is liable for any damages. See
sections 7 and 8 of [LICENSE](LICENSE).

Forge takes the safety measures it reasonably can, and you should understand
what each one does and does not cover:

- **Confirmation gates** on writes, terminal actions, and git actions. `/clanker`
  turns these off for the session — recursive deletes still ask.
- **Per-turn checkpoints** with Keep/Undo. Undo restores the paths a turn
  mutated; it is not a backup, does not cover changes made outside Forge, and
  external CLI turns are only covered when checkpoint preparation succeeds.
- **A command denylist** for destructive git and shell operations, and
  **deny-by-default tool permissions** you opt out of in `config.yaml`.
- **An SSRF-guarded, GET-only fetch** and no outbound traffic beyond the
  endpoints you configure.

None of this makes an agent safe to point at work you cannot afford to lose.
A model can misread an instruction, a path can resolve somewhere you did not
expect, and content fetched from the web or read out of a repository can carry
prompt injection that redirects the agent. Granting `exec.headless`,
`fs.delete`, or `git.write` hands real capability to a process that will
sometimes be wrong. **Use version control, commit before large agent runs, and
keep backups of anything that matters.**

## Privacy

Forge does not send telemetry, analytics, or auto-update pings.

Outbound traffic is limited to the endpoints you explicitly use:

- local `llama-server`
- local Ollama daemon
- an explicitly configured cloud or OpenAI-compatible provider endpoint
- Tavily or Brave if search is enabled
- user-approved fetch targets
- an authenticated Claude Code or Codex CLI agent you explicitly invoke; that CLI uses its own tools and network configuration

Configured MCP servers run as local stdio child processes — Forge sends them no network traffic.

## Development

Quality gates:

```bash
npm run ci
npm run package
```

## License

Apache 2.0. See [LICENSE](LICENSE).
