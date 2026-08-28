# Slot Affinity and Context Checkpoints

Status: **measured, implementation proposed**. Follows
`docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md`, which shipped in 0.13.18
(`8a01579`). Phase 1 is done — numbers in §8. Phases 2 and 3 are not started.

---

## 1. What changed

The prefix-stability work was written against a belief that hybrid/recurrent
architectures could not reuse a prompt prefix at all, because
`llama_memory_can_shift` is false for them — Qwen3.8-27B is a GDN hybrid, gemma
is sliding-window, and `--cache-reuse` is disabled for both. That belief was
half wrong in a way that matters.

`can_shift == false` blocks *partial KV removal and shifting* — rewriting the
middle of a cached sequence. It does **not** block prefix reuse. llama.cpp
keeps **context checkpoints** per slot (`--ctx-checkpoints`, default 32,
spaced by `--checkpoint-min-step`, default 8192 tokens) and can rewind a
recurrent state to the checkpoint nearest the longest common prefix. So a warm
slot given a longer version of a prompt it already holds re-evaluates only the
tail.

This is not speculative — it is what Forge was already measuring. On b10430,
Qwen3.8-27B, warm slot, 4.9K prompt: an append-only turn reported
`prompt=4966 cached=4945 evaluated=21`. That 99.6% reuse *was* checkpoint-backed
recurrent reuse. It was attributed to ordinary prefix caching at the time.

The conclusion of the prefix-stability plan survives this intact, and §8 below
prices it at production context. Checkpoints make an **append** cheap. They do
nothing when the prefix itself changed, because then there is no common prefix
to rewind to. Prefix stability is what creates the condition checkpoints
exploit; it is not made redundant by them.

What *is* new is that three llama.cpp knobs behind that mechanism are load-
bearing, and Forge sets none of them.

---

## 2. What Forge already has

Worth stating, because an outside review of the repo read this wrong and
concluded the prefix layer had not landed.

| Capability | State |
|---|---|
| Stale `read_file` supersession | shipped (`b94f8ff`) |
| `search_code` result bounding | shipped (`b94f8ff`) |
| Structured replacement context through compaction | shipped (`48d34d8`) |
| Server survives Stop / tab switch / model sharing | shipped (shared-runtime) |
| Volatile turn state off the prompt head | shipped 0.13.18 (`8a01579`) |
| Deterministic plan rendering (no clock in prompt) | shipped 0.13.18 |
| Cache-reuse telemetry per request | shipped 0.13.18 (`src/llm/promptCacheStats.ts`) |
| Checkpoint / slot-affinity flags | **not set — but reachable via `extra_llama_server_args`** |
| Slot pinning | **not possible from the extension — §5** |

---

## 3. The three unset flags

`src/backend/LlamaServerArgs.ts` pushes eleven flags. None of these is among
them, so every Forge server runs the llama.cpp defaults — though all three are
already reachable today through `extra_llama_server_args` (§6.0), which is
passed straight through at `LlamaServerArgs.ts:78`:

| Flag | Default | Why it matters here |
|---|---|---|
| `--ctx-checkpoints` | 32 | Max checkpoints per slot. The rewind targets. |
| `--checkpoint-min-step` | 8192 | Minimum spacing, in tokens, between them. |
| `--slot-prompt-similarity` | 0.10 | How well a prompt must match a slot to be routed to it. |

`--checkpoint-min-step 8192` is the interesting one. At Forge's working sizes —
5K to 50K prompts — 8192-token spacing yields between **zero and six**
checkpoints, and the cap of 32 is never approached. The rewind granularity is
therefore coarse at exactly the sizes Forge runs at: a divergence 3K tokens
into a 20K prompt rewinds to a checkpoint up to 8K earlier than it needed to.

**Measured in §8.2:** at a 31K prompt, dropping the spacing from 8192 to 1024
cut the first tail-change from 7272 evaluated tokens to 553 — 13.2x fewer, 8.2x
less prompt time. **It is free**: §8.4 measures resident VRAM across four
spacings and finds no difference beyond ±8 MiB of noise.

The cap of 32 is not the binding constraint and should not be raised blindly;
`--cache-ram` (default 8192 MiB) bounds the total.

`--slot-prompt-similarity` is a routing threshold, and its direction is **not
obvious a priori** — see §5. It is a measurement before it is a change.

---

## 4. What we are not doing

**`--cache-reuse`.** Still disabled by llama.cpp for both SWA (gemma) and
hybrid/recurrent (Qwen3.8) architectures, re-confirmed on b10621. It requires
`can_shift`. Every model Forge targets locally is one or the other. Shipping a
config knob that silently does nothing is worse than not shipping one.

**`/slots` save and restore.** An upstream report isolates a real bug: llama.cpp
persists the recurrent/KV state but *not* `slot.prompt.checkpoints`, so a
restored slot reports a perfect LCP match and then does a full prefill anyway.
An experimental patch serializes them to a `.ckpt` sidecar. None of this reaches
Forge: Forge never saves or restores slot state, does not pass
`--slot-save-path`, and its only `/slots` traffic is a read-only health GET at
`src/backend/adoptedServerMonitor.ts:27`. The shared-runtime work removed most
of the motive by keeping the server alive across Stop and tab switches. Revisit
only if Forge ever needs warm cache to survive a server restart.

**Forcing `can_shift = true` for GDN/MLA/SWA.** Requires llama.cpp cache
architecture work. Out of scope for an extension, and a fork is not warranted
when the checkpoint path already delivers the result.

---

## 5. Slot affinity — the honest version

The concern is real. `--parallel` defaults to **4**
(`src/backend/LlamaServerArgs.ts:55`), so a Forge server has four slots, and
the shared-runtime docs already acknowledge that two windows share them. The
feared pattern is thrash:

```
A -> slot 0    A -> slot 0
B -> slot 0    B -> slot 1
A -> slot 1    A -> slot 0     <- what we want
C -> slot 0
```

A conversation bounced to a different slot loses its checkpoints and pays a
full prefill.

**Forge cannot pin.** Dispatch goes through `/v1/chat/completions`
(`src/llm/OpenAIClient.ts`), and the OpenAI-compatible endpoint has no
`id_slot` parameter. Only llama.cpp's native `/completion` accepts one, and
routing Forge's local traffic through it would mean owning chat-template
application in-process — a large change, and one that would diverge from the
cloud providers that share `OpenAIClient`.

So the only lever is `--slot-prompt-similarity`, which is the server's own
routing heuristic: a request reuses a slot whose prompt matches above the
threshold, and otherwise takes the least-recently-used slot. Raising it makes
Forge *less* likely to land on a weakly-matching slot, but also more likely to
be sent to an LRU slot with nothing cached at all. Which effect dominates
depends on how many conversations are actually in flight — and with one active
window, thrash is hypothetical.

Two cheaper mitigations exist and should be priced first:

- **Lower `--parallel`.** Four slots divide `--ctx-size` four ways
  (`perSlotContext()`), so the default already costs per-conversation context.
  A single-window user gains both context and affinity from `--parallel 1`.
- **Do nothing.** If the measured multi-conversation thrash rate is low, the
  correct change is none.

---

## 6. Implementation

### Phase 0 — nothing to build: the escape hatch already works

`extra_llama_server_args` (model or `spawn`, resolved in `ConfigResolver.ts:305`)
appends arbitrary argv to llama-server. So a user with VRAM to spare can set

```yaml
    spawn:
      extra_llama_server_args:
        - "--checkpoint-min-step"
        - "1024"
```

without any change to Forge. Phase 2 is therefore about **discoverability and
validation**, not capability — which lowers its priority considerably. Anyone
who needs this before Phase 2 lands is not blocked.

**Done for this machine, 2026-08-28.** `.forge/config.yaml` now runs b10673,
sets `--checkpoint-min-step 1024` on `qwen38-27b-mtp-ud-q3kxl-no-vision`, and
drops the `llamacpp-qwen3` group `num_ctx` from 62000 to 50000 to pay for the
checkpoints. Measured as Run C in §8. The rationale is in the config comments,
where the rest of this machine's VRAM budget lives.

### Phase 1 — measure before configuring — **DONE**

Two controlled runs at a 31K prompt, `--checkpoint-min-step` 8192 vs 1024, all
other conditions identical. Results and VRAM cost in §8. The tail-change
benefit is real and large, so Phase 2 is justified — but the 2 GiB price means
it must be **opt-in per model**, not a new default.

### Phase 2 — expose the flags as first-class config

Only worth doing for the reasons Phase 0 does not cover: a typo in
`extra_llama_server_args` fails at llama-server startup rather than at config
validation, and an undocumented flag is a flag nobody finds.

Add optional `ctx_checkpoints` and `checkpoint_min_step` to the model/spawn
schema (`src/config/schemaShared.ts`, `src/config/schema.ts`,
`src/config/types.ts`), resolve them in `ConfigResolver.ts` alongside
`n_parallel`, and push them in `LlamaServerArgs.ts`. Omitted means omitted —
no default is injected, so an unconfigured Forge keeps llama.cpp's behaviour.

Per CLAUDE.md's no-fallbacks rule: no silent default, no hidden clamp.

The 2 GiB measured in §8.2 is preallocated at load, so on a VRAM-bound setup it
competes directly with `--ctx-size` and with fitting all layers on the GPU —
and §8.3 shows what running out looks like. The right default is llama.cpp's,
with the flag documented for users who have headroom to spend. A model config
that sets it should say so in a comment, since `config.yaml` comments are
load-bearing VRAM notes in this project.

### Phase 3 — slot-affinity measurement (independent of 1 and 2)

Two conversations alternating against one server, reading the `[cache]` debug
line already emitted by `ModelTurn`. Establishes whether thrash is real at
`--parallel 4` before any flag is proposed for it.

---

## 7. Acceptance criteria

- [x] Checkpoint spacing measured at 31K; the VRAM cost of finer spacing
      recorded alongside the latency benefit (§8.2), and re-measured on the
      production config (§8, Run C). Not yet measured at 20K, or on gemma/SWA
      (§9).
- [ ] Flags added only if the measurement shows a benefit, and omitted from the
      command line when unconfigured.
- [ ] Slot thrash under `--parallel 4` either demonstrated with numbers or
      documented as not reproduced.
- [ ] No change to `OpenAIClient` dispatch; no native `/completion` path.

---

## 8. GPU A/B at production context

Closes the open acceptance criterion in `PROMPT_PREFIX_STABILITY_PLAN.md` §6,
and prices §3.

Conditions: llama.cpp **b10621**, Qwen3.8-27B UD-Q3_K_XL, RTX 5060 Ti 16 GB,
all layers on GPU (`-ngl 999`), `--ctx-size 49152 --parallel 1 --batch-size 2048
--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0`, idle machine, prompt
**31.2K tokens**. Each row is one `/v1/chat/completions` request with
`max_tokens: 1`; `cached` is `usage.prompt_tokens_details.cached_tokens`,
`eval` is `timings.prompt_n`.

### Run A - llama.cpp defaults (`--checkpoint-min-step 8192`)

| # | request | prompt | cached | eval | prompt_ms |
|---|---|---|---|---|---|
| 1 | cold | 31182 | 0 (0.0%) | 31182 | 40397 |
| 2 | append-only turn | 31199 | 31178 (99.9%) | 21 | 516 |
| 3 | repeat of 2 (warm) | 31199 | 31195 (100%) | 4 | 258 |
| 4 | **HEAD mutated** (old shape) | 31207 | **0 (0.0%)** | **31207** | **40760** |
| 5 | re-warm after head change | 31199 | 31195 (100%) | 4 | 230 |
| 6 | **TAIL mutated** (new shape) | 31219 | 23947 (76.7%) | 7272 | 10955 |
| 7 | TAIL mutated again | 31219 | 31187 (99.9%) | **32** | **400** |

### Run B - identical, with `--checkpoint-min-step 1024`

| # | request | prompt | cached | eval | prompt_ms |
|---|---|---|---|---|---|
| 1 | cold | 31182 | 0 (0.0%) | 31182 | 40211 |
| 2 | append-only turn | 31199 | 31178 (99.9%) | 21 | 512 |
| 3 | repeat of 2 (warm) | 31199 | 31195 (100%) | 4 | 247 |
| 4 | HEAD mutated (old shape) | 31207 | 0 (0.0%) | 31207 | 40831 |
| 5 | re-warm after head change | 31199 | 31195 (100%) | 4 | 225 |
| 6 | **TAIL mutated** (new shape) | 31219 | **30666 (98.2%)** | **553** | **1331** |
| 7 | TAIL mutated again | 31219 | 31187 (99.9%) | 32 | 407 |

### 8.1 The prefix-stability result

Rows 4 and 7 are the A/B. Same conversation, same volatile state
(`Active file: /repo/b.ts`), differing only in **where** it is rendered:

| | eval tokens | prompt_ms |
|---|---|---|
| Old shape - into the system prompt | 31207 | 40760 |
| New shape - into the latest user message | 32 | 400 |
| **Ratio** | **975x** | **102x** |

A head change at 31K context costs a **full 41-second prefill** and reports
`cached_tokens: 0`. At the 4.9K prompt measured for the original plan the same
change cost 7.6 s and a 12x ratio; the penalty scales with conversation length,
so the production figure is 8x worse than the number the plan shipped on.
Criterion 6.7 of `PROMPT_PREFIX_STABILITY_PLAN.md` is met.

Row 5 is worth noting on its own: after the head change evicted the good
prefix, the *original* prompt still returned to 100% reuse in 230 ms. The old
shape therefore did not merely cost one slow turn — alternating between two
active files would have paid 41 s **every time the file changed**, indefinitely.

### 8.2 The checkpoint-granularity result (new)

Row 6 is the first tail-change after a warm append, and it is where the two
runs separate:

| `--checkpoint-min-step` | cached | eval | prompt_ms |
|---|---|---|---|
| 8192 (default) | 23947 (76.7%) | 7272 | 10955 |
| 1024 | 30666 (98.2%) | 553 | 1331 |

**13.2x fewer tokens, 8.2x less prompt time**, from one flag. Every other row
is unchanged within noise, which is what makes the attribution safe.

This is the §3 prediction confirmed. Divergence in row 6 begins at roughly
token 31187, but the default run could only rewind to a checkpoint at 23947 —
7240 tokens earlier, consistent with 8192-token spacing. Recurrent state cannot
be rewound to an arbitrary point, only to a checkpoint, so **checkpoint spacing
is the effective granularity of prefix reuse** on these architectures. At
Forge's working sizes the default spacing is coarser than the prompt edits
Forge makes.

Row 7 costs 32 tokens in *both* runs because row 6's own evaluation laid down a
checkpoint near the divergence point. So the penalty is paid on the first edit
at a new location, not on repeats - which maps onto exactly the case Forge hits
when the user switches files or the plan updates.

**Cost.** None. An earlier revision of this document reported ~2.02 GiB here,
from comparing 12375 MiB against 14441 MiB. The 12375 reading was invalid —
see §8.4, which retracts it and measures the real figure.

### Run C - production config on b10673

`--checkpoint-min-step 1024` on the build and settings Forge actually spawns:
llama.cpp **b10673**, `--ctx-size 50000 --parallel 1 --cache-type-k q4_0
--cache-type-v q4_0 --ubatch-size 1024 --flash-attn on` plus the MTP
speculative-decoding flags the `qwen38-27b-mtp-ud-q3kxl-no-vision` entry
carries.

| # | request | prompt | cached | eval | prompt_ms |
|---|---|---|---|---|---|
| 1 | cold | 31182 | 0 (0.0%) | 31182 | 43799 |
| 2 | append-only turn | 31199 | 31178 (99.9%) | 21 | 868 |
| 3 | repeat of 2 (warm) | 31199 | 31195 (100%) | 4 | 402 |
| 4 | HEAD mutated (old shape) | 31207 | 0 (0.0%) | 31207 | 42995 |
| 5 | re-warm after head change | 31199 | 31195 (100%) | 4 | 400 |
| 6 | **TAIL mutated** (new shape) | 31219 | **31187 (99.9%)** | **32** | **632** |
| 7 | TAIL mutated again | 31219 | 31187 (99.9%) | 32 | 640 |

Row 6 — the first edit at a new position, the case that costs the most — across
all three runs:

| run | build / spacing | eval | prompt_ms |
|---|---|---|---|
| A | b10621, 8192 (default) | 7272 | 10955 |
| B | b10621, 1024 | 553 | 1331 |
| C | b10673, 1024, q4_0 KV, ubatch 1024 | **32** | **632** |

Run C reaches the floor: the first tail edit now costs the same 32 tokens as a
repeat. The residual 553 in run B is gone, most likely because `--ubatch-size
1024` aligns checkpoint placement with a smaller evaluation granule — that
attribution is an inference from the one variable that plausibly moves it, not
a controlled result, since C changed build, KV quant, ubatch and context at
once.

Cold and head-change prefill are ~7% slower in C (43.8 s vs 40.4 s), consistent
with q4_0 KV and 1241 MiB free rather than 3.9 GB. Row 4 is unchanged in kind:
a head change still reports `cached_tokens: 0` and pays the full prefill on
every build and every setting tried. Nothing at the server level fixes that —
only not moving the head does.

**VRAM.** 15070 MiB of 16311 at load, 1241 MiB free — above the ~1 GB floor
below which WDDM starts paging (§8.3). Essentially all of that is the model, the
KV cache and the MTP draft context; the checkpoint flag contributes nothing
(§8.4). The margin is set by `num_ctx`, not by anything in this plan.

### 8.4 Retraction: the checkpoint flags are free

A revision of this document reported that `--checkpoint-min-step 1024` cost
~2.02 GiB of preallocated VRAM, and that `num_ctx` had to be cut to pay for it.
**That was a measurement error. The flags cost nothing.**

Resident VRAM at load, production config, `--ctx-size 50000`, one variable:

| flags | VRAM | free |
|---|---|---|
| none | 15073 MiB | 1238 |
| `--ctx-checkpoints 32` | 15065 MiB | 1246 |
| `--checkpoint-min-step 1024 --ctx-checkpoints 32` | 15065 MiB | 1246 |
| `--checkpoint-min-step 1024 --ctx-checkpoints 64` | 15066 MiB | 1245 |

And across spacings, flag alone:

| `--checkpoint-min-step` | none | 8192 | 4096 | 2048 | 1024 |
|---|---|---|---|---|---|
| VRAM (MiB) | 15064 | 15066 | 15065 | 15065 | 15065 |

Flat within ±8 MiB. Doubling `--ctx-checkpoints` to 64 changes nothing either,
so the buffers are not preallocated per checkpoint at load.

**Root cause.** The 12375 MiB baseline in the original §8.2 was read while the
model was still loading. The wait loop used `curl -s -m 2 /health` and treated
*any* HTTP response as ready — but llama-server answers `/health` with **503
while loading**, so the loop returned almost immediately. Re-running run A's
exact argv, with no checkpoint flags at all, and both checks side by side:

```
loose check  (what run A used):  UP at  1s   vram=768 MiB
strict check (HTTP 200):         UP at 10s   vram=14614 MiB
settled:                                     vram=14603 MiB
```

The true flagless baseline is **14603 MiB**, not 12375. Run B *with* the flags
read 14441 — slightly lower, i.e. the difference is run-to-run variation and the
flags are free. The same loose check had already produced a false "UP" that made
a probe fail with 503 earlier in the session; it was fixed for run B but nobody
went back to invalidate run A's VRAM number.

**Lesson for anything measured here:** a VRAM figure is only meaningful after
`/health` returns **200**, and llama.cpp's 503-while-loading makes a
response-based check silently sample a partially-loaded model.

**What this changes.** `--checkpoint-min-step 1024` is a free ~13x reduction in
first-edit prefill on these architectures, not a trade. There is no reason not
to set it on every hybrid/recurrent entry. `num_ctx` on this machine remains 50000
by explicit request, not to fund the flag.

### 8.3 Method note

The first attempt ran at `--ctx-size 57344` with f16 KV, leaving 440 MiB free,
and prefill collapsed to **10.45 tok/s** under WDDM paging. Those numbers were
discarded, not reported. Any measurement on this card needs >=1 GB free VRAM
before it means anything.

---

## 9. Open questions

- Does `--checkpoint-min-step` interact with `--flash-attn on`? Forge always
  sets flash attention explicitly (`LlamaServerArgs.ts:64`).
- Does the checkpoint mechanism apply to gemma's SWA cache the same way it does
  to Qwen's GDN state? The flag is spelled `--ctx-checkpoints,
  --swa-checkpoints`, which suggests one mechanism serving both, but that is an
  inference from the alias, not a measurement.
