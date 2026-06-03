# TODO — Control-server concurrency hardening (server side)

**Repo:** Forge
**Owner:** whichever agent picks this up *inside this repo* (do NOT implement from another
workspace — it pollutes this repo's staging area, and `bridge.yaml` is a documented hard
stop).
**Status:** open
**Created:** 2026-06-02
**Companion:** see `TODO-forge-concurrency-hardening.md` in the **AgentWatch** repo. These
two are complementary. AgentWatch stops *generating* hold churn; this one makes the
control server **immune** to churn from *any* consumer (AgentWatch, codex, scripts, a
second orchestrator).

---

## 1. Background / what we observed

A multi-worker fan-out (AgentWatch, 12 workers, target 4 concurrent on
`gemma4-26b-a4b-it-iq3s` via the Forge control route) saw the consumers repeatedly fail
on the **opening concurrent burst** with:

```
could not reach llama.cpp backend at http://127.0.0.1:8080/v1/chat/completions (ECONNRESET)
```

The llama-server's own output log proves the **model process was healthy** — single
launch, all 4 slots served, `truncated = 0` throughout, no OOM, no crash, no client
disconnects logged. So the resets originated **above** llama-server, at the control /
proxy layer, during model warm-up and hold churn.

Relevant config (`bridge.yaml`): `n_parallel: 4`, `max_simultaneous_models: 4`,
`ctx-size 131072` (→ ~32k/slot). VRAM is a single 16 GB card, so in practice only one
26B-class model fits at a time regardless of the `max_simultaneous_models` ceiling.

---

## 2. Root cause (this repo's contribution)

In `src/backend/ControlServer.ts`:

### Gap 1 — `/release` is not serialized, `/ensure` is
- `/ensure` runs through `this.serialize(() => this.ensure(model))` — `:116`.
- `/release` calls `this.release(model)` **directly, off the chain** — `:122`.

Both mutate the shared `this.holds` map. Because `ensure()` `await`s `pool.acquire()`
(`:161`), an un-serialized `/release` (and the `makeRoom` read below) can interleave
across that await window, so `holds` can be read at a stale value.

### Gap 2 — `makeRoom` evicts on a racy `holds === 0` snapshot
`makeRoom()` (`:181-200`) decides eviction from `idle = loaded.filter(m => holds === 0)`
(`:188`) and then `pool.release(idle[0])` (`:198`). If a model's `holds` momentarily reads
0 — between one worker's `/release` and the next worker's `/ensure` increment — a
concurrent `/ensure` for a *different* model at capacity can evict a load that is about to
be (or is being) used. `release()` itself only decrements and never unloads
(`:203-210`, correct), so the teardown comes from this eviction path, not from release.

### Gap 3 — `/ensure` may return before the backend actually serves
`ensure()` returns as soon as `pool.acquire(model)` resolves (`:161-170`). If `acquire`
resolves when the process exists but llama-server is **not yet accepting HTTP requests**
(cold load of a 26B takes ~30 s per the server log), the consumer gets a `baseUrl` and
immediately POSTs `/chat/completions` → `ECONNRESET`. The control-client contract
(`AgentWatch/docs/forge-control-client.md`) promises `/ensure` "waits until it is healthy"
— that guarantee must be enforced with a real readiness probe, not just process spawn.

---

## 3. The fix

### Fix 1 — Serialize `/release` on the same chain as `/ensure`
Route `/release` through `this.serialize(...)` too (or share a single async mutex around
all `holds`/pool mutations). After this, `holds` is only ever observed/mutated by one
critical section at a time. (`ControlServer.ts:119-123`, `:214-218`.)

### Fix 2 — Make `/ensure` readiness-gated
`ensure()` must not return 200 until the loaded backend **actually answers a request**:
add a readiness probe after `pool.acquire` — e.g. poll `GET {baseUrl}/models` (or a tiny
`/health`) until 200, with a bounded timeout, before returning the `baseUrl`. On timeout,
return `502` with a clear "loaded but not ready" message. This closes the cold-load
`ECONNRESET` at the source. (`ControlServer.ts:160-173`.)

### Fix 3 — Never evict a model with any recent/in-flight activity
Harden `makeRoom` so eviction requires more than a single `holds === 0` snapshot:
- Only evict a model that has been idle (`holds === 0`) **and** has had no successful
  acquire within a short grace window (e.g. 2–5 s), tracked via a `lastAcquiredAt` map; or
- equivalently, perform the idle-check + `pool.release` **inside the serialized critical
  section** so it cannot interleave with an in-progress `/ensure`/`/release`.
Goal: a model that is loaded and being driven is never LRU-evicted from under a live
request, even if its ref-count momentarily reads 0. (`ControlServer.ts:181-200`.)

### Fix 4 (optional, observability)
Include `holds` per model in `GET /models` (the status snapshot at `:19`/`:85-95` already
tracks `holds` for the status UI — expose it on the public `/models` too) so consumers and
operators can see the live ref-count when diagnosing churn.

---

## 4. Acceptance criteria
- 4 concurrent same-model `/ensure` calls + interleaved `/release` calls (fuzz/stress
  test) never produce an unload of the in-use model and never tear a live connection.
- `/ensure` returns 200 only after the backend answers a probe; a consumer that POSTs
  immediately on the returned `baseUrl` never sees `ECONNRESET` due to cold load.
- A second-model `/ensure` at capacity still returns a clean `409` when all loaded models
  are genuinely in use (existing behaviour preserved).
- No regression to single-consumer ensure→release.

## 5. Test plan
- Unit: drive `ControlServer` with concurrent `/ensure`+`/release` against a fake pool;
  assert `holds` never goes negative, eviction never targets an active model, and all
  mutations are serialized.
- Unit: fake a pool whose backend is "spawned but not serving" for N ms; assert `/ensure`
  blocks until the probe passes (or times out → 502).
- Integration (manual): with AgentWatch Fix A NOT yet applied (worst case — per-worker
  hold churn), run 4 concurrent same-model workers and confirm zero `ECONNRESET`. That
  proves the server is robust independent of consumer behaviour.

## 6. Git / board hygiene (do this in THIS repo)
1. **Do NOT touch `bridge.yaml`** (documented hard stop in `FORGE.md`). This change is
   code-only in `src/backend/ControlServer.ts` (+ tests).
2. Branch: `git checkout -b fix/control-server-serialize-and-readiness`.
3. Implement Fixes 1–3 (+4 optional), run the Vitest suite + lint
   (`test/unit/` already covers backend args; add control-server concurrency tests).
4. Commit with a descriptive message; end the body with:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
5. Confirm `vsce package` is **not** run without explicit confirmation (FORGE.md hard
   stop). Post a one-line result wherever this work is being tracked.
