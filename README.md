LLAMABRIDGE

# Forge

**Local-first AI coding assistant for VS Code powered by llama.cpp, zero cloud, zero telemetry.**

Forge runs GGUF models directly on your machine via `llama-server`. No API key, no subscription, no data leaves your box.

---

## Features

- **Single execute-style workflow**: no mode switching — one conversation, full tool access
- **Multi-tab concurrent streaming**: run multiple independent chats in parallel; switching tabs never cancels a running stream
- **Inline diff viewer**: every file write shows a collapsible red/green diff block in the chat immediately after the tool runs
- **Direct llama.cpp control**: Forge spawns and manages `llama-server`
- **Ollama support**: local Ollama models or Ollama cloud routing — auth via `ollama auth login`, not Forge
- **Isolated backend pools**: llama.cpp and Ollama backends are tracked separately — switching to an Ollama model never stops a running llama-server
- **VRAM management**: closing a tab with a local model prompts to unload it from VRAM immediately
- **Hot model swap**: switch between GGUF or Ollama models without restarting VS Code
- **Per-action confirmation gate**: approve or deny each tool call before it runs
- **Per-turn checkpoints**: Undo or Keep after any turn that writes files
- **Token budget bar**: live used/max context token estimate shown in the header
- **Reasoning token display**: streamed thinking output shown inline when enabled
- **Runtime capability checks**: inspect llama.cpp metadata and warn on mismatched tool/thinking features
- **Thinking-channel stripping**: optionally hide `<think>` and related channel markup
- **Strict tool schemas**: typed JSON Schema for every tool — no free-form string blobs
- **Slash commands in chat**: type `/` to open built-in chat actions
- **Optional web search**: Tavily or Brave via user-supplied API key
- **Bridge mode**: connect to any already-running OpenAI-compatible server

---

## Requirements

- VS Code 1.90 or later
- [`llama-server`](https://github.com/ggerganov/llama.cpp) (for direct GGUF mode)
- One or more local GGUF files, or a running Ollama daemon

---

## Quick Start

### 1. Install the extension

Install **Forge** from the VS Code Marketplace or via the Extensions panel.

### 2. Build llama-server (direct GGUF mode)

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j $(nproc)
```

Skip this step if you are using Ollama only.

### 3. Create config.yaml

Forge looks for a config file at:

`<your-project>/.forge/config.yaml`

If the file is missing, open the sidebar and the setup wizard will generate it, or create it manually:

```yaml
active_model: my-model

llama_server:
  binary: /path/to/llama-server
  host: 127.0.0.1
  port: 8080
  n_gpu_layers: -1
  default_num_ctx: 8192
  n_batch: 512
  n_parallel: 1
  type_k: q8_0
  type_v: q8_0
  flash_attn_default: true

models:
  my-model:
    gguf_path: /path/to/model.gguf
    n_gpu_layers: -1
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

### 4. Open the Forge sidebar

Click the Forge icon in the Activity Bar. The backend starts on the first prompt.

---

## Ollama

Add Ollama models alongside GGUF models in the same config. Auth is handled by `ollama auth login` on your machine — Forge sends no credentials.

```yaml
models:
  gemma4:26b:
    provider: ollama
    endpoint: http://127.0.0.1:11434
    num_ctx: 262144
    think: true
    reasoning_effort: medium       # low | medium | high

  deepseek-v4-flash:cloud:
    provider: ollama
    endpoint: http://127.0.0.1:11434
    num_ctx: 1000000
    think: true
    reasoning_effort: medium
```

Forge merges GGUF and Ollama entries in a single model picker. Ollama backends are tracked in an isolated pool — selecting an Ollama model never stops a running `llama-server`, and vice versa.

---

## VRAM Management

Forge keeps models loaded between prompts so the first message in a follow-up turn is instant. To free VRAM explicitly:

- **Close a tab** — if the model is local (llama.cpp, or Ollama on a local endpoint) and no other open tab uses it, Forge shows a notification: **"[model] is still loaded in VRAM. Unload it to free memory?"** with an **Unload Now** button.
- **`/unloadModel`** — stops all backends immediately and releases everything.
- **`/restartBackend`** — stops then restarts the active llama-server.

> **Note:** closing a tab while another tab uses the same model will not trigger the unload prompt — the model is still in use.

---

## Multi-Tab Concurrent Streaming

Each conversation tab runs its own independent agent loop with a dedicated abort controller. You can:

- Send a prompt in tab A and switch to tab B while it's still generating — tab A keeps streaming in the background
- Cancel a specific tab without affecting others
- See a live indicator on tabs that are currently generating

Switching between tabs never cancels a running stream. Only closing a tab or pressing Cancel within it stops that conversation.

`max_simultaneous_models` (default `1`) controls how many `llama-server` processes stay alive at once. If you open more conversations than the pool limit, the least-recently-used llama.cpp server is evicted when a new model needs to start. Ollama models are not subject to this limit.

---

## Inline Diff Viewer

After every file write (`write_file`, `replace_in_file`, `delete_file`), Forge renders a collapsible diff block directly in the chat:

- **Badge**: `new` / `modified` / `deleted`
- **Path**: file path relative to the workspace root
- **Hunks**: unified diff with 3 lines of context, green `+` for additions, red `−` for removals
- Files over 500 lines fall back to a "file too large to diff inline" notice

The diff uses the per-turn checkpoint snapshot as the before-state, so it always reflects exactly what the agent changed.

---

## Model Behavior

Forge inspects llama.cpp runtime metadata (via `/props`) before sending requests:

- whether the active model exposes a usable chat template
- whether the template likely supports tool calling
- whether the template supports thinking toggles (`enable_thinking`, `preserve_thinking`)

When Forge detects a mismatch it warns in the UI and narrows the request rather than sending incompatible fields. These checks are advisory — GGUF metadata and community templates can still be incomplete.

---

## Checkpoints (Undo / Keep)

After every turn that writes files, Forge shows an **Undo / Keep** bar in the editor via CodeLens.

- **Undo** restores all files modified in that turn to their state before the agent ran
- **Keep** commits the checkpoint and clears the bar

You can also use `/undo` and `/keep` from the chat input, or the command palette (`Forge: Undo Last Turn`, `Forge: Keep Changes`).

---

## Thinking Output

```yaml
models:
  my-model:
    gguf_path: /path/to/model.gguf
    think: true
    strip_thinking_channels: false   # show reasoning inline
```

When `think: true`, reasoning tokens stream into a collapsible block in the UI. When `strip_thinking_channels: true` and `think: false`, Forge strips `<think>...</think>` markers from visible output.

For Ollama models, use `reasoning_effort: low | medium | high` to control the reasoning budget.

---

## Bridge Mode

If you already run your own `llama-server` or any OpenAI-compatible server:

```yaml
bridge_mode: true

llama_server:
  host: 127.0.0.1
  port: 8080
```

In bridge mode Forge connects to the existing process but does not own it — releasing a model from memory is the bridge's responsibility.

---

## Web Search

```text
Command Palette → Forge: Set Search API Key
```

```yaml
search:
  provider: tavily        # or brave
  secret_key_name: forge.tavily.apiKey
  max_results: 5
```

---

## Slash Commands

Type `/` in the chat input to open the command list.

| Command | Description |
| --- | --- |
| `/newChat` | Start a new conversation tab |
| `/clearChat` | Clear the current conversation |
| `/undo` | Restore files from the last write turn |
| `/keep` | Commit the current checkpoint |
| `/compact` | Summarize and compress conversation history |
| `/review` | Run a code review on the current file or selection |
| `/restartBackend` | Restart the managed llama-server process |
| `/unloadModel` | Stop all backends and release models from memory |
| `/reloadWindow` | Reload the VS Code window |

---

## Commands

| Command | Description |
| --- | --- |
| `Forge: Open Sidebar` | Open the Forge panel |
| `Forge: Restart Backend` | Restart `llama-server` |
| `Forge: New Chat` | Open a new conversation tab |
| `Forge: Undo Last Turn` | Restore files from the last write turn |
| `Forge: Keep Changes` | Commit the current checkpoint |
| `Forge: Send Selection to Chat` | Prefill the prompt with the active editor selection |
| `Forge: Set Search API Key` | Store a Tavily or Brave API key |

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `forge.logLevel` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `forge.sidebar.retainContextWhenHidden` | `true` | Keep webview state when the panel is hidden |

---

## Privacy

Forge makes no outbound network calls except to:

- `llama-server` on your configured host
- The local Ollama daemon (`localhost:11434`) when Ollama models are selected
- Your configured search provider when search is enabled and you send a query

There is no telemetry, no analytics, and no auto-update pinging.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
