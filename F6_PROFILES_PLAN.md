# F6 — Models-vs-Profiles Redesign (Forge side) — FULL IMPLEMENTATION PLAN

Status: PLAN (implement in a fresh session). Breaking schema change.
Reference format: `F3_CHAT_PROXY_PLAN.md`. Findings: `RELAY_SMOKE_FINDINGS.md` §F6.
Relay counterpart: `forge-relay/F6_RELAY_PROFILES_PLAN.md`.
User decisions (2026-06-13): migrate live `.forge/config.yaml` in place (+ `.bak`);
`config.yaml` is LOC-exempt; default cadence is plan→implement, but this one is
large so it was deliberately deferred to its own session.

---

## 1. Problem (smoke test §F6)

The same GGUF is registered 4–5× as name-suffixed clones (`-coding` / `-vision`
/ `-worker`) differing only in request-time fields. Defects:

1. Capabilities wrong: bases declare none, suffixed twins declare `[tool-call]`,
   yet bases tool-call fine.
2. `-vision` fake: bases also set `mmproj_path` (vision-capable) without the
   `vision` cap — **and `mmproj_path` is not in `schema.ts`, so Zod strips it**
   and `LlamaServerArgs.ts:71` never sees it. Latent dead path. (`types.ts:9`
   declares it, but schema drops it at parse → fix this too.)
3. Flat `/models` catalog shows 4–5 near-identical rows (confusing on board/pickers).
4. `-worker` variants keep `think:true` + large reasoning budget (wrong for workers).
5. Stop-token bug: every gemma llama.cpp entry sets `stop:"<|im_end|>"` (ChatML/Qwen);
   gemma's is `<end_of_turn>` — stop never fires.

## 2. Design — two resolution flavors (the crux)

Roles become request-time **profiles** applied to models; one loaded GGUF serves
many roles. The key insight from the call-site audit: there are **two** distinct
resolutions, and conflating them is the trap.

- **Spawn-time resolution** (for `BackendPool` / `DirectBackend` / `LlamaServerArgs`):
  base model facts + `spawn` block (+ optional `spawn_profile`). Keyed by **base
  model name** so the profile suffix never forces a respawn. Profiles do NOT
  affect spawn.
- **Request-time resolution** (for `AgentLoop` / `ControlChatProxy`): base +
  `defaults` + named `profile` (system_prompt, sampling, think, reasoning_effort,
  strip_tools, strip_thinking_channels). Applied per request, no respawn.

Both flavors return a **flattened legacy `ModelConfig`** so every existing
consumer keeps working unchanged. This is what bounds the blast radius.

### New schema shape

```yaml
defaults:                      # NEW, optional — shared request-time defaults
  system_prompt: "<main prompt>"
  sampling: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 }
  think: false
  reasoning_effort: low

models:                        # one entry per GGUF/endpoint — FACTS ONLY
  - name: gemma4-26b-iq3s
    provider: llama.cpp
    gguf_path: /models/gemma4-26b-a4b-it-iq3s.gguf
    mmproj_path: /models/gemma4-mmproj.gguf     # vision auto-derived
    spawn:                     # spawn-time facts (replaces flat num_ctx/etc.)
      num_ctx: 32768
      n_parallel: 4
      type_k: q8_0
      type_v: q8_0
      flash_attn: true
      n_gpu_layers: -1
      n_batch: 512
      extra_llama_server_args: []
    spawn_profiles:            # rare spawn-time overrides (the exception)
      long-context: { num_ctx: 131072, n_parallel: 1 }
  - name: grok-code
    provider: xai
    api_key_secret: xai

profiles:                      # NEW — request-time role presets
  main:           { system_prompt: "...", think: true, reasoning_effort: medium }
  subcoordinator: { system_prompt: "...", think: true }
  worker:         { think: false, reasoning_effort: none,
                    sampling: { temperature: 0.2, stop: "<end_of_turn>" } }

active_model: gemma4-26b-iq3s@main     # model@profile (profile optional)

aliases:                       # NEW — migration shim (removable later)
  gemma4-26b-a4b-it-iq3s-worker: gemma4-26b-iq3s@worker
  gemma4-26b-a4b-it-iq3s-coding: gemma4-26b-iq3s@main
  gemma4-26b-a4b-it-iq3s-vision: gemma4-26b-iq3s@main   # vision is a capability, not a role
```

### Merge precedence

Request-time: `defaults` < base facts (request-time fields if any) < `profiles[p]`.
Spawn-time:  base `spawn` < `spawn_profiles[sp]`.
Capabilities: explicit `capabilities:` override > derived (`vision` ⇐ `mmproj_path`;
`tool-call` ⇐ `ModelCapabilities` runtime detection; `long-context` ⇐ a
`long-context` spawn_profile exists or num_ctx ≥ threshold).

## 3. New file — `src/config/ConfigResolver.ts` (~140 LOC, keeps loader/schema under cap)

Exports:
- `splitModelProfile(id: string): { base: string; profile?: string }` — strip a
  trailing `@<profile>` (`[A-Za-z0-9_-]+`); leave internal text intact.
- `expandAlias(config, id): string` — if `id`'s base matches an alias key, return
  the alias target (carrying through any explicit `@profile`); log once on hit.
- `resolveRequestModel(config, id): ModelConfig` — request-time flatten
  (defaults+base+profile). Unknown profile ⇒ throw; unknown base ⇒ throw.
- `resolveSpawnModel(config, base, spawnProfile?): ModelConfig` — spawn-time
  flatten (base facts + spawn(+spawn_profile) → flat `num_ctx`/`n_parallel`/
  `type_k`/`type_v`/`flash_attn`/`n_gpu_layers`/`n_batch`/`extra_llama_server_args`).
- `deriveStaticCapabilities(facts): ('tool-call'|'vision'|'long-context')[]` —
  vision from mmproj; tool-call/long-context as above.
- `listProfiles(config): string[]` and `availableProfilesFor(config, base): string[]`.

Legacy fallback: a model with no `spawn` block reads its flat fields (current
behavior). A config with no `defaults`/`profiles` and a bare `active_model`
resolves to today's behavior exactly (regression-test this).

## 4. Schema + types changes

`src/config/schema.ts` (+~90):
- `ModelConfigSchema`: add `mmproj_path: z.string().optional()` (fixes the stripped
  field), `spawn: SpawnSchema.optional()`, `spawn_profiles: z.record(SpawnSchema.partial()).optional()`.
  Keep all current flat fields (deprecated-but-accepted).
- `SpawnSchema`: num_ctx, n_parallel, n_batch, type_k, type_v, flash_attn,
  n_gpu_layers, extra_llama_server_args (all optional).
- `ProfileSchema`: system_prompt, sampling (reuse existing sampling object),
  think, reasoning_effort, strip_tools, strip_thinking_channels, capabilities.
- Top level: `defaults: ProfileSchema.partial().optional()`,
  `profiles: z.record(ProfileSchema).optional()`,
  `aliases: z.record(z.string()).optional()`.
- `active_model` stays a string but may carry `@profile`.

`src/config/types.ts` (+~40): `SpawnConfig`, `ProfileConfig`, add `spawn?`,
`spawn_profiles?` to `ModelConfig`; add `defaults?`, `profiles?`, `aliases?` to
`ForgeConfig`. (`mmproj_path` already on the type.)

## 5. Integration points (audited call sites — thread the resolver here)

| Site | Today | Change |
|---|---|---|
| `ConfigLoader.ts:39` | active_model must equal a model name | validate `splitModelProfile(active_model).base` ∈ models; validate profile ∈ profiles; validate every alias target resolves | 
| `ConfigLoader.ts:44` | sort models | unchanged (sort base models) |
| `AgentLoop.ts:259` | `models.find(name===active_model)` | `resolveRequestModel(config, config.active_model)` |
| `ControlChatProxy.ts:74` | `models.find(name===req.model)` | `resolveRequestModel(config, req.model)` (req.model may be `base@profile`); cloud key/provider come from base facts |
| `BackendPool.ts:247` | `models.find(name===modelName)` | `resolveSpawnModel(config, splitModelProfile(modelName).base)`; pool key = base name |
| `DirectBackend.ts:290` | `models.find(name===name)` | same spawn-time resolve; `:63/:95/:125/:134` active_model bookkeeping stores **base** name |
| `ControlServer.ts:183` (modelList) | one row per model | one row per **base** model; add `profiles: availableProfilesFor()` + derived `capabilities`; `servable` unchanged |
| `ControlServer.ts:197` (ensure) | `models.find(name===model)` | ensure on `splitModelProfile(model).base`; spawn-time resolve |
| `ControlServer.ts:322` (unload) | find by name | strip profile → base |
| `nativeCommands.ts:70/79` (picker) | list model names | list `base@profile` pairs (or base + profile quick-pick); set `active_model` to the pair |
| `extension.ts:244` | preserve prev active if name still present | compare on base name |
| `FirstRunWizard.ts:25/43` | emits `active_model: <name>` + flat model | emit new shape (defaults + one model + minimal profiles) — keep wizard output valid under new schema |

`LlamaServerArgs.ts`: no change if `resolveSpawnModel` outputs flat fields
(it already reads `model.num_ctx`/`type_k`/`mmproj_path`/etc.). Add a regression
test that args are identical from `spawn` block vs legacy flat.

`ChatClient` / `OpenAIClient` / `OllamaNativeClient` / `SamplingMerge` /
`SystemPromptInjector`: unchanged — they receive an already-flattened `ModelConfig`.

## 6. Catalog / control API shape

`GET /models` rows gain `profiles: string[]` and corrected `capabilities`.
`/ensure` and `/unload` accept `base` or `base@profile` (strip profile). `/chat`
already takes `model`; `resolveRequestModel` handles `base@profile`. Relay's
`list_models` + `@profile` dispatch consume these (see relay plan).

## 7. Live config migration (`.forge/config.yaml`, 954 → ~300)

1. `cp .forge/config.yaml .forge/config.yaml.bak` first.
2. Collapse each GGUF's 4–5 suffixed clones into one base `models:` entry (facts
   + `spawn`), move shared `system_prompt`/sampling to `defaults:`, define
   `profiles: {main, subcoordinator, worker}`.
3. Add `aliases:` for every old suffixed name → `base@profile` so existing
   dispatches/`active_model` keep resolving.
4. Fix gemma stop tokens to `<end_of_turn>` in the worker/relevant profile.
5. Reload Forge; verify `/models` lists bases + profiles, a llama.cpp model loads,
   and an alias name still resolves.

## 8. Test plan (vitest)

- `ConfigResolver`: split (bare / `@worker` / `forge:`-style untouched / internal
  colon kept); request merge precedence; spawn merge + spawn_profile; alias
  expansion; unknown profile/base/alias-target ⇒ error; legacy-flat regression.
- `schema`: new shape parses; legacy flat parses; `mmproj_path` survives parse.
- capability derivation: vision from mmproj; explicit override wins.
- `LlamaServerArgs` parity: spawn-block vs flat produce identical argv.
- catalog: `/models` row has `profiles` + derived caps; ensure/unload strip `@profile`.
- Gates: `npx tsc --noEmit`, `npx vitest run`, `npm run package`.

## 9. Back-compat & no-fallback discipline

- Alias layer is the ONLY name-rewrite; logged once per hit (migration nudge).
- No silent defaults beyond documented legacy-flat reading.
- Surface unknown-profile / unknown-alias-target as load-time errors.

## 10. Out of scope

- F2 (worker-N identity) — done. Relay `@profile` parsing + daemon supervisor —
  relay plan. Async-dispatch "return immediately" — separate Minor item.
- Removing the alias layer (later cleanup once migrated).

## 11. Suggested commit sequence (feature branch `feature/f6-profiles`)

1. schema + types + `ConfigResolver` + resolver/schema tests (no consumer wiring).
2. Thread spawn-time resolve (BackendPool, DirectBackend, ControlServer ensure/unload) + tests.
3. Thread request-time resolve (AgentLoop, ControlChatProxy) + catalog `profiles` + tests.
4. Picker + wizard + extension active-model bookkeeping.
5. `config.example.yaml` rewrite; migrate live `.forge/config.yaml` (+ .bak).
6. Gates; bump version; merge to main.
