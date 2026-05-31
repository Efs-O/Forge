# Multi-Worker Fleet — parallel workers + local model-control API

How Forge serves a small fleet of concurrent local workers (e.g. subagents
dispatched by an external orchestrator), what shipped now, and the Forge-side
implementation plan for a local control API that lets any consumer load the right
model on demand. Consumer-side code lives in the consumer's own repo, not here.

---

## Background: two different kinds of "concurrency"

Do not conflate these — they use different knobs:

1. **Same model, N concurrent workers** → *server parallel slots*. One model
   load in VRAM, N sequences served at once. Cheap: costs ~N × KV cache, **not**
   N × model weights. This is what a 3-4 worker fleet on one model needs.
2. **N different models at once** → N separate loads = N × weights VRAM. Governed
   by Forge `max_simultaneous_models` (separate port per model, LRU eviction).
   Hardware-bound; left at default 1.

Our target is case 1.

---

## Shipped now (#1 + #2)

### #2 — `n_parallel` default 1 → 4
[`src/backend/LlamaServerArgs.ts`] now defaults `--parallel` to **4** when
`llama_server.n_parallel` is unset. One shared `llama-server` load serves up to
4 concurrent workers out of the box.

### #1 — config + Ollama guidance
`config/config.example.yaml`:
- `n_parallel: 4` with the VRAM note (≈ n_parallel × KV cache).
- `default_num_ctx: 32768` — **critical footgun documented**: llama.cpp's
  `--ctx-size` is the **TOTAL** context **split across** parallel slots, so
  per-worker ctx = `default_num_ctx / n_parallel` (32768 / 4 = 8192 each). Raise
  ctx when you raise n_parallel or workers get starved to a tiny window.
- Ollama note: concurrent same-model workers need **`OLLAMA_NUM_PARALLEL=4`** on
  the daemon (and `OLLAMA_MAX_LOADED_MODELS` for several models) — daemon env
  vars, not Forge config.

### Running the 3-4 same-model worker test

**llama.cpp (direct, via Forge):**
1. Forge `config.yaml`: `llama_server.n_parallel: 4`, `default_num_ctx: 32768`
   (or per-model `num_ctx`), and the target model as `active_model`.
2. Forge launches `llama-server --parallel 4` on `:8080`.
3. AgentWatch `direct:` workers (default `directUrl` = `:8080`) fire 4 concurrent
   dispatches; they fan across the 4 slots. No extra servers.

**Ollama:**
1. `setx OLLAMA_NUM_PARALLEL 4` (restart daemon).
2. AgentWatch `ollama:<model>` workers dispatch concurrently to `:11434`.

> Caveat from the RPS log: the `direct` backend **serves whatever model is loaded
> and ignores the requested model id**. With one shared model that is fine (you
> know what is loaded). For *different* models per worker, you need #3 below.

---

## #3 — Forge local model-control API (IMPLEMENTATION TODO)

> **Scope: Forge only.** This is a generic, consumer-agnostic localhost API that
> lets *any* external orchestrator ask Forge to load the right model on demand
> and tell it where to send inference. Forge knows nothing about who the consumer
> is. The consumer implementation (e.g. a worker dispatcher) lives in **its own
> repo** and is out of scope here — it only needs the contract below, never a
> path into Forge's source.

### Why
An external dispatcher that POSTs to a fixed endpoint can't load or swap a model,
so it hits two failure modes: the server may be down/mid-swap, and a single
shared `llama-server` serves whatever is loaded and ignores the requested model
id. Forge's `BackendPool.acquire(model)` already solves this: load/hot-swap the
requested model, allocate a port per model, return its OpenAI-compatible
`baseUrl()`, and evict LRU past `max_simultaneous_models`. A small control API
exposes that so a consumer routes to the *right* model instead of guessing.

### Design — a localhost HTTP control surface
HTTP (not a VS Code command) because the typical consumer runs as a **separate
process** and can't call in-window `vscode.commands`. Localhost-only.

```
Forge (extension)                          Any consumer (separate process)
  BackendPool ──┐                            wants model M
  ControlServer │  POST /ensure {model:M} ◄──── (consumer's own logic)
   :8799 (cfg)  └─ acquire(M) → {baseUrl, model, backend}
                   ─────────────────────────►  POST {baseUrl}/chat/completions
```

### Forge-side tasks (all in this repo)
- [ ] `src/backend/ControlServer.ts` — localhost-only HTTP server (config port,
      e.g. 8799). Endpoints per the contract below.
- [ ] `src/config/schema.ts` — add optional `control_server: { enabled, port }`.
- [ ] `src/extension.ts` — start ControlServer when enabled (reuse the existing
      `pool`), `context.subscriptions.push(...)` for disposal.
- [ ] Bind 127.0.0.1 only; no outbound traffic. This is an *inbound* localhost
      control surface, consistent with the no-new-outbound-endpoint rule.
- [ ] Keep ControlServer.ts ≤ 350 LOC.

### The contract (the only thing a consumer needs — no Forge paths)
```
GET  /healthz            → { ok: true }
GET  /models             → { models: [{ name, backend, loaded, baseUrl? }] }
POST /ensure  {model}    → { baseUrl, model, backend }   # loads/swaps as needed
POST /release {model}    → { released: bool }            # optional
```
A consumer (in its own repo) just needs the base URL (e.g. `http://127.0.0.1:8799`)
and these shapes: call `/ensure`, then POST to the returned `baseUrl`. Keep it
opt-in there so the consumer still works when Forge isn't running.

### Forge-side edge cases (do NOT skip — these are where it breaks)
- [ ] **Eviction vs. in-use**: `max_simultaneous_models` LRU eviction must not
      stop a model that an `/ensure`-ed caller is mid-request on. Ref-count
      ensured models; don't evict one with outstanding holders.
- [ ] **Port coordination**: return the assigned `baseUrl` from `/ensure`; the
      pool uses 8080, 8081, … — never assume a fixed port.
- [ ] **Multi-window**: two VS Code windows each running a pool would collide on
      the control port. Single-instance it, or per-workspace port + discovery
      file. Mirror Forge's existing "adopt server already on this port" pattern.
- [ ] **Lifecycle ownership**: Forge owns load/unload; callers only request.
      Define idle/TTL unload so an `/ensure`-ed model doesn't linger forever.

### Acceptance test (the real benchmark)
A consumer dispatches a multi-file change to 3-4 workers on **different** models
via `/ensure`; verify: right model served per worker (no id-ignored mismatch),
no eviction mid-task, tests green, and measured token cost vs. all-SOTA. This is
the experiment that proves the heterogeneous-fleet thesis — run it before adding
more surface area.
