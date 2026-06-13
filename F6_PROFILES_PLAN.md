# F6 — Models-vs-Profiles Redesign (Forge side)

Status: PLAN (awaiting sign-off — breaking schema change)
Owner files: `src/config/schema.ts`, `src/config/types.ts`,
`src/config/ConfigLoader.ts`, `src/backend/LlamaServerArgs.ts`,
`src/backend/ControlServer.ts` + catalog, `src/backend/ModelCapabilities.ts`.
Reference format: `F3_CHAT_PROXY_PLAN.md`. Findings: `RELAY_SMOKE_FINDINGS.md` §F6.

---

## Problem (from the smoke test)

The current `config.yaml` registers the *same* GGUF 4–5× as name-suffixed
clones (`-coding` / `-vision` / `-worker`) that differ only in request-time
fields (`system_prompt`, `sampling`, `think`, `reasoning_effort`). Concrete
defects this causes:

1. Capabilities are wrong/misleading: base entries declare no `capabilities`,
   suffixed twins declare `[tool-call]`, yet a base model tool-called fine.
2. `-vision` is fake: bases also set `mmproj_path` (vision-capable) without
   the `vision` capability — **and** `mmproj_path` is not even in `schema.ts`,
   so Zod strips it and `LlamaServerArgs.ts:71` never sees it. Latent dead path.
3. The flat `/models` catalog shows 4–5 near-identical rows → confusing on the
   board and in pickers.
4. `-worker` variants keep `think: true` + large reasoning budget — the
   opposite of worker needs.
5. Stop-token bug: every gemma llama.cpp entry sets `stop: "<|im_end|>"`
   (ChatML/Qwen); gemma's stop is `<end_of_turn>`, so the stop never fires.

## Decided design (RELAY_SMOKE_FINDINGS.md §F6)

Roles become **request-time profiles** applied to models, not name-suffixed
clones. One loaded GGUF serves subcoordinator AND worker roles at once;
nothing that distinguishes the variants needs its own llama-server spawn.

### New schema shape

```yaml
defaults:                      # shared request-time defaults (NEW, optional)
  system_prompt: "<main system prompt>"
  sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 }
  think: false
  reasoning_effort: low

models:                        # one entry per GGUF/endpoint — FACTS ONLY
  - name: gemma4-26b-iq3s
    provider: llama.cpp
    gguf_path: /models/gemma4-26b-a4b-it-iq3s.gguf
    mmproj_path: /models/gemma4-mmproj.gguf      # vision auto-derived
    spawn:                     # spawn-time facts (move from flat fields)
      num_ctx: 32768
      n_parallel: 4
      type_k: q8_0
      type_v: q8_0
      flash_attn: true
      n_gpu_layers: -1
    spawn_profiles:            # rare spawn-time overrides (the exception)
      long-context: { num_ctx: 131072, n_parallel: 1 }
  - name: grok-code
    provider: xai
    api_key_secret: xai

profiles:                      # NEW — named request-time role presets
  main:           { system_prompt: "...", think: true, reasoning_effort: medium }
  subcoordinator: { system_prompt: "...", think: true }
  worker:         { think: false, reasoning_effort: none,
                    sampling: { temperature: 0.2 }, strip_tools: false }

active_model: gemma4-26b-iq3s@main      # model@profile pair (profile optional)

aliases:                       # NEW — migration shim, removable later
  gemma4-26b-a4b-it-iq3s-worker: gemma4-26b-iq3s@worker
  gemma4-26b-a4b-it-iq3s-coding: gemma4-26b-iq3s@main
```

### Resolution order (the core rule)

A request names a `model@profile` pair. Effective config =
`defaults` < `models[].` (facts) < `profiles[profile]` (request-time) <
optional `spawn_profiles[…]` (spawn-time only). Profile changes that touch
**only** request-time fields never respawn — the loaded GGUF is reused.
Only `spawn` / `spawn_profiles` differences force a respawn (F4 eviction
already handles that).

### Capability derivation (auto, not declared)

- `vision` ⇐ `mmproj_path` present.
- `tool-call` ⇐ `ModelCapabilities.ts` runtime detection (already exists).
- `long-context` ⇐ presence of a `long-context` spawn_profile (or num_ctx
  threshold). Explicit `capabilities:` still allowed as an override.

---

## Files & estimated LOC

| File | Change | ~LOC |
|---|---|---|
| `src/config/schema.ts` | Add `mmproj_path`, `spawn`, `spawn_profiles` to model; new `defaults`, `profiles`, `aliases` top-level; keep flat fields as deprecated-but-accepted | +90 |
| `src/config/types.ts` | New `ProfileConfig`, `SpawnConfig`, `ModelFacts`; extend `ForgeConfig` | +40 |
| `src/config/ConfigResolver.ts` (NEW) | `resolveModelProfile(cfg, "model@profile") → EffectiveModel` merge + alias expansion + `splitModelProfile()` | +120 |
| `src/config/ConfigLoader.ts` | Call resolver for `active_model`; validate profile names + alias targets exist; keep dup-name guard | +25 |
| `src/backend/LlamaServerArgs.ts` | Read from `model.spawn.*` (fallback to flat fields for back-comp); gemma stop-token note | +15 |
| `src/backend/ControlServer.ts` + catalog | `/models` lists base models once with derived caps + available profiles; `/ensure`/`/chat` accept `model@profile` | +30 |
| `src/backend/ModelCapabilities.ts` | Expose `deriveStaticCapabilities(facts)` (vision from mmproj) | +20 |
| `config/config.example.yaml` | Rewrite to new shape (defaults + models + profiles) | rewrite |

New file `ConfigResolver.ts` keeps `ConfigLoader.ts` and `schema.ts` under the
350-LOC cap.

## Back-compat / alias layer (required)

- Old flat model fields (`num_ctx`, `system_prompt`, `sampling`, …) still parse
  and map onto the new shape, so an un-migrated config keeps working.
- `aliases:` maps old suffixed names → `model@profile`. `active_model`,
  `/ensure`, `/chat`, and Relay dispatch all run the name through alias
  expansion first. Logged once at load when an alias is hit (migration nudge).
- No silent fallbacks beyond this documented shim (CLAUDE.md "no fallbacks").

## Test plan (vitest)

- `ConfigResolver`: merge precedence (defaults<model<profile), `model@profile`
  split, bare `model` ⇒ default profile, alias expansion, unknown profile ⇒
  error, unknown alias target ⇒ error.
- `schema`: new shape parses; legacy flat shape still parses; `mmproj_path`
  now survives parse (regression for the stripped-field bug).
- capability derivation: vision from mmproj; explicit override wins.
- `LlamaServerArgs`: args identical whether spawn facts come from `spawn` block
  or legacy flat fields.
- gemma stop-token: example config uses `<end_of_turn>`.
- Run gates: `npx tsc --noEmit`, `npx vitest run`, `npm run package`.

## Live config migration (DECISION NEEDED)

`.forge/config.yaml` (954 lines, gitignored, the user's real models) must be
rewritten to the new shape to get the full benefit. Options:
- (A) I migrate it in place to ~300 lines and the user verifies models still
  load. Higher value, touches their working local file.
- (B) Ship schema + alias layer + new `config.example.yaml` only; the old
  954-line config keeps working untouched via back-compat; migrate later.

## Out of scope

- F2 (worker-N board identity) — independent, already resolved.
- Removing the alias layer (later cleanup once migrated).
- Relay-side `@profile` dispatch parsing — see `forge-relay/F6_RELAY_PROFILES_PLAN.md`.
- Async-dispatch fix (RELAY_SMOKE_FINDINGS "Minor").
