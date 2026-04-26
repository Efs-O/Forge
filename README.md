# Forge

**Local-first AI coding assistant for VS Code — powered by llama.cpp, zero cloud, zero telemetry.**

Forge runs GGUF models directly on your machine via `llama-server`. No API key, no subscription, no data ever leaves your box.

---

## Features

- **Three modes** — Ask (read-only chat), Plan (file reads + analysis), Execute (full tool access: read, write, search)
- **Direct llama.cpp control** — Forge spawns and manages `llama-server` for you, with per-model GPU layer, context size, and KV-cache overrides
- **Hot model swap** — switch between GGUF models without restarting VS Code
- **Strict tool schemas** — every agent tool uses typed JSON Schema; no free-form string blobs that confuse local models
- **Per-turn checkpoints** — every agentic turn snapshots modified files before writing; one click to Undo or Keep
- **Optional web search** — Tavily or Brave Search (bring your own API key, stored in VS Code `SecretStorage`)
- **Bridge mode** — connect to any already-running OpenAI-compatible server (LM Studio, your own `llama-server`, etc.)

---

## Requirements

- VS Code 1.90 or later
- [`llama-server`](https://github.com/ggerganov/llama.cpp) built from source (or a pre-built binary)
- One or more GGUF model files on local disk

---

## Quick Start

### 1. Install the extension

Install **Forge** from the VS Code Marketplace or via the Extensions panel.

### 2. Build llama-server

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON   # drop -DGGML_CUDA=ON for CPU-only
cmake --build build --config Release -j $(nproc)
# binary: build/bin/llama-server
```

### 3. Create config.yaml

Forge reads its config from VS Code's global storage:

| Platform | Path |
| -------- | ---- |
| Windows  | `%APPDATA%\Code\User\globalStorage\efs-o.forge\config.yaml` |
| Linux    | `~/.config/Code/User/globalStorage/efs-o.forge/config.yaml` |
| macOS    | `~/Library/Application Support/Code/User/globalStorage/efs-o.forge/config.yaml` |

Start from the bundled example (Command Palette → **Forge: Open Sidebar**, then check the output panel for the exact path):

```yaml
active_model: my-model

llama_server:
  binary: /path/to/llama-server
  host: 127.0.0.1
  port: 8080
  n_gpu_layers: -1          # -1 = offload all layers to GPU
  default_num_ctx: 8192
  n_batch: 512
  n_parallel: 1
  type_k: 8                 # q8_0 KV cache
  type_v: 8
  flash_attn_default: true

models:
  - name: my-model
    gguf_path: /path/to/model.gguf
    n_gpu_layers: -1
    num_ctx: 8192
    flash_attn: true
```

### 4. Open the Forge sidebar

Click the Forge icon in the Activity Bar. The extension starts `llama-server` automatically and shows **Backend ready** when it is accepting requests.

---

## Modes

| Mode    | Tools available                        | Use for                              |
| ------- | -------------------------------------- | ------------------------------------ |
| Ask     | Web search (optional)                  | Questions, explanations, code review |
| Plan    | File reads + web search                | Architecture, analysis, step-by-step plans |
| Execute | File reads + writes + terminal + search | Implementing, refactoring, multi-file edits |

Switch modes with the dropdown in the Forge header. The system prompt and sampling parameters adjust automatically per mode.

---

## Checkpoints (Undo / Keep)

After every **Execute** turn that writes files, Forge shows an **Undo / Keep** bar:

- **Undo** — restores all files modified in the last turn to their state before the turn ran
- **Keep** — commits the checkpoint; the turn cannot be undone after this

You can also trigger these from the Command Palette: **Forge: Undo Last Turn** / **Forge: Keep Changes**.

---

## Bridge Mode

If you already run your own `llama-server` (or any OpenAI-compatible server), set `bridge_mode: true` in `config.yaml`. Forge will connect to `llama_server.host:port` instead of spawning its own process.

```yaml
bridge_mode: true

llama_server:
  host: 127.0.0.1
  port: 8080
  # binary is not required in bridge mode
```

---

## Web Search (optional)

Forge supports **Tavily** and **Brave Search**. Store your key securely:

```
Command Palette → Forge: Set Search API Key
```

Then configure the provider in `config.yaml`:

```yaml
search:
  provider: tavily          # or: brave
  secret_key_name: forge.tavily.apiKey
  max_results: 5
```

The `web_search` tool is available in Ask and Plan modes automatically once search is configured.

---

## Commands

| Command | Description |
| ------- | ----------- |
| `Forge: Open Sidebar` | Open the Forge panel |
| `Forge: Restart Backend` | Stop and restart `llama-server` |
| `Forge: New Chat` | Clear history and start a fresh conversation |
| `Forge: Undo Last Turn` | Restore files modified in the last Execute turn |
| `Forge: Keep Changes` | Commit the current checkpoint |
| `Forge: Set Search API Key` | Store a Tavily or Brave API key in SecretStorage |

---

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `forge.defaultMode` | `ask` | Mode on activation (`ask` / `plan` / `execute`) |
| `forge.logLevel` | `info` | Log verbosity (`trace` / `debug` / `info` / `warn` / `error`) |
| `forge.sidebar.retainContextWhenHidden` | `true` | Keep webview state when the sidebar is hidden |

---

## Privacy

Forge makes **no outbound network calls** except to:

- `llama-server` on `localhost` (or your configured host)
- Your configured search provider, only when the `web_search` tool is called

There is no telemetry, no auto-update pinging, no analytics of any kind.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
