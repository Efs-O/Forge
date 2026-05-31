# Multi-Worker Fleet — parallel workers + Forge↔AgentWatch bridge

How Forge serves a small fleet of concurrent local workers (e.g. AgentWatch
subagents dispatched by Claude Code / Codex), what shipped now, and the
implementation plan for routing AgentWatch dispatch through Forge's backend pool.

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

## #3 — Forge↔AgentWatch lifecycle bridge (IMPLEMENTATION TODO)

### Why
Today AgentWatch is decoupled (`subagent.ts` "Decision #4"): it POSTs to fixed
endpoints (`bridge:9099`, `ollama:11434`, `direct:8080`) and **never loads or
swaps a model**. Consequences seen in the RPS log:
- "fetch failed" when the server was down / mid-swap.
- "wrong model loaded" — `direct` ignores the model id.

Forge's `BackendPool.acquire(model)` already does exactly the missing piece:
load/hot-swap the requested model, allocate a port per model, return its
OpenAI-compatible `baseUrl()`, and evict LRU past `max_simultaneous_models`. The
bridge makes AgentWatch *use* that instead of guessing.

### Design — Forge exposes a localhost model-control endpoint
Chosen over a VS Code command because AgentWatch's MCP server runs as a **separate
process** (`mcpStdio.js`, spawned by Codex/Claude CLI), so it cannot call
in-window `vscode.commands`. A localhost HTTP control surface reaches it.

```
Forge (extension)                         AgentWatch (MCP server / worker)
  BackendPool ──┐                            dispatch_subagent(model=M)
  ControlServer │  POST /ensure {model:M} ◄──── resolveModel: if forgeControlUrl set
   :8799 (cfg)  └─ acquire(M) → {baseUrl, model, backend, port}
                   ─────────────────────────►  POST {baseUrl}/chat/completions
```

### Tasks

**Forge side**
- [ ] `src/backend/ControlServer.ts` — localhost-only HTTP server (config port,
      e.g. 8799). Endpoints:
      - `GET /healthz` → `{ ok: true }`
      - `GET /models` → configured models + loaded state + ports (single source
        of truth; AgentWatch `list_models` can consume this)
      - `POST /ensure {model}` → `pool.acquire(model)` → `{ baseUrl, model, backend }`
      - `POST /release {model}` → `pool.release(model)` (optional)
- [ ] `src/config/schema.ts` — add optional `control_server: { enabled, port }`.
- [ ] `src/extension.ts` — start ControlServer when enabled (reuse the existing
      `pool`), `context.subscriptions.push(...)` for disposal.
- [ ] Bind 127.0.0.1 only; no outbound. Respect the "no new outbound endpoint"
      rule (this is an inbound localhost control surface, not outbound traffic).
- [ ] Keep ControlServer.ts ≤ 350 LOC.

**AgentWatch side**
- [ ] `SubagentBackends.forgeControlUrl?: string` (e.g. `http://127.0.0.1:8799`).
- [ ] `resolveModel` / dispatch: when `forgeControlUrl` is set, **pre-dispatch**
      `POST /ensure {model}` → use the returned `baseUrl` instead of the fixed
      `directUrl`. Fall back to the existing direct/ollama/bridge routing when
      unset (keep decoupling optional).
- [ ] `validateBackend` / `list_models`: prefer Forge `/models` when available.

### Edge cases to handle (do NOT skip — these are where it breaks)
- [ ] **Eviction vs. in-use**: `max_simultaneous_models` LRU eviction must not
      stop a model a worker is mid-dispatch on. Ref-count or tie eviction to
      AgentWatch claims (a claimed/active worker pins its model).
- [ ] **Port coordination**: AgentWatch must use the `baseUrl` returned by
      `/ensure`, never a hardcoded `:8080` — the pool assigns 8080, 8081, …
- [ ] **Multi-window**: two VS Code windows each running a pool would collide on
      the control port. Single-instance the control server, or per-workspace
      port + discovery file. Mirror Forge's existing "adopt server already on
      this port" pattern.
- [ ] **Who stops models**: Forge owns lifecycle; AgentWatch only requests.
      Define idle/TTL unload so an `/ensure`d model does not linger forever.
- [ ] **Preflight already exists**: AgentWatch's `validateBackend` + `list_models`
      stay as the reachability guard; the bridge upgrades them from "is something
      up" to "is the *right* model up."

### Acceptance test (the real benchmark)
Coordinator dispatches a multi-file change to 3-4 workers on **different** models
via the bridge; verify: right model served per worker (no id-ignored mismatch),
no eviction mid-task, tests green, and measured token cost vs. all-SOTA. This is
the experiment that proves the heterogeneous-fleet thesis — run it before adding
more surface area.
