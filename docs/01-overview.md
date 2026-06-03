# 01 — Overview

## What Forge Is

Forge is a local-first VS Code extension providing a sidebar AI coding companion
backed by GGUF models via direct llama.cpp integration. Three modes (Ask, Plan,
Execute), strict-schema tool catalog, optional online search, hallucination-aware
posture. No cloud LLM endpoints, ever.

## Who It's For

- Privacy- and air-gap-conscious developers who can't or won't send code to cloud LLMs
- Local-LLM enthusiasts who want first-class llama.cpp control instead of Ollama-mediated abstraction
- Users running models on consumer GPUs (Qwen3, Gemma 4 families, 3-bit quants, ~100k context)
- Power users of `forge-llamacpp-bridge` who want a sidebar UX instead of (or alongside) Continue

## What It Is Not

- A frontier-model client — Forge does not connect to OpenAI, Anthropic, Google, etc.
- A general-purpose chat app — it's scoped to coding workflows in VS Code
- A Continue fork — semantics inherited from `llamabridge`, code reimplemented in TypeScript
- A model server — Forge runs `llama-server`, doesn't replace it

## High-Level Architecture

```
VS Code Extension (TypeScript)
    │
    ├── Sidebar (WebviewViewProvider)         user-facing chat + mode + actions
    ├── BackendController                     mode-agnostic interface
    │       ├── DirectBackend  (default)      spawns llama-server itself
    │       └── BridgeBackend  (opt-in)       talks to forge-llamacpp-bridge
    ├── OpenAIClient                          streaming /v1/chat/completions
    ├── ToolRegistry                          dispatch + capability/permission gating
    ├── CheckpointStack                       per-turn snapshots + Keep/Undo decorations
    └── ConfigLoader                          config.yaml (Zod-validated) + settings.json
              │
              ▼
        llama-server  →  GGUF models on disk
```

## The Four Pillars (the wedge)

1. **First-class llama.cpp control** — every `llama-server` flag exposable in `config.yaml`. Bridge logic ported to TS so no Python runtime is required.
2. **Tools tuned for local-model reliability** — strict JSON schemas, dual tool-call path (native + structured-output fallback), per-model system prompts.
3. **Zero-friction GGUF loading** — autodetect from HuggingFace cache + user-configured directories; sane per-model launch defaults.
4. **Optional search, fully opt-in** — Tavily (default) and Brave, user-supplied API key in `SecretStorage`. Search and fetch are the only outbound network calls. No telemetry.

(See **[02-wedge-and-positioning.md](02-wedge-and-positioning.md)** for full positioning.)

## Three Modes

| Mode      | Purpose                                  | Tool access                       |
| --------- | ---------------------------------------- | --------------------------------- |
| **Ask**   | Direct Q&A, explanations                 | None (read-only context only)     |
| **Plan**  | Structured step breakdown, no execution  | None (read-only context only)     |
| **Execute** | Full agent loop with tool dispatch     | All registered, capability+permission gated |

## Scope per version (high level)

| Version | Headline                              | Defining capability                                    |
| ------- | ------------------------------------- | ------------------------------------------------------ |
| v0.1    | Chat MVP                              | Streaming chat against running llama-server, cancel    |
| v0.2    | Editor context                        | Selection / insert / replace                           |
| v0.3    | Multi-model + GGUF autodetect         | HF cache scan, model picker, per-model params          |
| v0.4    | Plan mode                             | Structured plan output                                 |
| v0.5    | Read-only tools + search/fetch        | LSP suite, web_search, web_fetch                       |
| v0.6    | Write tools + checkpoints + Keep/Undo | Per-turn snapshot, inline accept/reject               |
| v0.7    | Execute mode + git + terminal         | Full agent loop with allowlist                         |
| v0.8    | YAML + Nunjucks templates             | Hot-reloadable user templates                          |
| v0.9    | Polish                                | Persistence, token budget UI, error surfacing          |
| v1.0    | Multi-model UX + vision + read_pdf    | Multimodal tools (capability-gated)                    |

(Full roadmap in **[07-roadmap.md](07-roadmap.md)**.)

## Constraints

- **350 LOC max** per source file (excluding `.md`, `.json`, `.yaml`, configs)
- **No cloud LLM endpoints**, no telemetry, no auto-update pings
- **Strict tool schemas only** — no free-form `string` blob args (lesson from `llamabridge/CONTINUE_PATCH_NOTE.md`)
- **API keys in `SecretStorage`**, never in `config.yaml`
- **All write tools require checkpoints** before they ship

## What Lives Where

| Concern                  | Location                                      |
| ------------------------ | --------------------------------------------- |
| Agent rules              | `CLAUDE.md`, `AGENTS.md`                      |
| Locked decisions         | `docs/INDEX.md`                               |
| Architecture             | `docs/03-architecture.md`                     |
| Config schema            | `docs/04-config-schema.md`                    |
| Tool catalog             | `docs/05-tools.md`                            |
| Bridge reference         | `llamabridge/` (in-tree, removed before deploy) |
| External docs index      | `docs/09-references.md`                       |
