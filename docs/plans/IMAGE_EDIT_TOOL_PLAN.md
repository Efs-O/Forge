# Image editing in `generate_image` — reference images, variations, and the speed fixes

Status: **draft, awaiting user review** (2026-10-05). No code written yet.
Implementer: Forge (primary agent). Reviewer: Claude, via `ask_live_session`.
Supersedes nothing; extends `LOCAL_IMAGE_GENERATION_PLAN.md` (shipped 0.16.71).

## Plain-English summary

Today Forge's image tool can only draw from text. You cannot hand it a picture
and say "make this a 3D render" or "put my character in these poses". That
capability exists in the engine and we proved it works by hand — every sketch
render and pose grid in this session was done by running the tool's binary
directly, outside Forge. This plan moves that ability inside the tool so you
just ask.

It also fixes three things we measured the hard way:

1. **Forge starts the image server in the slower mode.** Forge passes
   `--auto-fit off`. The faster setting, `--auto-fit on --max-vram 9`, measured
   **410s vs 549s** for the same picture — 25% faster, free.
2. **Big input pictures cause the disaster runs.** One reference shrunk to
   768px: **3 minutes**. Two references left big: **11 minutes**. Two at full
   size: **20 minutes**. Same prompt, same step count. The cause is that the
   engine runs out of graphics-card room for its cache and re-fetches the model
   from disk on every step (3.6s/step became 21.9s/step). This plan shrinks
   input pictures automatically so the 20-minute case cannot happen by accident.
3. **"Make me two variations" needs a count argument.** Same prompt, different
   seeds. Today the tool can only make one image per call.

## What we are NOT changing

- The model quants stay: DiT `Q4_K`, text encoder `Q4_K_M`, VAE `bf16`.
  Benchmarked in `V:/models/Qwen-Image-2.1/bench/results.csv`: Q4_K / Q5_0 /
  Q8_0 were a dead heat on speed (144–150s) and Q4_K won on VRAM (5.4 GB vs
  8.6 GB). That headroom is what editing needs. Not a knob in this plan.
- The vision tower (`mmproj`) stays **F16**. It runs in system RAM, not VRAM
  (log: `Conditioner params 5894 MiB -> compute CPU`), with 63 GB RAM free, so
  quantising it buys nothing on the card and risks reading a reference less
  accurately. Rejected after measurement, not assumed.
- No new GPU work. Full residency on the 3060 is impossible: weights alone are
  10,055 MB and runtime buffers need ~2,500 MB more, over a 12,288 MB card.
  Four attempts confirmed this (`qwen-image-edit-gpu-fit-measured`).

## Open question that must be settled before coding

**Which HTTP endpoint accepts reference images on the endpoint we already use.**

`LOCAL_IMAGE_GENERATION_PLAN.md` chose `POST /sdapi/v1/txt2img` because it
honours `seed`, `width`/`height`, `steps` and `cfg_scale` (the OpenAI-shaped
endpoint ignored the seed and forced cfg 7). Upstream `examples/server/api.md`
documents the image fields — `init_image`, `ref_images[]`, `mask_image` — under
a "Field Mapping Summary" whose endpoint scope the fetched text did not make
explicit, and separately documents `POST /sdcpp/v1/img_gen` as **async**
(`202 Accepted` + `poll_url`).

So Phase 0 must answer this by measurement, not by reading. Two candidate
answers, with very different implementation cost:

| If… | Then |
|---|---|
| `/sdapi/v1/txt2img` accepts `ref_images` | Add one field to the existing request body. Smallest possible change. |
| Only `/sdcpp/v1/img_gen` does | Add a job-poll loop: submit → `202` → poll `/sdcpp/v1/jobs/{id}` → fetch result. New state, new failure modes (see ledger). |

`/sdcpp/v1/capabilities` returns `features_by_mode.img_gen`, which lists
`ref_images` — that tells us the server supports the field, not which endpoint
accepts it. Probe both.

## State × lifecycle ledger

Durable state this feature writes or depends on, and every lifecycle column.

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| `vision_encoder` path in `image_generation.backends[].vision_encoder` (`config.yaml`) | User edits YAML. Code never writes config (FORGE.md fact). | User removes the key → editing refuses with a named reason, text-to-image keeps working. | Absent key = feature off. No new UI. | N/A — file is user-owned, atomic by convention. | N/A | N/A |
| `sd-server` **owner record** `%LOCALAPPDATA%\Forge\sdcpp\<name>.json` | Already owned by `sdServerOwnerRecord.ts`. `signature` must now hash `vision_encoder`, `auto_fit`, `max_vram_gib` too, or two windows with different edit configs adopt each other's server and one silently gets no vision tower. | Existing: owner stops server, deletes record. | Disabling the backend leaves the record; `start()` re-reconciles. | Existing temp-file + rename. Unchanged. | Existing orphan reap by pid + creation time + `ExecutablePath` match. Unchanged. | Existing `lastUsedAt + idle_timeout_ms`. |
| **Signature change forces a restart** | New fields change the signature. | An already-running server from the old signature must not be adopted — `reconcileSdServerRecord` refuses on signature mismatch (behaviour already shipped: "server stopped 12 s after a `request_timeout_ms` edit"). | — | — | — | — |
| Downscaled reference bytes | **In memory only.** Never written to disk. No temp file = no temp cleanup bug. | N/A | N/A | N/A | N/A | Freed with the request. |
| Base64 request body (up to N MB per image) | In memory. | N/A | N/A | N/A | N/A | Freed with the request. |
| Saved output PNG(s) | Existing `targetPath()` + `fs.writeFile`. | User deletes. | N/A | Partial write: `writeFile` is not atomic. Existing behaviour; **not** worsened. Add a size re-read assertion. | Existing: file already on disk, nothing to reap. | N/A |
| **Async job id** (only if Phase 0 picks `/sdcpp/v1/img_gen`) | Server-issued. Forge stores it for the request's lifetime only. | Forge never cancels (server reports `cancel_generating: false`). | Turn abort → existing `stopAfterAbort()` rule: kill owned server only if `record.lastUsedAt` older than `request_timeout_ms`. | Job continues server-side. On restart Forge does not resume it; the render finishes and is discarded. **Record as a documented limitation with a test, per FORGE.md.** | Same: server dies with the owner, job dies with it. | Job outlives nothing; the request deadline is the only bound. |
| `count` (variations) | Argument, not state. | N/A | Cap at 2. Measured: two images share the expensive conditioning pass (~4.5 min vs ~6 min for two calls), but raise VRAM — the exact pressure that dropped the prefix cache. Cap must be enforced, not advisory. | N/A | N/A | N/A |

**No cell is empty.** The two async-job rows are only live if Phase 0 chooses
`/sdcpp/v1/img_gen`; if it chooses `txt2img`, those rows are marked "not
applicable — no async job exists" in the final plan revision, not deleted.

## Phase 0 — Measure before writing any Forge code

Run against `V:/Tools/sd.cpp-master-929/sd-server.exe` on port 8094, one job at
a time on the 3060 (FORGE.md: never two GPU jobs on one card).

| # | Probe | Settles |
|---|---|---|
| 0.1 | `POST /sdapi/v1/txt2img` with `ref_images: [<b64>]` | Whether `ref_images` is accepted on the endpoint we already use. **Gates the whole shape of the plan.** |
| 0.2 | `GET /sdcpp/v1/capabilities` → dump `features_by_mode.img_gen` | Confirms `ref_images` is advertised; does not prove the endpoint. |
| 0.3 | If 0.1 fails: `POST /sdcpp/v1/img_gen` + poll `/sdcpp/v1/jobs/{id}` | The async path's real request/response shape and job lifecycle. |
| 0.4 | `--auto-fit on --max-vram 10` and `--max-vram 11` on the 2-reference case that dropped the cache | The failed run was **167 MB short** (`need 874 MB, available 707 MB`). `--max-vram 9` is Forge's own cap, not the card's limit — the card had 11,253 MiB free. Does raising it restore the prefix cache and return sampling to ~3.6s/it? |
| 0.5 | Warm-server **edit** timings at 640², 768×1152, 1024² | We have never measured a warm edit. 26–33s was warm *txt2img at 512²*. Every output-size promise in this plan is an estimate until this runs. |
| 0.6 | `batch_count: 2` / `batch_size: 2` with one reference | Does one request really share the conditioning pass, and does it fit in VRAM? |

**Phase 0 output:** timings appended to the table below, and this plan revised
so its file list and acceptance criteria match what 0.1 actually showed. Per
FORGE.md, do not call the plan implemented while it disagrees with the code.

### Measurements on the record (2026-10-05, RTX 3060, Q4_K, `--auto-fit on --max-vram 9`, `--fa`, te on CPU)

| Run | References | Output | Steps | Total | Conditioning | Sampling |
|---|---|---|---|---|---|---|
| warm txt2img req 1 | none | 512×512 | 20 | 33.1s | lazy load paid | — |
| warm txt2img req 2/3 | none | 512×512 | 20 | **26.5 / 26.7s** | 0.00s (cache hit) | — |
| `sketch_render_v1` | 1, explicit backends, `auto-fit off` | 768×1280 | 28 | 549s | — | — |
| `sketch_render_v2_gpufit` | 1, **`auto-fit on --max-vram 9`** | 768×1280 | 28 | **410s** | — | — |
| `sketch_render_v7_vaeTile` | 1 + VAE tiling | 768×1280 | 28 | 518s | — | — |
| `pose_user_prompt_v2` | 1 @768px | 768×768 | 20 | **188s** | 102s | 81s @3.6s/it, cache FITS |
| `pose_v3` | 2 (430×768 + 896×877) | 896×896 | 20 | 652s | 225s | ~21.9s/it, **cache DROPPED** |
| `pose_grid_v1` | 2, full res | 1024×1024 | 20 | 19m40s | — | weights re-streamed per step |

**Unexplained, and deliberately not papered over:** the 410s run reported
sampling at ~11s / 4.2 it/s for a 768×1280 image, while the 188s run sampled a
*smaller* 768×768 in 81s at 3.6 s/it. A larger image sampling faster is
backwards, and ~380s of the 410s is unaccounted for in the logs examined. Phase
0.5 must reproduce it before the plan promises any timing.

## Phase 1 — Make the server start in the fast mode

`src/backend/sdServerArgs.ts` (46 lines) currently hardcodes `--auto-fit off`,
inherited from the 0.16.71 plan's reasoning that auto-fit might spill onto the
5060 Tis. That reasoning is already handled: the spawn sets
`CUDA_VISIBLE_DEVICES=<cuda_device>`, so the process cannot see the other cards.
Auto-fit can only place things on the 3060 or in RAM.

- Add `auto_fit: boolean` (default `true`) and `max_vram_gib: number` (default
  `9`) to `SdcppImageBackendSchema` (`src/config/imageGenerationSchema.ts`,
  119 lines) and to `src/config/mediaTypes.ts` (115 lines).
- `composeSdServerArgs` emits `--auto-fit on|off` and `--max-vram <n>`.
- Both fields join `sdServerSignature`, so a config change forces a restart
  rather than silently adopting a server started with the old budget.
- Update `config/config.example.yaml` and `.forge/config.yaml` in the same
  change.
- Tests: `test/unit/SdServerBackend.test.ts` and `test/unit/SdcppImageBackend.test.ts`
  arg assertions.

**Expected:** 549s → 410s class improvement on cold runs, no code path risk.

## Phase 2 — Reference images in the tool

### Config

`vision_encoder: z.string().min(1).optional()` on the sdcpp schema. Optional
deliberately: text-to-image works without it, and an existing config keeps
working. When it is set, `composeSdServerArgs` adds `--llm_vision <path>`, and
`SdServerBackend.verifyConfiguredPaths()` checks the file exists — that method
currently lists exactly four entries (`binary`, `diffusion_model`,
`text_encoder`, `vae`) and must gain a fifth, or a typo'd vision path fails at
render time instead of at start.

### Tool arguments (`src/tools/imageGeneration/generateImageTool.ts`, 353 lines)

```
reference_paths: string[]   // workspace-relative or absolute image paths, 1..4
count: integer              // 1..2, default 1
```

`prompt` stays required — an edit still needs instructions.

**`prompt` must stop being required only if Phase 0 shows the engine can edit
from references alone. It cannot today, and this plan does not change that.**

**Line budget:** this file is 353 lines against a hard 500-line ESLint stop.
Adding argument parsing, path loading, and the count loop here will push it.
Split first: move the reference-path loading into the new module below, and move
`targetPath` / `displayPath` / `describeWithBackends` into a sibling
`generateImageToolFormat.ts` if the file crosses ~450. Check with
`npx eslint <file>`, not by eyeballing.

### New module: `src/tools/imageGeneration/sdcppReferenceInput.ts`

Owns the one job the plan's speed rule depends on: **shrink before sending.**

- Load each path, reject non-images and anything over a byte cap.
- Downscale so the long edge is ≤ `max_reference_edge_px` (default **768**).
  This is the measured fix: 19m40s → 3min class.
- **Must be divisible by 32** after scaling — sd.cpp requires it, and we hit
  that limit directly this session.
- Emit base64 in the shape Phase 0 proved.
- Report what it did in the tool result: "reference downscaled from 1280×1253
  to 768×751". Silent resizing is how a user ends up confused about why detail
  is missing.

Why a module and not a function in `sdcppImageBackend.ts` (276 lines): the
resize rule is the highest-value, most-likely-to-regress logic in the plan, and
it needs its own tests without a server, a GPU, or a port.

### Request (`src/tools/imageGeneration/sdcppImageBackend.ts`)

Add `ref_images` (or the Phase 0 shape) to the body. If Phase 0 forces
`/sdcpp/v1/img_gen`, the submit→poll→fetch loop goes in a new
`sdcppJobPoll.ts`, not in this file, to keep it under 500 lines.

### Refusal, in the tool's existing voice

When `reference_paths` is given but `vision_encoder` is unset:

> `qwen-image-local: reference images need image_generation.backends.qwen-image-local.vision_encoder. Point it at the mmproj (mmproj-Qwen3VL-8B-Instruct-F16.gguf), or use backend grok-imagine.`

FORGE.md rule: refusals name the alternative.

## Phase 3 — Variations

`count: 2` sends one request with two seeds, or two requests if Phase 0.6 shows
batching does not fit in VRAM. Each image is saved and delivered separately, so
the phone gets two photos, not one contact sheet.

Seed handling: `generateSdcppImage` already takes an injectable `seed()` and
returns the seed used. For `count: 2` generate distinct seeds and report both,
so a good one can be re-run exactly.

## Phase 4 — Output size as a real argument

Today `size` is a three-value enum (1328², 928×1664, 1664×928) — Qwen's native
training resolutions. Those are the *best quality* sizes and the *slowest* ones:
1328² is 1.76 MP, roughly 3× the pixels of 768×1152.

Measured/estimated ladder for one edit at 20 steps:

| Output | Pixels | Time | Source |
|---|---|---|---|
| 512×512 | 0.26 MP | ~30s | measured (txt2img, warm) |
| 768×768 | 0.59 MP | 188s | **measured (edit)** |
| 768×1152 | 0.88 MP | ~4 min | **estimate — Phase 0.5 must measure** |
| 1024×1024 | 1.05 MP | ~5–6 min | estimate |
| 1328×1328 | 1.76 MP | ~4 min 43 s cold | measured, 0.16.71 smoke |

The 1328² row is *measured and faster than the 1024² estimate*, which is
another reason Phase 0.5 is mandatory: the estimates above are not trustworthy
next to a real number.

Proposed: keep the three named sizes, and allow explicit `width`/`height` for
`sdcpp` only, both multiples of 32, with a pixel-count ceiling set from Phase
0.5 rather than invented. Default for edits: **768×1152** (a standing figure
does not need the empty space a square adds).

The ceiling is a VRAM and time guard only. It is not a statement about what may
appear in an image: multi-subject and multi-pose outputs are ordinary requests,
and the ceiling is deliberately set from Phase 0.5 measurements so it sits above
the sizes such a request needs, not below them.

## Acceptance criteria

Each row maps to a test or a named validation step. No row may be marked done
without its named check.

| # | Invariant | Validation |
|---|---|---|
| A1 | An existing config with no `vision_encoder` still renders text-to-image, unchanged. | `test/unit/SdcppImageBackend.test.ts` — existing cases pass untouched. |
| A2 | `reference_paths` with no `vision_encoder` configured refuses, and the message names the mmproj and an alternative backend. | New unit test, string assertion. |
| A3 | `--llm_vision` appears in the spawn args exactly when `vision_encoder` is set. | `test/unit/SdServerBackend.test.ts` args assertion. |
| A4 | A bad `vision_encoder` path fails at **start**, not at render. | `verifyConfiguredPaths` test with a missing fifth entry. |
| A5 | Changing `auto_fit`, `max_vram_gib`, or `vision_encoder` changes `sdServerSignature`. | Unit test: two configs → two signatures. |
| A6 | A running server with a stale signature is **not** adopted. | Existing `reconcileSdServerRecord` refusal test, extended to the new fields. |
| A7 | A 1280×1253 reference is downscaled to long edge ≤768 **and** both dimensions divisible by 32. | `sdcppReferenceInput` unit test with exact expected dimensions. |
| A8 | The tool result states the downscale it performed. | Unit test on the result string. |
| A9 | Reference count over 4 refuses with a named reason. | Unit test. |
| A10 | `count` over 2 refuses; `count: 2` produces two saved files and two distinct reported seeds. | Unit test on `targetPath` collision + seed reporting. |
| A11 | Two variations never overwrite each other. | `targetPath` test: same prompt, same second, different index. |
| A12 | Turn abort mid-edit behaves exactly as mid-txt2img (owned server killed only under the `lastUsedAt` rule). | Extend `test/unit/SdServerAbort.test.ts`. |
| A13 | A reference path outside the workspace is refused. | Unit test; matches existing path-sandbox rules. |
| A14 | A non-image or over-cap reference is refused before any GPU work. | Unit test; assert no server call was made. |
| A15 | If Phase 0 chose the async endpoint: a job whose poll is interrupted by a turn abort is reported, not silently resumed. | New test; **only if applicable**, else mark "not applicable — no async job". |
| A16 | A request over the measured pixel ceiling refuses with a named reason, and the ceiling sits high enough that a multi-subject output at a usable per-subject size is still allowed. | Unit test on the ceiling from Phase 0.5, plus one case just under it that must pass. |
| A17 | `npm run ci` green: type-check, vitest, ESLint including the 500-line `max-lines` gate on every touched file. | `npm run ci`, exact result reported. |
| A18 | `git diff --check` clean; `git status` reviewed including untracked files. | Named step. |
| A19 | Version bumped in `package.json` **and** `CHANGES.md` updated in the same change. | FORGE.md rule; named step. |
| A20 | Live smoke: one sketch → 3D render from the phone, delivered to the remote chat, timing logged. | Manual, on the 3060, one job at a time. |
| A21 | Warm-server edit timing recorded and compared to the 188s cold baseline. The plan's size table is corrected if they disagree. | Phase 0.5 + A20 logs. |

## Known limitations at draft time

1. **Which endpoint takes `ref_images` is unknown.** Everything after Phase 0
   is conditional on it.
2. **Every output-size estimate is unverified.** Two measured numbers in that
   table contradict each other (1328² measured faster than 1024² estimated).
3. **The 410s run's time budget does not close.** ~380s unaccounted. Do not
   promise "25% faster" until Phase 0.5 explains it.
4. **`view_image` returned a bare `⟨image⟩` token** for several images this
   session — the chat model's own vision path appears degraded after
   `strata-vision.exe` was killed and respawned. Unrelated to this plan, but it
   means I could not visually verify the pose results, only probe them
   programmatically. Flagged so the smoke test (A20) is judged by the user.
5. **Edit outputs stay anchored to the reference.** Two seeds of an edit vary
   far less than two seeds of txt2img. Not a bug; users expecting big variation
   should change the prompt.
