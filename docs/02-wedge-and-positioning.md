# 02 — Wedge & Positioning

## One-line positioning

> **Forge is the local agent done right: direct llama.cpp control, tools tuned
> for local-model reliability, zero-friction GGUF loading, optional online
> search — no cloud LLM, ever.**

## The Four Pillars

### 1. First-class llama.cpp control
- Direct `llama-server` integration (Path A, the default).
- Every `llama-server` flag exposable in `config.yaml` — `n_gpu_layers`, `cache_type_k/v`, `flash_attn`, `n_batch`, `n_parallel`, `extra_llama_server_args`, etc.
- Hot-swap GGUFs based on the requested model id.
- Already proven in production via `forge-llamacpp-bridge`. Forge ports the bridge semantics to TypeScript so end users don't need Python.
- Ollama is **not** a backend. Ollama bundles llama.cpp but hides flags; Forge takes the opposite stance.

### 2. Tools tuned for local-model reliability
- **Strict JSON Schema for every tool.** Never a free-form `string` blob arg. (Direct lesson from the Continue Gemma 4 tool-call failures documented in `llamabridge/CONTINUE_PATCH_NOTE.md`.)
- **Dual tool-call path**: native function-calling when the model supports it; structured-output parser fallback for models that fake it via prompt-engineered JSON.
- **Per-model `system_prompt`** in `config.yaml` for steering tool-call discipline (e.g. "emit complete arguments only").
- **Per-model recommended sampling defaults** — lower temperature for coding, baked into autodetect heuristics.
- **`strip_tools` fallback** at the request layer for models that 500 on tool JSON.

### 3. Zero-friction GGUF loading
- Scan HuggingFace cache (`~/.cache/huggingface/hub`) plus user-configured `model_dirs`.
- Filename heuristics map models to sensible `llama_server_args` per family (Qwen3, Gemma 4, Llama, Mistral).
- Lands at **v0.3**, not late-stage polish — this is a headline feature, not a v1.0 nice-to-have.

### 4. Optional online search, no cloud LLM ever
- **Tavily** (default, free 1k queries/month) and **Brave** (alternative, free 2k/month).
- API keys live in VS Code `SecretStorage` — never in `config.yaml`.
- `web_search` returns titles + snippets + URLs; `web_fetch` retrieves a specific URL with Readability + Turndown for clean Markdown.
- **These are the only outbound network calls.** No telemetry, no auto-update, no analytics.
- Search is genuinely opt-in: no key configured → tool not registered.

## Why these four together (the compound moat)

Each pillar alone is replicable. Together they form a compounding wedge:

- **First-class llama.cpp** without the **tool reliability layer** = a fast backend that still fails on small-model tool calls.
- **Strict tool schemas** without **first-class llama.cpp** = nothing to demonstrate them on locally.
- **Zero-friction GGUF** without the **tool reliability layer** = autodetect a model that breaks on first agent turn.
- **Optional search** without the **other three** = a search feature in a generic chat extension.

Forge ships all four at once. That's harder to copy than any single pillar.

## Where Forge sits versus competitors

| Project   | Local-LLM tier  | Default backend  | Tool reliability for local models | GGUF autodetect | Online search | Hallucination signal |
| --------- | --------------- | ---------------- | --------------------------------- | --------------- | ------------- | -------------------- |
| Continue  | Second-class    | Ollama (proxied) | Weak (Gemma 4 tool-call bug documented in `CONTINUE_PATCH_NOTE.md`) | No              | Adding        | None                 |
| Cline     | Second-class    | Any OpenAI-compat| Generic                           | No              | Yes           | None                 |
| Roo Code  | Second-class    | Any OpenAI-compat| Generic                           | No              | Yes           | None                 |
| Cursor    | Not targeted    | Cloud-first      | N/A                               | No              | `@web`        | None                 |
| **Forge** | **First-class** | **llama.cpp direct** | **Strict schemas + dual path + per-model defaults** | **Yes (v0.3)**   | **Yes**       | **Optional via HalluMeter (deferred)** |

## Honest risks to the wedge

- **The local-LLM dev population is small.** 5–10% of VS Code users at most. Forge optimises for them; absolute install-count goals must reflect this.
- **The wedge is structurally fragile against Continue.** If Continue ships first-class llama.cpp support (technically possible — they could adopt the bridge), pillar 1 weakens overnight. Pillars 2–4 still hold.
- **Tool-reliability is a maintenance treadmill.** Each new model family brings new tool-call quirks; per-model defaults will be updated for the project's lifetime.
- **Vision is not a real wedge.** Local multimodal is rare and slow; users with vision needs use frontier models. Vision tools land in v1.0 as a checkbox feature, not a draw.
- **Search is becoming table stakes** within 6 months. The differentiator is Forge's *integration* (single config, untrusted-content delimiters, SSRF guard), not the feature itself.

(Full risks in **[08-risks.md](08-risks.md)**.)

## What changes if a pillar is later rejected

- Drop pillar 1 (use any OpenAI-compat backend) → Forge becomes "Cline but with stricter tool schemas." Weaker.
- Drop pillar 2 (use generic tool definitions) → Forge becomes "Continue with a different launcher." Weaker.
- Drop pillar 3 (no autodetect) → Forge becomes "Continue but TypeScript." Significantly weaker.
- Drop pillar 4 (no search) → Forge stays usable but a known feature gap.

The compound is what makes the project worth building.

## Hallucination awareness — the deferred fifth pillar

`HalluMeter` (sibling project, Apache 2.0) provides a context-fill hallucination
risk meter. Forge could integrate it inline (shared curves package) or just
recommend it as a parallel desktop overlay. **Decision deferred until post-v0.5
dogfooding.** See **[11-hallumeter.md](11-hallumeter.md)**.

## Target user persona

A developer who:
- Has a 16GB+ VRAM GPU
- Already runs Qwen3 or Gemma 4 GGUFs locally (or wants to)
- Cares about not sending their code to a cloud provider
- Has hit Continue's local-model rough edges (tool failures, slow Ollama, opaque flags)
- Wants a sidebar UX, not a CLI

That's a small population. Forge is built for them, not for the median VS Code user.
