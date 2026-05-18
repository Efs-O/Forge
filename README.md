# Forge

**Local-first AI coding assistant for VS Code powered by llama.cpp, zero cloud, zero telemetry.**

Forge runs GGUF models directly on your machine via `llama-server`. No API key, no subscription, no data leaves your box.

---

## Features

- **Three modes**: Ask, Plan, Execute
- **Direct llama.cpp control**: Forge spawns and manages `llama-server`
- **Hot model swap**: switch between GGUF models without restarting VS Code
- **Runtime template capability checks**: inspect llama.cpp metadata and warn or gate mismatched tool/thinking features
- **Thinking-channel stripping**: optionally hide `<think>` and related channel markup when thinking is disabled
- **Strict tool schemas**: typed JSON Schema for every tool
- **Per-turn checkpoints**: Undo or Keep after write turns
- **Slash commands in chat**: type `/` in the prompt box to open built-in chat actions
- **Optional web search**: Tavily or Brave via user-supplied API key
- **Bridge mode**: connect to any already-running OpenAI-compatible server

---

## Requirements

- VS Code 1.90 or later
- [`llama-server`](https://github.com/ggerganov/llama.cpp)
- One or more local GGUF files

---

## Quick Start

### 1. Install the extension

Install **Forge** from the VS Code Marketplace or via the Extensions panel.

### 2. Build llama-server

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j $(nproc)
```

### 3. Create config.yaml

Forge uses a workspace config at:

`<your-project>/.forge/config.yaml`

If the file is missing, open the sidebar and let the setup wizard generate it, or create it manually:

```yaml
active_model: my-model
bridge_config: ../bridge.yaml

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
  - name: my-model
    provider: llama.cpp
    gguf_path: /path/to/model.gguf
    n_gpu_layers: -1
    num_ctx: 8192
    flash_attn: true
    think: false
    strip_thinking_channels: true
```

Forge falls back to VS Code global storage only if no workspace `.forge/config.yaml` exists.

If you want Forge to show Ollama and GGUF models in one selector, add those Ollama entries to `bridge.yaml` and point `bridge_config` at that file. Forge merges `config.yaml` and `bridge.yaml`, sorts the combined list alphabetically, and keeps the selector passive until you press `Send`.

### 4. Open the Forge sidebar

Click the Forge icon in the Activity Bar. The backend starts on the first prompt.

---

## Model Behavior

Forge inspects llama.cpp runtime metadata when available, primarily through `/props`, and derives a few practical checks before requests are sent:

- whether the active model exposes a usable chat template
- whether the current template likely supports tool calling
- whether the current template likely supports thinking toggles such as `enable_thinking` and `preserve_thinking`

When Forge detects a mismatch, it warns in the UI and narrows the request instead of blindly sending incompatible fields. These checks are advisory, not perfect: GGUF metadata and community templates can still be incomplete or stale.

---

## Modes

| Mode | Tools available | Use for |
| --- | --- | --- |
| Ask | Web search (optional) | Questions, explanations, review |
| Plan | File reads + web search | Analysis, architecture, planning |
| Execute | File reads + writes + terminal + search | Implementation and refactors |

---

## Checkpoints

After every Execute turn that writes files, Forge shows an **Undo / Keep** bar.

- **Undo** restores files modified in the last turn
- **Keep** commits the checkpoint

---

## Thinking Output

Forge supports `think`, `preserve_thinking`, and `strip_thinking_channels`.

`strip_thinking_channels` can be set globally or per model:

```yaml
strip_thinking_channels: true

models:
  - name: my-model
    gguf_path: /path/to/model.gguf
    think: false
    strip_thinking_channels: true
```

When the effective strip setting is `true` and the active model has `think: false`, Forge strips streamed thinking/channel markers such as `<think>...</think>` from visible assistant output. When `think: true`, Forge does not strip them.

---

## Bridge Mode

If you already run your own `llama-server` or another OpenAI-compatible server, set `bridge_mode: true` in `.forge/config.yaml`.

```yaml
bridge_mode: true

llama_server:
  host: 127.0.0.1
  port: 8080
```

In bridge mode, Forge can disconnect from the server, but it does not own the external process. Releasing the model from memory must be handled by that external bridge or server.

## Ollama

Forge can mix Ollama entries with GGUF entries in the same model picker. Ollama models should be defined in `bridge.yaml` with explicit provider and endpoint values:

```yaml
models:
  gemma4:26b:
    provider: ollama
    endpoint: http://127.0.0.1:11434
    num_ctx: 100000
    think: true
    reasoning_effort: medium
```

Selection does not unload anything by itself. Forge only releases the currently loaded model when you press `Send` with a different target model selected.

---

## Web Search

Store your API key with:

```text
Command Palette -> Forge: Set Search API Key
```

Then configure the provider in `.forge/config.yaml`:

```yaml
search:
  provider: tavily
  secret_key_name: forge.tavily.apiKey
  max_results: 5
```

---

## Chat Commands

Type `/` in the chat input to open a slash-command list. Current built-in command:

| Slash command | Description |
| --- | --- |
| `/unload` | Stop the Forge-managed backend and release the active model from memory |

This command menu is intended to grow over time, so new chat actions can be added without overloading the VS Code command palette.

---

## Commands

| Command | Description |
| --- | --- |
| `Forge: Open Sidebar` | Open the Forge panel |
| `Forge: Restart Backend` | Restart `llama-server` |
| `Forge: New Chat` | Clear conversation history |
| `Forge: Undo Last Turn` | Restore files from the last Execute turn |
| `Forge: Keep Changes` | Commit the current checkpoint |
| `Forge: Send Selection to Chat` | Prefill the prompt with the active editor selection |
| `Forge: Set Search API Key` | Store a Tavily or Brave API key |

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `forge.defaultMode` | `ask` | Mode on activation |
| `forge.logLevel` | `info` | Log verbosity |
| `forge.sidebar.retainContextWhenHidden` | `true` | Keep webview state when hidden |

---

## Privacy

Forge makes no outbound network calls except to:

- `llama-server` on your configured host
- Your configured search provider when search is enabled

There is no telemetry, no analytics, and no auto-update pinging.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
