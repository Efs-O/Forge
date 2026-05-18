# Forge

**Local-first AI coding assistant for VS Code powered by llama.cpp, zero cloud, zero telemetry.**

Forge runs GGUF models directly on your machine via `llama-server`. No API key, no subscription, no data leaves your box.

---

## Features

- **Single execute-style workflow**: no mode switching — one conversation, full tool access
- **Multi-tab conversations**: run multiple independent chats in parallel
- **Direct llama.cpp control**: Forge spawns and manages `llama-server`
- **Ollama support**: use local Ollama models or Ollama cloud routing — auth handled by `ollama auth login`, not Forge
- **Hot model swap**: switch between GGUF or Ollama models without restarting VS Code
- **Per-action confirmation gate**: approve or deny each tool call before it runs
- **Per-turn checkpoints**: Undo or Keep after any turn that writes files
- **Reasoning token display**: streamed thinking output shown inline when enabled
- **Runtime template capability checks**: inspect llama.cpp metadata and warn on mismatched tool/thinking features
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

Forge uses a workspace config at:

`<your-project>/.forge/config.yaml`

If the file is missing, open the sidebar and let the setup wizard generate it, or create it manually:

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
    reasoning_effort: medium

  gemma4:26b-cloud:
    provider: ollama
    endpoint: http://127.0.0.1:11434
    num_ctx: 262144
    think: true
```

Forge merges GGUF and Ollama entries in a single model picker. Model selection does not unload anything — Forge releases the current model on the next `Send` if you switched targets.

---

## Model Behavior

Forge inspects llama.cpp runtime metadata (primarily via `/props`) before sending requests:

- whether the active model exposes a usable chat template
- whether the template likely supports tool calling
- whether the template supports thinking toggles (`enable_thinking`, `preserve_thinking`)

When Forge detects a mismatch it warns in the UI and narrows the request rather than sending incompatible fields. These checks are advisory — GGUF metadata and community templates can still be incomplete.

---

## Checkpoints

After every turn that writes files, Forge shows an **Undo / Keep** bar in the editor.

- **Undo** restores all files modified in that turn
- **Keep** commits the checkpoint and clears the bar

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
| `/unloadModel` | Stop the backend and release the model from memory |
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
