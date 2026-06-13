# Multi-Backend Board Smoke Test — Findings & Fix TODOs

**Date:** 2026-06-12
**Test:** "Asteroid Dodge 3D" — 5-file Three.js game built by 4 backends,
orchestrated by Claude (master) through the Forge Relay board (`:7878`)
using `dispatch_subagent` → Forge Control API (`:8799`).

## Test result

PASS overall — game assembled, runs in browser, esbuild bundle clean.

| File | Author model | Route |
|------|--------------|-------|
| interface contract | gpt-oss:120b-cloud | subcoordinator (tier `none`) |
| scene.js | qwen3-coder:480b-cloud | ollama cloud, async clanker |
| player.js | gemma4-26b-a4b-it-iq3s | llama.cpp local, async clanker |
| ui.js | gemma4:31b-cloud | ollama cloud (re-routed, see F3) |
| asteroids.js | qwen36-35b-a3b-iq3s | llama.cpp local, after model swap |
| index.html + integration fixes | claude-code | master |

Master caught 3 worker integration bugs (string passed to `updateHUD`,
renderer stacking on restart, un-staggered asteroid spawn depth). Worker
output quality is a model problem, not a product bug — but the contract
gap (no spawn staggering specified) shows subcoordinator contracts need a
"gameplay/runtime behavior" section, not just signatures.

---

## Findings → Fix TODOs

### F1 — Silent empty worker result on reasoning overflow (Relay) — PRIORITY 2

A large planning task to gpt-oss:120b-cloud returned `COMPLETED:` with
EMPTY text — reasoning consumed the whole completion cap; `finish_reason`
was never surfaced. Small tasks (PONG) work. Most dangerous bug
behaviorally: the coordinator gets success + nothing.

- [ ] Relay: empty content + `finish_reason: length` ⇒ worker ERROR (or
      auto-retry with raised cap), never "COMPLETED".
- [ ] Root-cause refinement: `reasoning_effort: medium` already exists in
      `config.yaml` for gpt-oss — but Relay's direct-to-baseUrl dispatch
      bypasses Forge's per-model config entirely, so it never applies.
      Either Relay reads the model's config defaults via the control API,
      or the F3 `/chat` proxy (which applies Forge config) becomes the
      dispatch path. Workers should default to `low`.
- [ ] Same family: gemma4 GGUF workers burn the whole budget on
      `reasoning_content` — worker dispatch path should send
      `chat_template_kwargs: { enable_thinking: false }` (validated live
      against llama-server) or route to the `-worker` model variants.

### F3 — No provider-backed worker path (Forge feature gap) — PRIORITY 3

OpenRouter dispatch is correctly 422-rejected by `/ensure` (bridge
removed; key unreachable outside the extension host). Correct behavior,
but it means Relay has NO path to OpenRouter/xAI workers.

- [ ] Add `POST /chat` proxy to `ControlServer.ts` that routes
      provider-backed models through `ChatClient` inside the extension
      host, where SecretStorage is readable. Key never leaves Forge —
      consistent with the hard-stop rules.
- [ ] Relay: route `openrouter`/`xai` catalog entries via `/chat` instead
      of `/ensure`.

### F2 — Worker board identity collision (Relay) — PRIORITY 4

`worker-N` is slot-based, not subagent-based: gpt-oss and qwen3-coder both
posted as `worker-2`; gemma appeared as `worker-1` AND `worker-2`. Audit
trail cannot reconstruct who did what.

- [ ] Derive board identity from subagent id + model
      (e.g. `worker:sa_mqb3bgr:qwen3-coder`), drop the reused counter.

### F6 — Model category/variant mismatch in `config.yaml` (config + schema) — PRIORITY 3

The `-coding` / `-vision` / `-worker` suffix convention does not match
what the entries actually declare, so any capability-filtered catalog
(model picker, Relay `list_models`) misrepresents the models:

- Base entries declare NO `capabilities` at all, while their suffixed
  twins declare `[tool-call]` — yet the base `gemma4-26b-a4b-it-iq3s`
  tool-called fine (it wrote player.js). Bases look tool-incapable.
- `-vision` is not a real category: base entries also set `mmproj_path`
  (vision-capable in practice) without the `vision` capability.
- The same GGUF is registered 4–5× with variants differing only in
  `n_parallel` / `num_ctx` / `system_prompt`; the flat `/models` catalog
  shows them as distinct models — confusing on the board and in pickers.
- `-worker` variants keep `think: true` + large `--reasoning-budget`,
  the opposite of worker needs; Relay dispatched base models anyway.
- Stop-token bug: every gemma llama.cpp entry sets `stop: "<|im_end|>"`
  (ChatML/Qwen token); gemma's is `<end_of_turn>` — the stop never fires.

- [ ] Make `capabilities` explicit and correct on EVERY entry (derive
      vision from `mmproj_path` presence at load if absent).
- [ ] Fix gemma stop tokens (`<end_of_turn>`, not `<|im_end|>`); set
      `think: false` (or minimal budget) on `-worker` variants and point
      Relay's worker tier at them. (Interim mitigation until redesign.)

**DECIDED resolution — models vs profiles redesign:**

Roles become request-time *profiles* applied to models, not name-suffixed
model clones. Rationale: nearly everything that distinguishes the current
`-coding`/`-vision`/`-worker` variants (system_prompt, sampling, thinking
policy) is request-time and does not require its own llama-server spawn;
one loaded GGUF can serve subcoordinator AND worker roles simultaneously.

- `models:` — one entry per GGUF/endpoint, facts only (`gguf_path`,
  `mmproj_path`, `spawn: { num_ctx, n_parallel, kv types }`).
  Capabilities auto-derived (vision ⇐ mmproj present; tool-call ⇐
  `ModelCapabilities.ts` runtime detection).
- `profiles:` — named role presets (`main`, `subcoordinator`, `worker`,
  …) holding request-time config; applied to any model. Dispatch names a
  pair: `gemma4-26b-iq3s@worker`.
- Spawn-time variation (e.g. long-context) stays as explicit per-model
  `spawn_profiles:` overrides — the exception; profile switch within the
  same spawn settings never respawns. F4 eviction handles real respawns.
- Shared system prompt / sampling defaults collapse to one `defaults:`
  block (~950-line config → ~300).
- Breaking schema change: `schema.ts`, `ConfigLoader`, `LlamaServerArgs`,
  control-server catalog; ship with alias layer so current suffixed names
  keep resolving during migration. Sequenced AFTER F4/F5.

### Minor (Relay UX)

- [ ] `mode: "async"` blocks until `/ensure` completes (up to 120 s) before
      returning; if the caller's MCP session closes first, the dispatch
      result is lost. Async should return immediately and post ensure
      failures to the board.

---

## Resolved this cycle (archive)

- **F4 — VRAM eviction on model swap**: fixed in `63a70ec`
  (`ControlServer.makeRoom`: every idle zero-hold local model is released
  before a spawn; `release` stays pure hold bookkeeping; explicit
  `POST /unload` added). Live-validated 2026-06-12 per
  `F4F5_LIVE_VALIDATION.md`:
  - Test 1 (auto-evict swap) PASS — qwen ensure returned 200 in ~50 s,
    gemma's llama-server killed first, single process, only qwen loaded.
  - Test 1 grace-window caveat: with `max_simultaneous_models: 4` the
    409 `busy` branch is unreachable when only one held model remains
    (1 < capacity), so ensuring B while A is held double-loads instead of
    409ing. The protective invariant held (held model was NOT evicted).
    The 409 expectation in the validation doc assumes capacity 1.
  - Test 2 (/unload semantics) PASS — 409 on active holds, 200
    `unloaded:true` then idempotent `false`, ollama-cloud path `false`
    (never loaded), 422 cloud-provider, 404 unknown; process exited.
- **F5 — Stale `loaded=true` after external death**: fixed in `63a70ec`
  (child `exit` event reconciles pool state). Live-validated 2026-06-12:
  Test 3 PASS — `loaded=false` within 3 s of external `Stop-Process`;
  follow-up ensure cold-started cleanly in 10 s on the freed base port
  (:8080), no slot/port leak.

- Flashing DOS windows on ollama daemon auto-start — fixed (non-detached
  on win32 + `windowsHide: true`, `OllamaAdapter.ts`), validated live,
  shipped in `a954ead`.
- Cold ollama daemon auto-start, cloud-model 422 gating, control-server
  lifecycle — validated in `08fc269` and re-validated here.

## Demo

The assembled game is kept as a demo in `smoke3d/` (untracked). Serve with
any static server from that folder and open `index.html`
(e.g. `python -m http.server 8123 --directory smoke3d`).

## Not yet covered (future test passes)

- The 44-tool Forge catalog against each backend (workers only exercised
  `write_file`; `readonly` tier / `propose_diff` untested).
- Actual OpenRouter completion (blocked on F3 fix).
- Concurrent same-model parallel requests (llama-server slot behavior).
- Cancel/abort mid-dispatch; worker timeout handling.
- Two small GGUFs genuinely co-resident (VRAM-fitting pair) after F4 fix.
