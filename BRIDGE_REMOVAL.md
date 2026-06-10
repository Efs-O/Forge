# Bridge Removal Plan

## Background

`forge-llamacpp-bridge` is a Python FastAPI middleman originally built for
Continue.dev (`continue-llamacpp-bridge`, April 2026). When Forge was created
the bridge was carried over. In May 2026 Forge grew its own `BackendPool` with
multi-model management, hot-swap, and port allocation — making the bridge
redundant. It has not received functional changes since. This plan removes it.

## What the bridge was

- A separate Python process that spawned and managed llama-server processes
- Exposed a single OpenAI-compatible endpoint at `127.0.0.1:9099/v1`
- Forge connected to it as a dumb client instead of spawning llama-server itself
- `bridge.yaml` held all model definitions; `.forge/config.yaml` delegated to it via `bridge_config:`

## What replaces it

Nothing new — Forge's existing `BackendPool` + `DirectBackend` already does
everything the bridge did. Models move from `bridge.yaml` into `config.yaml`
in flat format.

---

## TODO

- [x] Create this plan file
- [ ] Migrate bridge.yaml models → .forge/config.yaml (flat, all references resolved)
- [ ] Delete bridge files: `BridgeBackend.ts`, `BridgeConfigLoader.ts`, `SingleBackendPool.ts`, `bridge.yaml`
- [ ] `src/config/schema.ts` — remove `bridge_config`, `bridge_mode` fields + superRefine blocks
- [ ] `src/config/types.ts` — remove `bridge_config?`, `bridge_mode?` from ForgeConfig
- [ ] `src/config/ConfigLoader.ts` — remove bridge loading + merging logic
- [ ] `src/extension.ts` — remove bridge imports + conditional pool instantiation
- [ ] `src/backend/DirectBackend.ts` — update stale error message
- [ ] `src/sidebar/FirstRunWizard.ts` — remove bridge wizard path
- [ ] Minor: `webview-ui/src/modelGroups.ts`, `webview-ui/src/slashCommands.ts`, `config/config.example.yaml`
- [ ] `test/unit/ConfigLoader.test.ts` — remove bridge test cases
- [ ] Run `npx tsc --noEmit` + `npx vitest run`, fix any failures
- [ ] Commit

---

## Migration: bridge.yaml → config.yaml

### Resolution rules applied

| bridge.yaml field | Resolves to |
|---|---|
| `runtime: main_agent` | `n_parallel: 1, num_ctx: 131072` |
| `runtime: main_agent_256k` | `n_parallel: 1, num_ctx: 262144` |
| `runtime: worker_pool` | `n_parallel: 4, num_ctx: 131072` |
| `runtime: worker_pool_large` | `n_parallel: 8, num_ctx: 262144` |
| `runtime: vision_only` | `n_parallel: 1, num_ctx: 32768` |
| `runtime_defaults.llama_cpp` | `n_gpu_layers: -1, n_batch: 512, type_k: 8, type_v: 8, flash_attn: true` (inherited by all llama.cpp models) |
| `sampling: gemma_coding` | `temperature: 0.6, top_p: 0.95, top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<|im_end|>", max_tokens: 98304` |
| `sampling: qwen_coding` | `temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, max_tokens: 98304, preserve_thinking: true` |
| `sampling: ollama_local` | `temperature: 0.6, top_p: 0.95, max_tokens: 131072` |
| `sampling: ollama_cloud_64k` | `temperature: 0.6, top_p: 0.95, max_tokens: 65536` |
| `sampling: ollama_cloud_32k` | `temperature: 0.6, top_p: 0.95, max_tokens: 32768` |
| `sampling: xai_default` | `temperature: 0.7, max_tokens: 30000` |
| `sampling: openrouter_default` | `temperature: 0.6, top_p: 0.95, max_tokens: 16384` |
| `prompt: forge_coding_agent` | system_prompt string (inline) |

### llama_server section

Populated from `providers.llama_cpp` + `runtime_defaults.llama_cpp`:

```yaml
llama_server:
  binary: "N:/downloads/llama.cpp-b9402/llama-server.exe"
  host: "127.0.0.1"
  port: 8080
```

Per-model values override the section defaults — no global `n_gpu_layers` etc.
needed in llama_server since every model specifies them explicitly.
