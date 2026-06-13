# Future investigation — VRAM-aware fleet scheduling

Status: **idea / not scheduled.** Captured 2026-06-13 from a design chat.
Not a committed plan — investigate + write a real plan before any code.

## Problem

Forge has **no VRAM accounting and no cross-backend coordination**. Capacity is
a slot count (`max_simultaneous_models`, default 1) and only governs llama.cpp
port slots. Ollama is excluded from capacity/eviction entirely
(`BackendPool.loadedModelNames()` returns llama.cpp slots only; comment:
"Ollama models are unbounded and never evicted").

Result: a llama.cpp GGUF (e.g. gemma4-26b) loaded **and** an Ollama worker of
similar size loaded → Forge does not check, loads no matter what → silent GPU
over-subscription. A llama-server that can't get VRAM starves until its 120 s
health timeout (RELAY_SMOKE_FINDINGS.md F4); Ollama errors ugly.

## Key insight (the leverage is upstream, not in a capacity gate)

When VRAM fits only ONE 26B-class model, two jobs are serial **no matter what**.
So for an *interchangeable-capability* second worker:

- Reuse resident model: `load → job1 → job2` (zero swaps).
- Wait + swap to a same-class model: adds unload + ~50-100 s reload for **no**
  throughput gain. Pure churn.

"Wait for VRAM to free" === "wait for the resident worker to finish." If you're
waiting anyway, hand the resident model the next job.

### When a second model IS worth the swap / wait

Only when it buys something the resident can't:
1. **Capability** the resident lacks — vision (mmproj), coder, bigger context,
   a smarter model for a harder job.
2. **Genuine concurrent fit** — small models that truly fit together
   (e.g. gemma4-26b-**a4b** ×2). Real parallelism = real throughput.

Outside those two, a same-size second worker is wasted swapping.

## Proposed direction (order matters)

### 1. Primary — Relay-side "resident-worker affinity" (the real fix)

At the coordinator/fan-out layer (Relay `decideForgeRoute` / dispatch), prefer a
**loaded equivalent-class** worker over swapping in a same-class one. Decide
*before* dispatching a second model name.

HARD CONSTRAINT: must be an **explicit routing decision, never a silent
substitution.** If a caller asks `/ensure ollama-26b-worker` and Forge quietly
serves the resident gemma GGUF, that is exactly the hidden-fallback behavior the
project bans (CLAUDE.md "No Fallbacks Unless Requested"). The substitution
belongs in Relay's worker-selection, surfaced to the coordinator — not buried in
Forge `/ensure`.

Open question: how does Relay learn "equivalent class"? Needs a capability/size
tag per catalog model (it already gets `capabilities` + `profiles` from
`/models`; would need a rough size/VRAM class too).

### 2. Secondary — nvidia-smi VRAM pre-flight (thin safety net)

With redundant swaps handled upstream, the probe's job shrinks to two narrow
duties:
- **Green-light true concurrency** — confirm a4b×2 (or a4b + small) actually
  fits before loading the second.
- **Fast clear refusal** for genuine over-subscribe — turn the 120 s
  llama-server starvation into an instant "won't fit, release a worker."

Shape: `src/backend/VramProbe.ts` reading
`nvidia-smi --query-gpu=memory.free,memory.total --format=csv,nounits,noheader`
(~50-100 ms, no new dep). Called from `ControlServer.makeRoom()` AFTER idle
eviction. Reads total GPU state, so it sees GGUF + Ollama + other apps at once —
that is the cross-backend awareness Forge lacks.

Caveats (all manageable):
- **NVIDIA-only.** No AMD/ROCm, Intel, Apple Metal. Must degrade gracefully: if
  `nvidia-smi` absent/errors → skip the check and load (never block a load
  because we couldn't measure).
- **The hard half is the model-size estimate, not the free reading.** Free VRAM
  alone can't say "will it fit." Need a footprint estimate:
  - GGUF: file size on disk (have `gguf_path`) + KV-cache
    (`num_ctx × layers × type_k/type_v`, all in config). Coarse but doable.
  - Ollama: harder (no file ownership) — `/api/show` or a tag heuristic.
- **Race** between check and spawn: `/ensure` is already serialized via
  `ControlServer.chain`, so the in-Forge window is tiny; external apps can still
  grab VRAM → stays advisory, not authoritative.
- **Multi-GPU**: sum free across the devices llama-server will use.

## Files in play (for whoever picks this up)

- `src/backend/BackendPool.ts` — slots vs ollamaSlots, eviction, `loadedModelNames`
- `src/backend/ControlServer.ts` — `makeRoom()`, holds, capacity guard (the gate site)
- `src/backend/DirectBackend.ts` — `stop()` → `releaseActiveOllamaModel()` (keep_alive:0)
- Relay: `src/subagentLoop.ts` / `decideForgeRoute` (affinity decision lives here)

## Out of scope until investigated
- Actual VRAM-footprint estimator precision
- Multi-GPU device-matching
- Relay capability/size-class tagging scheme
