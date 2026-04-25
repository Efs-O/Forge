# continue-llamacpp-bridge

A minimal FastAPI bridge that connects the [Continue](https://github.com/continuedev/continue) AI coding assistant to a local [llama.cpp](https://github.com/ggerganov/llama.cpp) `llama-server`. Exposes OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints, automatically starts and hot-swaps GGUF models based on which model Continue requests, and supports streaming, thinking mode, and per-model sampling parameters — all configured through a single YAML file.

There are **no optional heavy dependencies**: only PyYAML, httpx, FastAPI, uvicorn, and requests.

## What it does

- Listens on `bind_host` / `bind_port` from your YAML.
- **`GET /v1/models`**: model ids are the keys under `models:` in the YAML.
- **`POST /v1/chat/completions`**: checks the Bearer `api_key`, ensures the right GGUF is loaded in `llama-server`, rewrites the request for upstream (including optional thinking and YAML `sampling`), then proxies to `llama-server`.

## Install

```bash
python -m venv .venv
# Windows:
.\.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -e .
```

## Run

```bash
continue-llamacpp-bridge config/bridge.yaml
```

Or:

```bash
python -m continue_llamacpp_bridge config/bridge.yaml
```

Add `--debug` for verbose logs and llama-server stdout/stderr on the terminal. In that mode, **streaming** chat logs each SSE text delta at DEBUG, and logs **`usage`** (prompt/completion token counts) plus a **rough** `num_ctx - prompt - completion` estimate **when the upstream JSON includes a `usage` object** (many OpenAI-style streams omit it until the last chunk, or omit it entirely; non-streaming responses are parsed the same way when `--debug` is on).

From a git clone **without** installing the package, you can still run:

```bash
python scripts/continue_llamacpp_bridge.py config/bridge.yaml
```

(that script adds the repo root to `sys.path` and invokes the same CLI).

## Configure Continue

In Continue's config, use provider **OpenAI**, set **API base** to `http://127.0.0.1:<bind_port>/v1` (match your YAML), **API key** to the same string as `api_key` in the YAML, and pick a **model** id that matches a key under `models:`.

## Which YAML to edit

You use **two** configuration files. Neither replaces the other; they are read by **different** programs.

| What you want to change | Edit this file |
|-------------------------|----------------|
| Where Continue sends requests (URL), API key string Continue sends, default model **alias** in the IDE | Continue's **`config.yaml`** (Continue's own config) |
| `llama-server` binary path, listen host/port for **llama-server**, GPU layers, default batch/context, GGUF paths, per-model `num_ctx` / `n_batch` / `think` / `sampling` | The **bridge YAML** (the path you pass to `continue-llamacpp-bridge`, e.g. `config/bridge.yaml`) |

**Flow:** Continue reads **its** `config.yaml` and calls your bridge over HTTP. The bridge reads **only** the YAML path you gave on the command line, starts or reuses `llama-server`, then forwards `/v1/chat/completions` to it.

### If the same generation flags appear in both places

Continue may send OpenAI-style fields in the chat request body (`temperature`, `top_p`, `max_tokens`, and so on). The bridge **copies** that body, then merges `models.<alias>.sampling` from the **bridge YAML** on top.

- For any key **listed** under `sampling` in the bridge YAML, **the bridge YAML wins** for that request.
- For keys **not** listed there, values from Continue's request **pass through** unchanged (if Continue sent them).

**Only the bridge YAML** controls `llama_server` argv, `gguf_path`, `num_ctx`, `flash_attn`, `think`, and `extra_llama_server_args`. Continue's `config.yaml` does not set those; it only chooses the **model alias** string that must match a key under `models:` in the bridge YAML.

### Optional: keep Continue's YAML thin, put "main" flags in the bridge

You cannot change Continue's config **schema** (Continue still needs a valid `config.yaml` it understands), but you **can** use a **minimal** Continue file:

- **In Continue `config.yaml`:** only what Continue requires to route traffic — `provider: openai`, `apiBase`, `apiKey`, `model` (alias), and `roles` such as `chat`, `edit`, `apply` (and `embed` on a **separate** model entry if you use embeddings).
- **In the bridge YAML:** everything that actually defines the run — GGUF path, `num_ctx`, `n_batch`, `think`, `sampling`, `llama_server`, etc.

Omit `defaultCompletionOptions` on the bridge-backed model in Continue if you want generation knobs to live **only** in the bridge YAML `sampling` block. Continue (or its UI) may still send some fields in the HTTP body; anything you list under bridge `sampling` still **overrides** those for each request.

**Embeddings:** this bridge exposes **`/v1/models`** and **`/v1/chat/completions`** only. It does **not** implement **`/v1/embeddings`**, so a model with `roles: [embed]` cannot use this same HTTP server unless you add embedding support or use another provider for embed (see `config/continue.example.yaml` for a split example).

See **`config/continue.example.yaml`** for a starter Continue config (paths: `%USERPROFILE%\.continue\config.yaml` on Windows, `~/.continue/config.yaml` on macOS/Linux). Continue format reference: [Continue config reference](https://docs.continue.dev/reference).

## Bridge YAML

Copy `config/bridge.example.yaml` to `config/bridge.yaml` (git-ignored) and fill in your paths. You must set:

- `llama_server.binary` to your `llama-server` executable, **or** set the environment variable `LLAMA_SERVER_BINARY`.
- Each model's `gguf_path` (absolute or relative to the YAML file).

On this machine, the current example bridge config points to:

```text
C:/Program Files (x86)/Llamacpp/llama.cpp-b8929/llama-server.exe
```

If you upgrade `llama.cpp`, update `config/bridge.yaml` to the new `llama-server.exe` path.

Optional per-model fields:

- `system_prompt`: bridge-injected system text prepended to the request (or appended to the existing leading system message). This is useful when a local model needs extra steering for tool calling, edit formatting, or repo-specific behavior.

## Extending sampling keys

Edit `continue_llamacpp_bridge/sampling.py` (`_TOP_LEVEL_SAMPLING_KEYS` and validation) if you need more fields forwarded to `/v1/chat/completions`.

## Troubleshooting

If Continue shows an error like:

```text
edit_existing_file failed with the message: `filepath` and `changes` arguments are required to edit an existing file.
```

that usually means the model emitted an invalid tool call, and Continue rejected it before applying the edit. In practice this is most common with local models that are only partially reliable at structured tool calling.

For Gemma 4 through `llama.cpp`, the safest defaults are:

- Keep `strip_tools: false` if you want Continue edit/apply tools to exist at all.
- If you want thinking enabled, add a strong `system_prompt` that explicitly tells the model to keep reasoning private and emit complete tool arguments.
- Prefer lower-temperature coding settings if tool arguments drift or come back half-formed.

If the problem persists, turn on bridge `--debug` and check whether the upstream model output contains malformed tool-call arguments; at that point the bridge is forwarding the request correctly, but the model is not honoring the tool schema.

## License

MIT — see `LICENSE`.
