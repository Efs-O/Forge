# Multi-window port handling — audit & patch brief

**Author:** AgentWatch-side investigation (2026-06-01), cross-checking Forge after
a multi-window port-collision bug was found and fixed in AgentWatch.
**Status:** advisory. Forge is mostly sound here — this is one latent correctness
gap, not the severe bug AgentWatch had. Read the whole brief before changing code.

---

## TL;DR

- **Forge does NOT have AgentWatch's bug.** AgentWatch flickered agents green/grey
  across windows because every window hardcoded the same ports *and* had a reaper
  that `taskkill`'d whoever held the port → a cross-window mutual-kill war.
  **Forge has no such reaper**, and its control-server-singleton design is the
  correct pattern. Do **not** add a reaper, and do **not** add free-port search to
  the model ports (see why below).
- **One real latent gap:** model-server **adoption is port-keyed, not
  model-keyed**. A window can adopt a healthy `llama-server` that is serving a
  *different* model than requested and silently return the wrong model.
- **The fix is model-aware adoption**, not picking a different port.

---

## What was verified (file:line)

- `src/backend/BackendPool.ts:37-41` — each window's pool reserves a **fixed** port
  set `[base .. base+max-1]` (`base = llama_server.port ?? 8080`,
  `max = max_simultaneous_models ?? 1`). Ports are taken from this set
  (`allocatePort()` at `:134`), never probed for real availability.
- `src/backend/DirectBackend.ts:120-131` — before spawning, it does
  `probeHealthy(http://host:port)`. **If anything healthy is on the port it
  adopts it** ("started by another VS Code window") and starts a monitor. There is
  **no check that the adopted server is serving the requested model.**
- `src/backend/ControlServer.ts:50-66` — control server binds `8799`; on
  `EADDRINUSE` it logs "another Forge window likely owns it" and **does not start a
  second**. `/ensure` is serialized (`:214 serialize()`) and ref-counted
  (`holds`), with capacity/eviction in `makeRoom()` (`:181`). This is the correct
  single-coordinator design.
- `src/extension.ts:144-156` — **every window** constructs its own `BackendPool`
  and its own `ControlServer`, but only the window that wins `8799` actually serves
  the control API. `bridge_mode` uses `SingleBackendPool`/`BridgeBackend` (a
  pre-running server, no port allocation) — the gap below does **not** apply there.

## The latent bug (precise scenario)

Because only one window can own `8799`, the other windows still have a live
`BackendPool` driven by their **own** sidebar / command-palette actions (not by the
shared control server). All windows compute the **same** port set (8080…).

1. Window A loads model **X** → pool A spawns `llama-server` for **X** on `8080`.
2. Window B (lost the `8799` race) loads model **Y** from its sidebar → pool B
   `allocatePort()` → `8080` → `DirectBackend.startLlamaServer` probes `8080`,
   finds it healthy (A's server, serving **X**), and **adopts it as "Y."**
3. Window B now believes **Y** is loaded; requests routed there are answered by
   **X**. Silent wrong-model — the exact failure the control API was built to
   prevent, reintroduced on the direct/sidebar path.

(If the occupant were unhealthy, B would instead spawn a 2nd server on `8080` and
`EADDRINUSE` / health-timeout out — a noisier but less dangerous failure.)

## Why "search for a free port" is the WRONG fix here

Forge's adoption is **intentional**: on a 16 GB box you *want* a second window to
share the one warm `llama-server` rather than spawn a duplicate and double VRAM.
Free-port search would make each window spawn its own copy on a different port —
defeating the whole point. Keep adoption; make it **correct**.

## Recommended fix (for the Forge agent)

Make adoption **model-aware** in `DirectBackend.startLlamaServer`
(`src/backend/DirectBackend.ts:120`):

1. After `probeHealthy(...)` succeeds, **identify the model the existing server is
   serving** and only adopt if it matches `model`. llama.cpp exposes this — verify
   which endpoint your `llama_server` build supports before coding:
   - `GET /props` → `default_generation_settings.model` / `model_path`, or
   - `GET /v1/models` → `data[0].id`.
   Compare against the requested model's `model_path`/alias from `ModelConfig`
   (normalize paths/basenames; aliases may differ from file names).
2. **If it matches** → adopt as today.
3. **If it does NOT match** → do not silently adopt. Preferred: surface a clear
   error / return a 409-style "port slot in use by another window serving <X>" so
   the control server's `makeRoom()`/capacity logic (or the user) handles it,
   rather than serving the wrong model. A free-port fallback is acceptable **only**
   as a last resort and only when you accept the extra VRAM.

Secondary hardening (optional, lower priority):
- The single source of truth for multi-window coordination is the control server
  (`8799`). Consider documenting/encouraging that the **non-owner windows route
  model loads through the owner's `8799`** instead of driving their own pool, which
  removes the divergence at the root. (Bigger change — design decision for you.)

## Explicit non-goals (do not do these)

- ❌ Do not add a netstat/lsof + `taskkill`/SIGKILL "stale port reaper." That is the
  exact mechanism that caused AgentWatch's cross-window kill-war.
- ❌ Do not change the control server's graceful `EADDRINUSE` decline — it is
  correct. One control server per machine is the intended design.
- ❌ Do not add free-port scanning to the model `llama-server` ports (breaks
  VRAM-sharing adoption, per above).

## Verify before finishing

- Reproduce: two Forge windows, `max_simultaneous_models: 1`, load model X in one
  and model Y in the other; confirm the second no longer answers as X.
- Confirm the chosen llama.cpp introspection endpoint actually returns the loaded
  model on your `llama_server.binary` build.
- `npm run` typecheck/lint/build clean (match repo conventions).

---

*Cross-reference: AgentWatch fixed its own (different, more severe) version of this
in commit "Fix cross-window port collisions: dynamic port search, drop reaper" —
dynamic port search there was correct because AgentWatch's MCP/codex ports are
per-window and not meant to be shared, unlike Forge's deliberately-shared model
servers.*
