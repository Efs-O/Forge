# VRAM admission warning — impl plan

**Goal:** before a *second* local model is loaded alongside one that is already
resident, tell the user it will not fit and offer to unload the other one. Today
Forge counts **slots, not gigabytes**: `max_simultaneous_models: 4` lets four
llama-servers spawn on a 16 GB card, and the 4th OOMs or WDDM-thrashes.

**Behaviour: warn with override.** The estimate is approximate by construction
(see "Why this is only an estimate"), so a hard block would eventually refuse a
load that would have worked. Forge advises; the user decides.

**Scope discipline (no complexity):** three small pure-ish modules, one call
site, one config block. **`BackendPool.acquire()` is not touched** — because the
check never blocks, it does not need to live on the spawn path. No GGUF binary
parsing in this pass. No new dependencies.

---

## Why the check goes at pin time, not in the pool

`BackendPool.acquire()` is the wrong home:

- It has no `vscode` import and must not grow one — it is called by the control
  server, `DelegationGate`, and the worker fleet, none of which can answer a
  modal prompt (the same deadlock shape as Claude's `plan` mode under `-p`).
- An advisory that never blocks has no reason to sit on the hot send path.

The natural moment is `ConversationTabs.pinModel()` — the user just chose a
model, `vscode.window` is already in scope there, and it is where
`releaseIfUnused()` and `offerUnload()` already live
(`src/sidebar/ConversationTabs.ts:108`, `:189`, `:212`). The prompt reuses
`offerUnload()`'s exact shape.

Consequence to accept: we warn at *pick* time, and the spawn happens later on
first send, so free VRAM can drift in between. Acceptable for an advisory —
and it is the moment the user can actually still change their mind.

---

## New module: `src/backend/VramProbe.ts` (~80 LOC)

Owns "how much VRAM is free". Nothing in the codebase queries the GPU today.

```ts
export interface VramReading { totalMib: number; freeMib: number; }
export interface VramProbe { read(): Promise<VramReading | null>; }
```

- `execFile` (array args, **no shell**), fixed argv:
  `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`
- Resolved from `PATH`; `vram_check.nvidia_smi_path` overrides. **No hardcoded
  OS path.**
- `AbortController` + 2 s timeout, per the TS rules.
- Result cached for `CACHE_MS = 3000` — the pin handler must not spawn a process
  per keystroke in the picker.
- Multi-GPU: read **GPU 0** in this pass. `vram_check.gpu_index` selects another.
  Summing across GPUs would be wrong (a model does not span cards by default).
- **Returns `null`** when `nvidia-smi` is absent, errors, or the output does not
  parse — AMD, Apple Silicon, CPU-only. Never guesses a number.

`null` ⇒ the whole feature no-ops silently *for that load*, but the reason is
logged once per session at `warn`, and the Model Manager shows "VRAM check
unavailable (nvidia-smi not found)". That satisfies **no silent fallbacks**: the
capability is visibly off rather than quietly passing everything.

---

## New module: `src/backend/VramEstimate.ts` (~90 LOC)

Owns "how much VRAM would this model take". Pure — config in, MiB out, no I/O
except one `fs.stat`.

```ts
export interface VramEstimateInput {
  model: ModelConfig;
  config: ForgeConfig;
  sizeBytes: number;        // fs.stat on model_path (+ mmproj_path)
}
export interface VramEstimate {
  weightsMib: number;
  kvMib: number;
  overheadMib: number;
  totalMib: number;
  confidence: 'rough';      // honest label, surfaced in the message
}
```

**Weights.** `sizeBytes` scaled by the offloaded fraction:

- `n_gpu_layers >= 999` (or unset — the 0.12.46 default) ⇒ factor `1.0`.
- `n_gpu_layers === 0` ⇒ `0` on GPU.
- A finite count ⇒ `min(1, n_gpu_layers / assumedLayerCount)`. We do not know
  the real layer count without parsing the GGUF, so Phase 1 uses a family table
  in `ModelHeuristics` (`detectFamily` already exists) and rounds **up**.
- `mmproj_path` counts **only if** `--no-mmproj-offload` is absent from the
  resolved spawn args (`LlamaServerArgs.ts` composes them).

**KV cache.** The variable that actually bites at your context sizes:

```
kvMib ≈ perSlotContext × n_parallel × kvBytesPerToken(family) × kvTypeFactor
```

- Context comes from **`perSlotContext()` in `src/util/contextBudget.ts`** —
  it already owns the `num_ctx / n_parallel` rule and must not be reimplemented
  (single point of truth). Note the total to reserve is `perSlot × n_parallel`,
  i.e. the full `num_ctx`.
- `kvBytesPerToken` is a per-family constant (derived from layer count × KV
  heads × head dim). Table in `VramEstimate.ts` with the arithmetic shown in a
  comment, `unknown` family ⇒ the largest entry (fail toward "won't fit").
- `kvTypeFactor` from resolved `type_k`/`type_v`: `f16` ⇒ 1.0, `q8_0` ⇒ 0.53,
  `q4_0` ⇒ 0.30. These fields exist at model, group **and** `llama_server`
  level, so read them through `ConfigResolver`'s merged view, never off
  `model.*` directly.

**Overhead.** Compute buffers, CUDA context, fragmentation: flat
`vram_check.overhead_mib` (default **1024**, matching the ~1024 MiB margin
`-ngl -1` auto-fit reserves — the number llama.cpp itself picked).

---

## New module: `src/backend/VramAdmission.ts` (~70 LOC)

Pure decision function. No `vscode`, no I/O — trivially unit-testable.

```ts
export type VramVerdict =
  | { kind: 'unavailable' }                      // probe returned null
  | { kind: 'not-local' }                        // cloud / remote Ollama
  | { kind: 'fits'; headroomMib: number }
  | { kind: 'tight'; headroomMib: number; suggestions: EvictionSuggestion[] }
  | { kind: 'wont-fit'; shortfallMib: number; suggestions: EvictionSuggestion[] };
```

- Gated on **`isLocalModel()`** (`src/backend/ModelHeuristics.ts:19`) — it
  already draws exactly the right line (llama.cpp always; Ollama only on a local
  endpoint). Cloud models return `not-local` and cost nothing.
- Remote-Ollama and daemon-backed targets are `not-local`: the daemon owns that
  VRAM, same reasoning as `DelegationGate.ts:9`.
- `tight` = fits within `overhead_mib` of the limit — warn, but the default
  button is "Load".
- `suggestions` ranks currently-loaded local models by `estimate` descending,
  each annotated with whether another tab is pinned to it (reuse the
  `conversations.some(...)` test from `unloadCandidate()`) and whether a
  delegation hold pins it (`pool.gate.isPinned` — an unevictable one is listed
  but not offered).

---

## Call site: `ConversationTabs.pinModel()` (~15 LOC + one helper)

After the existing `releaseIfUnused(outgoing, name)` — that path may itself have
just freed the VRAM, so the check must run **after** it, on fresh numbers:

```ts
if (name) void this.warnIfVramTight(name);
```

`warnIfVramTight` is `private async`, fire-and-forget (`void`), never blocks the
picker, and returns early on `not-local` / `unavailable` / `fits`.

Message, matching `offerUnload()`'s style:

> **qwen3.8-27b** needs ~14.2 GB but only 7.3 GB is free — **gemma4-12b**
> (~8.1 GB) is loaded in *Chat 2*. Estimate is approximate.
> `[Unload gemma4-12b] [Load anyway] [Cancel]`

- `Unload gemma4-12b` ⇒ `pool.release(base)` + the existing `onBackendStopped` /
  `backendDown` post, exactly as `offerUnload()` does.
- `Load anyway` ⇒ dismiss; nothing else changes.
- `Cancel` ⇒ re-pin the previous model (`pinModel(outgoing)`), guarded against
  recursion with a re-entrancy flag.
- Skipped entirely while `isStreaming()` — same guard as `releaseIfUnused`.
- A refused release (delegation hold) surfaces via the existing `error` post,
  never swallowed.

---

## Config

New optional top-level block. **Explicit config over hidden behaviour.**

```yaml
vram_check:
  enabled: true          # default true when nvidia-smi resolves, else inert
  overhead_mib: 1024
  gpu_index: 0
  nvidia_smi_path: null  # optional absolute override
```

Touches: `src/config/schema.ts` (next to `max_simultaneous_models:225`),
`src/config/types.ts`, `config/config.example.yaml`. Zod-validated at the
boundary like everything else.

---

## Why this is only an estimate (state it in the UI)

1. File size ≠ resident weights — llama.cpp mmaps, and the offloaded fraction
   depends on the real layer count, which Phase 1 approximates per family.
2. KV cache dominates at your context sizes and needs layer/head counts we are
   not reading yet.
3. WDDM does not hard-OOM on Windows — it thrashes, so "fits" can still be slow.
4. Another Forge window or an external process may hold VRAM we did not spawn
   (`DirectBackend.ts:305` already handles a variant of this).

Hence `confidence: 'rough'`, the word "approximate" in the message, and the
override button. **Round every estimate up**: a false "it fits" is much worse
than a false "it won't".

---

## Phase 2 (not in this pass)

Parse the GGUF header (first few KB: `block_count`,
`attention.head_count_kv`, `embedding_length`) for an exact layer/KV figure,
replacing the family table. ~120 LOC, additive, no redesign — `VramEstimate`'s
interface is already shaped for it. Only worth doing if Phase 1 misjudges in
practice.

---

## Tests

`test/unit/VramEstimate.test.ts`, `VramAdmission.test.ts` — pure, no spawning.

- estimate: `-ngl 999` vs `0` vs a finite count; `type_k: q8_0` shrinks KV;
  mmproj counted only without `--no-mmproj-offload`; group-level `num_ctx`
  inherited (the 0.12.34 bug class); `n_parallel` reserves the full `num_ctx`.
- admission: cloud ⇒ `not-local`; local Ollama vs remote Ollama; probe `null` ⇒
  `unavailable`; suggestion ranking; a delegation-pinned model is listed but
  not offered.
- probe: **injected fake** — CI must never shell out to `nvidia-smi`. One test
  asserts unparseable output ⇒ `null`, not a thrown error or a guessed number.

`ConversationTabs` gets one test: `wont-fit` + "Unload" ⇒ `pool.release` called
with the base name; "Load anyway" ⇒ not called.

---

## Files

| File | Change | ~LOC |
|---|---|---|
| `src/backend/VramProbe.ts` | new — nvidia-smi + cache | 80 |
| `src/backend/VramEstimate.ts` | new — footprint estimate | 90 |
| `src/backend/VramAdmission.ts` | new — verdict + suggestions | 70 |
| `src/sidebar/ConversationTabs.ts` | `warnIfVramTight` + pin hook | +45 |
| `src/config/schema.ts`, `types.ts` | `vram_check` block | +25 |
| `config/config.example.yaml` | documented defaults | +8 |
| `docs/OWNERS.md` | three new rows | +3 |
| tests | 3 new files | 180 |

All files stay under the 350-LOC limit. `ConversationTabs.ts` is currently 228
lines → ~273, still inside.

**Estimate: half a day**, most of it on the KV arithmetic and its tests rather
than the plumbing.

---

## Open questions for review

1. **`enabled` default.** Proposed: true, inert without `nvidia-smi`. The
   alternative — opt-in — means nobody who needs it discovers it.
2. **Cancel semantics.** Re-pinning the previous model is the least surprising,
   but it means a picker choice can visibly bounce back. Acceptable?
3. **Should `tight` prompt at all,** or only log? Proposed: prompt, because
   WDDM thrashing is worse than an OOM — it looks like a hang, not an error.
