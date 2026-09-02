# Forge LLM

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Efsoo.forge-llm?label=Marketplace&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=Efsoo.forge-llm)
[![Open VSX](https://img.shields.io/open-vsx/v/Efsoo/forge-llm?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/Efsoo/forge-llm)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Efsoo.forge-llm?label=installs)](https://marketplace.visualstudio.com/items?itemName=Efsoo.forge-llm)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

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
- **Depth, not a chat box.** Background execution, LSP-backed code
  intelligence, terminal awareness in both directions, git, vision, and durable
  memory — see [what the agent can do](#what-the-agent-can-do).
- **It follows you out of the room.** Optional Telegram control with
  authenticator-based session locking lets you run a turn, answer its approval
  gate, and read the diff from your phone.

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
- Background execution: start a long command, keep working, monitor it as it runs
- A task plan the agent keeps, re-injected verbatim so a context compaction cannot lose it
- Demand-loaded tool groups, so a large tool surface costs starting context only when used
- Terminal awareness: the agent sees the commands you run and how its own turned out
- Frame extraction from workspace video for vision models (`view_video`, needs ffmpeg)
- Direct `llama-server` lifecycle management
- Ollama local and Ollama cloud routing through the local daemon
- Optional cloud or self-hosted providers: `xai`, `openrouter`, `openai`, `openai-compatible`
- External CLI agents (`provider: cli` — Claude Code, Codex) as full-rights direct-chat models and read-only delegation targets using each CLI's own authentication
- Localhost control server for external orchestrators and shared model lifecycle
- Reasoning token display and optional thinking-channel stripping
- Optional Tavily or Brave web search with keys stored in VS Code SecretStorage
- Local semantic code search and reindex support
- External MCP tool servers: bridge tools from any MCP stdio server into the agent's tool catalog with explicit capability classification
- Optional private-owner remote control through Telegram: local pairing,
  Google Authenticator-compatible session locking, approval gates and live
  progress on your phone — see [run it from your phone](#run-it-from-your-phone)
- LSP-backed code intelligence: definitions, references, implementations,
  diagnostics, code actions, and symbol rename through VS Code's own language servers
- Durable agent memory across sessions (`remember` / `recall`)

## What's New

Forge ships a **Changelog** tab next to this one — that is the full account,
every release. The short version of the last three lines: 0.15 cut the system
prompt and made VRAM-loading delegation ask first, 0.14 made tool schemas
demand-loaded and the prompt prefix stable, 0.13 added background execution and
told you what the backend is doing.

## What the agent can do

More than sixty native tools, all strict-schema, all permission-gated, and all
advertised per round rather than per turn — so a capability you enable becomes
usable immediately. Groups an agent rarely needs are demand-loaded through
`load_tool_group` and cost no context until called.

**Files and edits.** `read_file`, `write_file`, `append_file`, `edit_file` with
batched `edits[]`, `apply_line_edits`, `insert_code`, `create_directory`,
`move_file`, `list_directory`. `delete_file` moves to the recycle bin rather
than destroying. Every write is checkpointed and shown as a diff.

**Code intelligence, through VS Code's own language servers** — not grep
heuristics. `go_to_definition`, `find_references`, `find_implementations`,
`get_hover`, `get_document_symbols`, `get_workspace_symbols`,
`get_diagnostics`, `get_code_actions`, `apply_code_action`, `rename_symbol`,
`format_file`. The agent sees the same analysis your editor does, so it answers
"who implements this?" instead of guessing from a name.

**Search.** `search_code` and `find_files` (both ripgrep — one index, so they
cannot disagree), plus `search_codebase` for local semantic search over your
own embeddings.

**Background execution.** `exec_command` starts a long-running command and
returns immediately; `monitor_execution` reads its output as it accumulates,
`list_executions` recovers an id the agent lost, `stop_execution` ends it. Also
`wait`, for the gap nothing else covers: giving a dev server you just launched
or a file you just wrote a moment to become observable, instead of retrying a
check that cannot succeed yet.

**Terminal awareness, in both directions.** `run_terminal` pastes into your
real terminal and reports how it turned out via shell integration. The agent
also _sees the commands you run yourself_ — including the ones that failed — so
it corrects them in chat instead of asking you to paste output it already has.
`query_powershell` and `run_build` / `run_tests` / `run_workspace_task` /
`list_workspace_tasks` cover the structured cases.

**Git.** `git_status`, `git_diff`, `git_log`, `git_blame`, `git_show` (which
reads a file at any past commit), `stage`, `commit`, `create_branch`,
`switch_branch`.

**Editor context.** `get_editor_context` lets the agent read the file and
selection you are actually looking at; `replace_selection` and `show_diff`
write back into it.

**Vision.** `view_image` for screenshots and diagrams, `view_video` for frames
sampled out of a workspace clip (needs ffmpeg).

**Memory that outlives the conversation.** `remember`, `recall`, and
`list_memories` give the agent durable notes across sessions, separate from
transcript history.

**A task plan that survives compaction.** `update_plan` records the work as
conversation state, re-injected verbatim every round and never summarized — so
a context compaction costs at most one stale item instead of the whole thread.

**Reaching you.** `notify_user` and `show_notification` reach whichever surface
started the turn — the sidebar, or your phone. `ask_user` asks a real question.

**Web, when you configure it.** `web_search` (Tavily or Brave, your key) and
`web_fetch`.

## Run it from your phone

Optional, off by default, and it opens no inbound port: Forge makes an
**outbound** connection to Telegram, and VS Code has to stay running. Full
setup and threat model in
[remote control](docs/REMOTE_CONTROL.md).

Once paired you have a real Forge session in a private chat — send a prompt,
watch live agent and compaction progress, resolve approval gates from the
phone or the desktop (first resolution wins), and send attachments.

**Locked behind two gates.** One exactly-matched provider user ID is paired,
private chats only, group and channel messages fail closed. Pairing is an
eight-digit one-time code that expires in five minutes and stops accepting
guesses after five tries. On top of that, an enrolled
**Google Authenticator-compatible TOTP secret**: the QR is displayed locally and
never sent through Telegram, the session starts locked after every reload,
re-locks on an inactivity timeout you set with `/timeout`, and `/lock` ends it
on demand. Bot token and owner ID live in SecretStorage; the session and its
replay protection are memory-only.

**Built to survive the transport.** Prompts, deduplication records, and the
provider cursor are durable, and the update offset advances only after Forge
has genuinely accepted, handled, rejected or recognised an event as a
duplicate — a dropped connection re-delivers rather than loses, and a
re-delivery is recognised rather than run twice. Final responses go out through
an at-least-once outbox. One fenced lease stops two VS Code windows consuming
the same bot.

**Commands.** `/status`, `/context`, `/stop`, `/steer <prompt>` (jumps the
queue and interrupts the active turn), `/new`, `/list`, `/resume`, `/models`,
`/model`, `/queue`, `/drop`, `/unload`, `/restart`, `/reload`, `/compact`,
`/lock`, `/timeout`, `/clanker on|off`, `/workspace`. Telegram shows the
main ones in its native command menu.

The audit log is metadata only — timestamps, channel, action, request id, and
truncated identity hashes. No prompt text, no responses, no secrets, no paths.

WhatsApp exists as a separately opt-in experimental linked-device adapter.

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

A second VS Code window asking for a model another window already loaded
**borrows that running llama-server** instead of spawning its own. One copy of
the weights in VRAM. The borrowing window takes a lease; the owner will not shut
down while a lease is outstanding, and a lease left behind by a crashed window
is reclaimed once its process is confirmed gone.

Conversations are not shared — each window keeps its own tabs, messages and
checkpoints. **KV cache slots are**, and that is the part that surprises people:
alternating windows evict each other's cached prefix and each pays full prompt
re-processing. Answers stay correct; you lose the cache speedup.
[How sharing behaves in detail](docs/SHARED_RUNTIME.md) covers the slot maths,
what the token counter is really measuring, and why `max_simultaneous_models`
is not the setting for this.

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

## Coding benchmark smoke test

Forge includes a one-task SWE-bench Verified smoke runner. Install the official
`swebench` package and Docker, copy `benchmarks/smoke-task.example.json` to
`benchmarks/smoke-task.json`, and pin one `instance_id` (and dataset revision).
Start the Qwen llama-server normally, then validate without model calls:

```powershell
npm run bench:smoke -- --dry-run
npm run bench:smoke
```

Use `--arms qwen-forge,qwen-minimal` for a local-only rehearsal. Each arm gets
an exact-base disposable checkout and writes logs, patch, evaluator output,
runtime facts, and usage under `results/<run-id>/<arm>/`. The report ranks this
single task only; one task is not a SWE-bench score, and published SWE figures
are not mixed into the local ranking.

Before spending evaluator or agent-session usage, ping both Qwen arms against
the served llama-server:

```powershell
npm run bench:ping
```

The ping command never launches Claude or Codex and stores its reply and server
facts under `results/ping-<run-id>/`.

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

Set `permissions.agents.delegate: true` and the primary agent can use
`ask_local_agent` for a bounded, read-only consultation with another configured
model. A llama.cpp or Ollama delegate receives only the task and the workspace
files you allow, and has no tools; a `provider: cli` delegate uses the
authenticated CLI's own read-only tools, so it can investigate but not edit.
Either way the answer comes back as advisory analysis. Delegation is capped at
120 seconds and 24,000 characters, and a target that would load weights into
local VRAM asks you first.

A `provider: cli` model (Claude Code, Codex) is also a **full-rights direct
chat model**: Forge spawns the already-authenticated CLI locally and it runs
with its OWN tools — Forge does not inject its registry or run its tool loop for
it. Authentication is the CLI's own login, never a key held by Forge, and a
full-access CLI chat is still covered by Forge's checkpoint engine so Keep/Undo
can roll it back.

[Delegation and CLI agents in detail](docs/DELEGATION.md) covers warm-process
lifecycle, cancellation, capacity limits, and the checkpoint settings.

## Slash Commands

Type `/` in chat to open the built-in command list. Forge also contributes commands to the VS Code palette — the full list is in [docs/COMMANDS.md](docs/COMMANDS.md).

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
