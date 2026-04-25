# 04 — Config Schema

Forge has **two configuration sources**, by concern:

| Source                 | Lives at                                                | Owns                                                |
| ---------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `config.yaml`          | `<workspace>/.forge/config.yaml` (preferred) or `~/.forge/config.yaml` | Models, llama-server flags, sampling, templates    |
| VS Code `settings.json`| `forge.*` keys                                          | UI prefs, endpoint URL (Bridge mode), feature toggles |
| VS Code `SecretStorage`| (managed by VS Code)                                    | API keys (Tavily, Brave) — **never in `config.yaml`** |

Workspace `config.yaml` overrides global; both validated with Zod at load.

---

## `config.yaml` — full schema

```yaml
# ---------------------------------------------------------------
# Forge — config.yaml
# ---------------------------------------------------------------

# Backend mode + binary
backend:
  mode: direct                        # 'direct' (default) | 'bridge'
  llama_server_binary: auto           # 'auto' (PATH lookup) | absolute path
  bridge_url: http://127.0.0.1:9099   # only used when mode: bridge
  bridge_command: continue-llamacpp-bridge  # only used when mode: bridge AND we should spawn it
  bridge_config: ./config/bridge.yaml       # bridge YAML path (only mode: bridge)
  host: 127.0.0.1
  port: auto                          # 'auto' = pick free port; otherwise integer

# llama-server defaults (Direct mode only)
llama_server:
  n_gpu_layers: -1                    # -1 = offload all
  n_batch: 512
  n_parallel: 1
  type_k: 8                           # KV cache quant: 8 = Q8_0
  type_v: 8
  default_num_ctx: 4096               # overridden per-model
  flash_attn_default: true
  n_threads: 0                        # 0 = auto (= 6 in bridge default)
  n_threads_batch: 0

# Permissions — broad categories. Tools register required permissions; runtime gate.
permissions:
  fs: { read: true, write: true, delete: false }   # delete defaults off; explicit opt-in
  net: { search: false, fetch: false, http: false } # search/fetch off until API key set
  exec: { terminal: false, headless: false }       # exec off; per-call confirm when on
  git: { read: true, write: false }

# Confirmation policy
confirmations:
  default: per-call                   # 'per-call' | 'session-allow'
  remember_per_tool: true             # session-allowlist toggles

# Search providers (keys in SecretStorage)
search:
  provider: tavily                    # 'tavily' | 'brave'
  max_results: 5
  fetch_max_chars: 30000
  fetch_timeout_ms: 10000

# Model autodetect (v0.3+)
model_dirs:
  - "~/.cache/huggingface/hub"
  # - "D:/local-models"

# Default model alias
default_model: qwen3-coder-7b

# Per-model definitions
models:

  qwen3-coder-7b:
    gguf_path: "~/.cache/huggingface/hub/models--Qwen--Qwen3-Coder-7B-GGUF/snapshots/.../Qwen3-Coder-7B-Q3_K_M.gguf"
    num_ctx: 100000
    n_batch: 512
    flash_attn: true
    think: false
    capabilities: [tool-call, long-context]
    system_prompt: |
      You are a coding assistant. When calling tools, emit complete JSON arguments
      only — never describe edits in prose. For replace_in_file, the old_str must
      match the file exactly including whitespace.
    sampling:
      temperature: 0.3
      top_p: 0.95
      top_k: 40
      min_p: 0.0
      max_tokens: 4096
    extra_llama_server_args:
      - "--rope-scaling"
      - "linear"
    strip_tools: false                # Per-model override of global

  gemma4-12b:
    gguf_path: "~/.cache/huggingface/hub/models--google--gemma-4-12b-it-GGUF/.../gemma-4-12b-it-Q3_K_M.gguf"
    num_ctx: 100000
    n_batch: 1024
    flash_attn: true
    think: false
    capabilities: [tool-call]
    system_prompt: |
      Reasoning is private; tool calls must contain only the required arguments
      and nothing else. Never include explanations inside tool argument values.
    sampling:
      temperature: 0.4
      top_p: 0.9
      max_tokens: 8192

  qwen3-vl-7b:
    gguf_path: "~/local-models/Qwen3-VL-7B-Q4_K_M.gguf"
    num_ctx: 32768
    capabilities: [tool-call, vision]
    sampling:
      temperature: 0.5
```

---

## Sampling — precedence rules (TS port of `llamabridge` semantics)

Allowed top-level keys (applied to chat completion payload):

```
temperature, top_p, top_k, min_p,
frequency_penalty, presence_penalty,
repetition_penalty, repeat_penalty,
max_tokens, seed
```

Special-cased into `chat_template_kwargs`:

```
preserve_thinking (bool)
```

Merge rule: **`config.yaml` `models.<id>.sampling` wins for any listed key.
Other keys in the request body pass through unchanged.**

Unknown keys raise a Zod validation error — silent drops are not allowed.

---

## VS Code `settings.json` keys

```jsonc
{
  // Endpoint override (rare; usually unset and Forge spawns its own)
  "forge.endpoint": "http://127.0.0.1:8080",

  // Default mode on activation
  "forge.defaultMode": "ask",  // "ask" | "plan" | "execute"

  // UI
  "forge.sidebar.retainContextWhenHidden": true,
  "forge.sidebar.fontSize": 13,

  // Conversation persistence
  "forge.persistence": "workspace",  // "workspace" | "global" | "none"

  // Logging
  "forge.logLevel": "info",  // "trace" | "debug" | "info" | "warn" | "error"

  // First-run wizard
  "forge.firstRun.shown": false  // managed by extension
}
```

---

## `SecretStorage` — what lives there

| Key                     | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `forge.tavily.apiKey`   | Tavily API key (user-supplied)                 |
| `forge.brave.apiKey`    | Brave Search API key (user-supplied)           |
| `forge.bridge.apiKey`   | Bridge mode bearer token                       |

Set via the **Forge: Set API Key** command palette entry, never via direct file
edit.

---

## Capability + Permission system

```ts
type Capability = 'tool-call' | 'vision' | 'long-context';

type Permission =
  | 'fs:read' | 'fs:write' | 'fs:delete'
  | 'net:search' | 'net:fetch' | 'net:http'
  | 'exec:terminal' | 'exec:headless'
  | 'git:read' | 'git:write';

interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiredCapabilities: Capability[];
  requiredPermissions: Permission[];
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

### Runtime gates

1. **Capability gate** (session start): drop tools the active model can't use.
   - Vision tools require `capabilities: [vision]` on the model.
   - Tool-call tools require `capabilities: [tool-call]`.
2. **Permission gate** (per-call): block tools whose `requiredPermissions` are not granted in `permissions:` block.
3. **Confirmation gate** (per-call): if `confirmations.default == per-call`, prompt the user; on session-allow, remember per-tool toggle.

---

## Validation behavior

- All YAML loads pass through Zod. Failure surfaces a clear error in the
  sidebar with the offending key path.
- Hot-reload on file save: re-parse, validate, swap atomically. If invalid,
  keep previous config and surface error.
- Missing required fields (e.g. `models[].gguf_path`) → activation fails with
  setup wizard if first run, error otherwise.
- Unknown top-level keys → warning log, ignored. (Tolerant to forward-compat
  additions; see addendum to PLAN-ADDENDUM if needed.)

---

## Default config behavior

If no `config.yaml` exists on first activation:
1. Show first-run wizard in the sidebar.
2. Offer to scan for GGUFs in HF cache (v0.3+).
3. Generate a starter `config.yaml` at `<workspace>/.forge/config.yaml` with one auto-detected model.
4. Persist the user's choice to `forge.firstRun.shown`.

If `config.yaml` exists but is empty / minimal:
- Use `llama_server` defaults table from `defaults.ts`.
- Surface "no models configured" message; require user to add at least one.

---

## Migration / breaking-change discipline

- `config.yaml` schema additions are **non-breaking** by default (new optional fields).
- Renames or removals: **bump schema version** + provide migration path.
- Per the Ask vs Proceed table in `CLAUDE.md`: any breaking schema change requires explicit user confirmation.
