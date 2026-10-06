# Image editing in `generate_image` — reference images, variations, and the speed fixes

Status: **revised after review, ready for Phase 0** (2026-10-06). No code
written yet. The Claude audit of 2026-10-06 found 2 blockers and 9
fix-before-code items; every one is addressed below and cross-referenced as
"review item N". Findings:
`docs/reports/IMAGE_EDIT_TOOL_PLAN_REVIEW_2026-10-06.md`.
Implementer: Forge (primary agent). Reviewer: Claude, via `ask_live_session` —
a second review of the **implementation** is required before any commit.
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

**ANSWERED 2026-10-06 by probe 0.1: the first row is FALSE.** `txt2img` accepts
the field syntactically and discards it — byte-identical output with and without
a reference. See "Phase 0 RESULTS" below. The async branch is the live candidate
**unless** probe 0.3 finds that `/sdapi/v1/img2img` + `init_image` conditions
properly, which would be a middle path between the two rows above: a sync
request with one new field, and no job-poll loop at all.

`/sdcpp/v1/capabilities` returns `features_by_mode.img_gen`, which lists
`ref_images` — that tells us the server supports the field, not which endpoint
accepts it. Probe both.

**A third shape is now on the table** (`sd-server --help`, 2026-10-06): the CLI
carries `-r, --ref-image` ("can be used multiple times") and `--mask`. That flag
is documented for *Flux Kontext or MiniMax-H3 Ref2VA*, so it is not proof that
Qwen-Image-2.1 edits through it — but it means the engine's reference handling is
broader than one JSON field, and probe 0.7 should check whether those CLI names
appear in the HTTP body too. Do not assume the CLI flag applies to this model.

## State × lifecycle ledger

Durable state this feature writes or depends on, and every lifecycle column.

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| `vision_encoder` path in `image_generation.backends[].vision_encoder` (`config.yaml`) | User edits YAML. Code never writes config (FORGE.md fact). | User removes the key → editing refuses with a named reason, text-to-image keeps working. | Absent key = feature off. No new UI. | N/A — file is user-owned, atomic by convention. | N/A | N/A |
| `sd-server` **owner record** `%LOCALAPPDATA%\Forge\sdcpp\<name>.json` | Already owned by `sdServerOwnerRecord.ts`. **No signature edit is needed:** `sdServerSignature` (`sdServerArgs.ts:35-45`) already hashes `args: composeSdServerArgs(config)`, so `--auto-fit`, `--max-vram` and `--llm_vision` join the signature automatically. Verified against the code 2026-10-06. | Existing: owner stops server, deletes record. | Disabling the backend leaves the record; `start()` re-reconciles. | Existing temp-file + rename. Unchanged. | Existing orphan reap by pid + creation time + `ExecutablePath` match. **The orphan path never compares the signature** (`sdServerReconciliation.ts:60-79`): it refuses if the server was used within `idle_timeout_ms`, otherwise it kills and respawns. So no stale-signature server is ever adopted, but this is not a signature check. | Existing `lastUsedAt + idle_timeout_ms`. |
| **Config change: three different outcomes, not one** | New fields change the spawn args, hence the signature. | **(a) Same window, config edited:** the registry disposes the old server — `sameConfig` compares the WHOLE config as JSON (`sdServerRegistry.ts:99-107`). This, not `reconcileSdServerRecord`, is the mechanism behind "server stopped 12 s after a `request_timeout_ms` edit". **(b) Another window alive, signature differs:** `sdServerReconciliation.ts:80-85` **throws a refusal**; it does not restart. The text names only the model, so when both windows share a model and differ only in `vision_encoder`/`auto_fit` it points at the wrong cause — **must be reworded** to say the server *configuration* differs. **(c) Owner dead:** see the row above. | — | — | — | — |
| Downscaled reference bytes | **In memory only.** Never written to disk. No temp file = no temp cleanup bug. **Exception:** if the decoder is the ffmpeg spawn (option 1), the resized bytes travel through that child process's stdout pipe — no file, but the spawn itself needs its own timeout and exit-code handling, and a failed spawn must refuse before GPU work. | N/A | N/A | N/A | N/A | Freed with the request. |
| Base64 request body (up to N MB per image) | In memory. | N/A | N/A | N/A | N/A | Freed with the request. |
| Saved output PNG(s) | Existing `targetPath()` + `fs.writeFile`. | User deletes. | N/A | Partial write: `writeFile` is not atomic. Existing behaviour; **not** worsened. Add a size re-read assertion. | Existing: file already on disk, nothing to reap. | N/A |
| **Async job id** (only if Phase 0 picks `/sdcpp/v1/img_gen`) | Server-issued. Forge stores it for the request's lifetime only. | Forge cannot cancel it — the server reports `cancel_generating: false`. **But this does not mean Forge never cancels:** the shipped abort path stops the owned server (`SdServerBackend` stop at :216-217). Under polling, aborting the poll leaves a job **still running on the GPU**; if the server is not stopped, the next request queues behind an orphan render the user believes was cancelled. Resolve explicitly — the honest answer may be "abort stops the owned server, exactly as today", which keeps A12's invariant true. | Turn abort → existing `stopAfterAbort()` rule: kill owned server only if `record.lastUsedAt` older than `request_timeout_ms`. **Open cells to settle, not assume:** (a) does the poll loop touch `lastUsedAt`? If not, the idle timer can stop the server mid-render; if yes, abort will never kill it. (b) Does `request_timeout_ms` bound submit-to-result, or each poll? Today it bounds one fetch. | Job continues server-side. On restart Forge does not resume it; the render finishes and is discarded. **Record as a documented limitation with a test, per FORGE.md.** | Same: server dies with the owner, job dies with it. | Job outlives nothing; the request deadline is the only bound. |
| `count` (variations) | Argument, but it **writes two durable files**, so it is not "not state". **Cap at 2, enforced not advisory.** **Probe 0.6 falsified the batching rationale:** `batch_size: 2` took 130.4 s for 2 images = 2 × the single-render time, so there is **no shared conditioning pass**; `batch_count: 2` was silently ignored (1 image, 65.2 s). `count: 2` costs the same as two separate requests — batching buys a round-trip, not time, and the VRAM-pressure argument for the cap no longer holds. The cap stays as a wall-clock/cost guard (2 × 65–136 s is already minutes). Naming rule for both branches: default name gets an index (`name-1.png`, `name-2.png`); an explicit `path` gets `name-1`/`name-2` too, because `targetPath` (`generateImageTool.ts:293-305`) returns `requested` unchanged whenever `path` is given, so `count: 2` would **overwrite the first variation**. State whether an existing file at `path` is overwritten today — if it is, say so rather than inheriting it silently. | User deletes both. | N/A | **Partial output:** with abort or timeout between image 1 and image 2, image 1 is on disk and image 2 is not. The result must name the one saved file and state the second was not produced, and say whether image 1 is still delivered to the remote chat. | Same as the single-image row. | N/A. `request_timeout_ms` must be declared **per call or per image** — today it bounds one fetch (`sdcppImageBackend.ts:116`). |

**No cell is empty.** The two async-job rows are only live if Phase 0 chooses
`/sdcpp/v1/img_gen`; if it chooses `txt2img`, those rows are marked "not
applicable — no async job exists" in the final plan revision, not deleted.

## Phase 0 — Measure before writing any Forge code

Run against `V:/Tools/sd.cpp-master-929/sd-server.exe` on port 8094, one job at
a time on the 3060 (FORGE.md: never two GPU jobs on one card).

| # | Probe | Settles |
|---|---|---|
| 0.1 | `POST /sdapi/v1/txt2img` with `ref_images: [<b64>]`, judged by **output dependence**, not by HTTP status | Whether `ref_images` is honoured on the endpoint we already use. **Gates the whole shape of the plan.** A 200 with an image in `images[0]` is NOT acceptance — see the pass rule below. |
| 0.2 | `GET /sdcpp/v1/capabilities` → dump `features_by_mode.img_gen` | Confirms `ref_images` is advertised; does not prove the endpoint. |
| 0.3 | If 0.1 fails: `POST /sdcpp/v1/img_gen` + poll `/sdcpp/v1/jobs/{id}` | The async path's real request/response shape and job lifecycle. |
| 0.4 | `--auto-fit on --max-vram 10` and `--max-vram 11` on the 2-reference case that dropped the cache | The failed run was **167 MB short** (`need 874 MB, available 707 MB`). `--max-vram 9` is Forge's own cap, not the card's limit — the card had 11,253 MiB free. Does raising it restore the prefix cache and return sampling to ~3.6s/it? |
| 0.5 | Warm-server **edit** timings at 640², 768×1152, 1024² | We have never measured a warm edit. 26–33s was warm *txt2img at 512²*. Every output-size promise in this plan is an estimate until this runs. |
| 0.6 | `batch_count: 2` / `batch_size: 2` with one reference | Does one request really share the conditioning pass, and does it fit in VRAM? |
| 0.7 | Whether the HTTP body exposes `image_preprocess` / `ref_image_args` (the `--image-preprocess` and `--ref-image-args` flags confirmed in `--help`) | Whether the **engine** resizes or fits the reference itself. If yes, the decoder (review blocker 1) may be unnecessary — option 2 in that section wins. |
| 0.8 | Start with a deliberately **wrong** GGUF as `--llm_vision` (e.g. the text encoder) | Whether a bad vision path is refused at start, errors at render, or silently produces garbage. A4 must assert the observed answer, not an assumed one. |
| 0.9 | `--model-args qwen_image_2_1_prefix_cache=1` (plus `..._type=`) on the 2-reference case | **New, from `--help` 2026-10-06.** The cache that dropped in `pose_v3` (`insufficient memory for prefix caching; retrying without it`) has an explicit model-arg switch. Whether forcing it beats raising `--max-vram` (0.4), and what `qwen_image_2_1_prefix_cache_type` accepts. |

### Pass rule for probe 0.1 (review blocker 2)

**HTTP 200 with an image in `images[0]` is not acceptance.** The body parser
ignores unknown fields, so a txt2img endpoint that silently drops `ref_images`
returns exactly that — and `sdcppImageBackend.ts:164-171` only checks that
`images[0]` is a non-empty string, so the tool would report success forever on a
render that ignored the user's picture. "Accepted" must mean **the output
depends on the reference**:

1. Same seed, prompt, size and steps, twice: once with no reference, once with
   one strongly distinctive reference (a solid-colour block or a large glyph).
2. Accept only if the two outputs differ by more than a pixel-difference
   threshold recorded here — computed, not judged by eye.
3. Corroborate from the server log: the conditioner line showing the vision
   tower actually ran (`Conditioner params … vision`).

If a silently-unconditioned render cannot be told apart at runtime, the plan
must say so plainly and state how the user would notice, rather than letting
probe 0.1 pass on a false positive.

**Phase 0 output:** timings appended to the table below, and this plan revised
so its file list and acceptance criteria match what 0.1 actually showed. Per
FORGE.md, do not call the plan implemented while it disagrees with the code.

### Phase 0 RESULTS (2026-10-06, RTX 3060, Q4_K, run by `_phase0_all.py`, report at `N:\SSUNO\scratch\phase0\phase0_report.json`)

**Probe 0.1 — the gate — says NO, and it says no in exactly the way review
blocker 2 warned about.** `POST /sdapi/v1/txt2img` with `ref_images: [<b64>]`
returned **HTTP 200 with a valid image**, and the naive probe would have called
that "accepted". It is not accepted: the output was **byte-identical** to the
same-seed render with no reference at all (both `sha=65cacbfc3c`, mean absolute
pixel difference **0.00**). The field is silently discarded. The vision tower
*was* loaded (`loading llm vision from ...mmproj-Qwen3VL-8B-Instruct-F16.gguf`),
but nothing in the log shows it conditioning the render, and `ref_images` never
appears in the log. **The cheap branch in the table above is dead: the
reference field is not honoured on the endpoint Forge already uses.**

**Consequence: every earlier "edit" measurement in this plan was measuring
txt2img.** The 2026-10-05 `pose_*` runs went through the CLI (`-r/--ref-image`),
which does honour references — that is why they produced edits. Anything routed
through `/sdapi/v1/txt2img` with `ref_images` was a text-only render. So:

- **Probes 0.4 and 0.9 as run are invalid for their stated purpose.** They
  measured a *txt2img* render, because the two references were dropped. The
  "two references dropped the prefix cache" case **cannot be reproduced through
  this endpoint at all** — there is nothing to reproduce. Both runs took ~105 s
  at 896² with no `insufficient memory` and no `prefix cach` line, which is
  consistent with references never having been loaded, not with the cache
  surviving. **Do not cite these two numbers as evidence about `--max-vram` or
  the prefix cache.** They must be re-run against whatever endpoint does
  condition on references.
- **Probe 0.5's numbers are real but mislabelled.** They are warm **txt2img**
  timings, not edit timings. Kept below as the txt2img ladder; the warm **edit**
  ladder is still unmeasured and still owed.

| Warm txt2img (refs ignored), 20 steps | Pixels | Total | Per step |
|---|---|---|---|
| 640×640 | 0.41 MP | 46.7 s | 2.34 s |
| 768×768 | 0.59 MP | 65.3 s | 3.26 s |
| 768×1152 | 0.88 MP | 112.0 s | 5.60 s |
| 1024×1024 | 1.05 MP | 136.5 s | 6.82 s |

Time scales with pixel count, cleanly: ~6.5 s per megapixel-step-set at 20 steps.
This replaces the "~4 min estimate" for 768×1152 in the Phase 4 table, which was
wrong by ~2×, and it explains the 1328²-vs-1024² contradiction flagged earlier:
the 1328² figure was a *cold* run and these are warm, so they were never
comparable.

**Probe 0.2 — capabilities confirms the field exists, and only for the async
mode.** `GET /sdcpp/v1/capabilities` → `features_by_mode.img_gen` advertises
`ref_images: true`, alongside `init_image`, `mask_image`, `control_image`,
`ip_adapter_image`, `hires`, `lora`, `cache`, `vae_tiling`. Note
`cancel_generating: false` but **`cancel_queued: true`** — the ledger's "Forge
cannot cancel" claim is only half right: an in-flight render cannot be
cancelled, but a *queued* one can. That is a usable lever for the abort case.

**Probe 0.6 — batching gives nothing. The plan's claim was wrong.**
`batch_size: 2` returned 2 images (`all_seeds: [777, 778]`) in **130.4 s** —
which is 2 × 65.3 s, i.e. **no shared conditioning pass at all**. And
`batch_count: 2` was **silently ignored**: 1 image, 65.2 s, one seed. So the
ledger's "two images share the expensive conditioning pass (~4.5 min vs ~6 min)"
was an unmeasured assertion that measurement has now **falsified**. `count: 2`
costs the same as two requests whether it is batched or not; batching buys a
round-trip, not time.

**Probe 0.7 — the HTTP body does not expose the CLI's preprocessing.**
`image_preprocess` → **HTTP 500** (rejected). `ref_images_b64` → accepted but
ignored (sha identical to baseline). `ref_image_args` → accepted, and its output
hash *differed* from the baseline (`abe34b80e9` vs `65cacbfc3c`) — **unexplained
anomaly, not a conclusion**: with `ref_images` itself being dropped, a
reference-processing argument should be inert. Flagged for probe 0.3 to resolve;
do not build on it. Either way, **the client-side downscale stays required** —
option 2 of the decoder decision ("the engine may resize it for us") is not
supported by this evidence.

**Probe 0.8 — good news, and it reverses review item 10's worry.** A wrong-but-
existing `--llm_vision` (the text encoder itself) makes the server **refuse to
start**: exit code 1 in ~5 s, with `Conditioner model tensor
'text_encoders.llm.visual.…' not in model metadata` × many, then
`model metadata validation failed` and `new_sd_ctx_t failed`. So the engine
validates the vision tower against the model's metadata, and A4's original claim
("fails at **start**, not at render") is **measured true**, not assumed. Forge's
job is only to surface that startup failure clearly rather than let it look like
a hang.

#### Phase 0 RESULTS, part 2 (2026-10-06, probes 0.3b-0.3d and 0e) — the endpoint decision

Run by `_phase0b.py`, `_phase0c.py`, `_phase0d.py`, `_phase0e.py`; the JSON
report is at `N:\SSUNO\scratch\phase0\phase0_report.json`. Every judgement below
is made on **output dependence** (mean absolute pixel difference against the
same-seed render with no image input), never on HTTP status — probe 0.1 is the
case that taught that rule.

| Probe | Shape | Result | Verdict |
|---|---|---|---|
| 0.3a | async `POST /sdcpp/v1/img_gen` + `ref_images` | mean pixel diff **47.70** vs same-seed baseline; server logs `Using 'qwen' preset for reference images` | **HONOURED — true vision conditioning** |
| 0.3b (decisive) | sync `POST /sdapi/v1/img2img` + `init_image` | solid magenta init at `denoising_strength` 0.4 **and** 0.75 → output stays magenta (RGB 201/15/201) against an apple prompt | **plain latent-init denoise, NOT vision conditioning** |
| 0.3c | sync txt2img + `init_image` / `init_images` / `ref_images_b64` / `image` | every field: diff **0.00** | all silently discarded |
| 0.3d | async `img_gen` + `init_image` | diff **62.12** | honoured (latent path) |
| 0.3d | async `img_gen` + `init_images` (plural) | diff **0.00** | ignored — the plural field is a trap |
| 0.3d | async `img_gen` + `init_plus_strength` | diff **62.12** | honoured |

**The endpoint question is closed.** `/sdcpp/v1/img_gen` + `ref_images` is the
only shape measured to condition a render on a reference image. The middle path
(sync `img2img` + `init_image`, one new field, no job loop) is **dead**: it moves
the starting latents, it does not let the model *see* the picture. So the async
branch of the table at the top of this plan is the shipped design, and the
job-poll loop in `src/tools/imageGeneration/sdcppJobPoll.ts` is mandatory.

**Probe 0e — the async contract, and the warm EDIT ladder (A21).**

| Item | Measured |
|---|---|
| Seed contract | same seed → **byte-identical** output (`sha 04ff6245da` == `04ff6245da`); different seed → different output. **No seed is echoed** in the job result, so Forge must report the seed it asked for. |
| Size contract | `768x1152` honoured — output was 768×1152. |
| Warm edit, 768×768, 1 reference | **174.1 s** |
| Warm edit, 768×1152, 1 reference | **402.4 s** |
| Warm edit, 896×896, 2 references | **606.4 s** — and `insufficient memory for prefix caching` fired twice in this run |
| Job shape | `{id, kind, status, queue_position, created, started, completed, error, result:{images:[{b64_json,index}], output_format}}` |

This replaces the Phase 4 table's "~4 min estimate" for 768×1152 with a measured
**402 s**, and it confirms the 2-reference case is where the prefix cache breaks:
the 606 s run is the same card, same steps, two references, and the cache line
appears exactly there. That is the measurement behind the automatic downscale.

**Two ledger cells that were open are now settled by the code, not assumed:**

1. **Does the poll loop touch `lastUsedAt` / hold the server claimed?** It must,
   and it does: submit **and every poll** run inside one `server.withActivity`,
   so `activeUses` stays above zero for the life of the job. Had the loop sat
   outside it, `idle_timeout_ms` (600 s default) would have stopped Forge's own
   server in the middle of the 606 s render above. Pinned by
   `test/unit/SdcppJobPoll.test.ts` › "keeps the server claimed for every poll…".
2. **Does `request_timeout_ms` bound the whole job or each poll?** The whole job
   (submit → result), stated in the module and tested by "gives up at the job
   deadline and warns the render may still own the GPU". A poll that outlives the
   deadline is **reported, not resumed**, and the message says the job may still
   own the GPU — matching the shipped `cancel_generating: false` reality.

## Measurements on the record (2026-10-05, RTX 3060, Q4_K, `--auto-fit on --max-vram 9`, `--fa`, te on CPU)

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

- Add `auto_fit: boolean` (default `true`) and `max_vram_gib: number` to
  `SdcppImageBackendSchema` (`src/config/imageGenerationSchema.ts`, 119 lines)
  and to `src/config/mediaTypes.ts` (115 lines).
- **Unit verified, not assumed:** `sd-server --help` (captured 2026-10-06 to
  `N:\SSUNO\scratch\sd_server_help.txt`) documents `--max-vram <string>` as
  "optional per-device budget **in GiB** for managed weights and runner
  buffers during automatic graph-cut execution", accepting a single value or
  `cuda0=6,vulkan0=4` form; `0` = live free VRAM with no explicit budget, a
  negative value = reserve that much free VRAM. So `max_vram_gib` is the right
  key name. **The shipped default comes from probe 0.4**, not from the old
  hardcoded `9`.
- `composeSdServerArgs` emits `--auto-fit on|off` and `--max-vram <n>`.
- A config change never silently adopts a server started under the old budget —
  but the outcome is a **restart in one window and a hard refusal in another**.
  Ledger rows 2–3 name the three paths and their line numbers.
- Ship `config/config.example.yaml` plus the schema default. **Do not edit
  `.forge/config.yaml` inside the change** — it is the owner's live config and
  the code never writes it back. Updating it is a named manual step for the
  owner, done between turns with their OK.
- Tests: `test/unit/SdServerBackend.test.ts` and `test/unit/SdcppImageBackend.test.ts`
  arg assertions.

**Expected:** improvement on cold runs, magnitude **TBD by probes 0.4 and 0.5**.
Do not quote "25%" or "549s → 410s": Known limitation 3 says that run's time
budget does not close (~380s unaccounted). **Not risk-free either:** changing
the spawn args changes the signature, so every already-running server is
disposed (same window) or refused (other windows) on upgrade. That user-visible
behaviour needs one line in `CHANGES.md`.

## Phase 2 — Reference images in the tool

### Config

`vision_encoder: z.string().min(1).optional()` on the sdcpp schema. Optional
deliberately: text-to-image works without it, and an existing config keeps
working. When it is set, `composeSdServerArgs` adds `--llm_vision <path>`, and
`SdServerBackend.verifyConfiguredPaths()` checks the file exists — that method
currently lists exactly four entries (`binary`, `diffusion_model`,
`text_encoder`, `vae`) and must gain a fifth, or a typo'd vision path fails at
render time instead of at start.

**Flag spelling verified, not assumed** (`sd-server --help`, captured to
`N:\SSUNO\scratch\sd_server_help.txt`): `--llm_vision <string>`, "path to the
llm vit". `--qwen2vl_vision` is a deprecated alias — do not use it.

**Existence is not validity.** `verifyConfiguredPaths` checks existence only, so
pointing `vision_encoder` at a wrong GGUF may load and then fail at the first
edit — or produce garbage silently. Probe 0.8 must run one start with a
deliberately wrong GGUF and record which of the three happens (refused at start /
error at render / silent), and A4 must assert the observed behaviour rather than
an assumed one.

### Tool arguments (`src/tools/imageGeneration/generateImageTool.ts`, 353 lines)

```
reference_paths: string[]   // image paths, 1..4
```

**Path sandbox — resolved (review item 7).** The draft said "workspace-relative
or absolute" and then A13 refused anything outside the workspace; those
contradicted. Decision: **paths outside the workspace are accepted**, because
that is where the inputs actually live — remote/Telegram uploads land in
`.forge/remote-inbox/`, and this session's sketches were read from
`V:/models/...`. The existing path-sandbox rule still applies to **writes**; a
read of a user-supplied image path is not the same exposure. A13 is therefore
rewritten to test that a reference outside the workspace **works**, and the
refusal test moves to the genuinely refused cases: a path that does not exist, a
non-image, and an output path that collides with a reference.

```
count: integer              // 1..2, default 1
```

**Naming rule for `count > 1`, both branches:** default name gets a `-1`/`-2`
suffix; an explicit `path` gets the same suffix before the extension, because
`targetPath` returns `requested` unchanged whenever `path` is given and would
otherwise overwrite variation 1 with variation 2.

**Duplicate reference paths — decided (review item 6):** de-duplicate on the
resolved absolute path, case-insensitively on Windows, and **say so in the
result** ("2 references, 1 duplicate removed"). Refusing is harsher than the
user needs; silently paying for the conditioning pass twice is not acceptable,
because duplicates double exactly the VRAM pressure this plan exists to avoid.
Duplicates count toward the cap of 4 **after** de-duplication.

**Output must not be a reference (review item 5):** if a resolved output path
equals any resolved `reference_paths` entry, refuse the call before any GPU
work. Compare case-insensitively on Windows. This is data loss in a tool sold as
"edit this picture", so it gets its own acceptance row (A22).

`prompt` stays required — an edit still needs instructions.

**`prompt` must stop being required only if Phase 0 shows the engine can edit
from references alone. It cannot today, and this plan does not change that.**

**Line budget — corrected 2026-10-06.** Verified counts: `generateImageTool.ts`
353, `sdcppImageBackend.ts` 276, `imageGenerationSchema.ts` 119,
`mediaTypes.ts` 115, `sdServerArgs.ts` 46. **The draft omitted the file that is
actually tight: `src/backend/SdServerBackend.ts` is 470 lines** against the hard
500-line `max-lines` stop, and Phase 2 adds the fifth `verifyConfiguredPaths`
entry there plus the probe-0.8 vision check. It must be split, not just
appended to.

**The split is a stated Phase 2 step, not a line-count trigger.**
`generateImageTool.ts` is already past the 350 soft threshold, and deciding
where to cut by watching a counter is exactly what the repo's own guidance warns
against. The seam is real today: `targetPath`, `displayPath`,
`describeWithBackends` and `pickBackend` are pure naming/description helpers,
not the run path — move them to `generateImageToolFormat.ts` and add an OWNERS.md
row. Do the same for `SdServerBackend.ts` before adding to it. Check with
`npx eslint <file>`, not by eyeballing.

### New module: `src/tools/imageGeneration/sdcppReferenceInput.ts`

Owns the one job the plan's speed rule depends on: **shrink before sending.**

**The decoder decision, settled 2026-10-06 (review blocker 1).** The plan
originally assumed a resize could simply be written. It cannot: `package.json`
has no image codec (no sharp, jimp, pngjs, jpeg-js), nothing in `src/` decodes
pixels, and the extension host exposes no Electron `nativeImage`. Verified by
reading the dependency list. Resolution, in order of preference:

1. **Reuse the shipped ffmpeg machinery — no new dependency.** `src/tools/ffmpegLocate.ts`
   (132 lines) already resolves ffmpeg as config key → PATH → WinGet, with a
   typed `FfmpegMissingError` that names the fix; `src/tools/videoExtract.ts`
   already builds `scale=W:H:flags=lanczos` argv and returns base64, and
   `computeScale()` is unit-tested. Same job, already solved and tested, so it
   must be extended rather than reinvented. On this machine ffmpeg resolves at
   `C:\ffmpeg\ffmpeg.exe` with `ffprobe.exe` beside it (as `pairFrom` requires),
   plus a second copy under WinGet. One ffmpeg call per reference:
   `-i <path> -vf scale=...:flags=lanczos -f image2pipe -vcodec png -`.
2. **Server-side resize, if probe 0.1/0.3 shows the engine does it.** Preferred
   over (1) if available — no spawn, no codec, no format matrix. `--ref-image-args`
   and `--image-preprocess` (both confirmed in `--help`) carry
   `mode=auto|none|stretch|crop|crop-resize|fit-pad` and `filter=...`, which
   suggests the engine already preprocesses references. Probe 0.7 must answer
   whether the HTTP body exposes that.
3. **A pure-JS codec dependency** only if 1 and 2 are both unavailable. Needs
   the user's explicit OK (dependencies stay minimal) and must be pure JS — a
   native module such as sharp breaks the cross-platform VSIX.

**Accepted formats must be named, not "non-image is refused".** `mimeFromHeader`
(`src/tools/imageTool.ts:21-63`) already sniffs PNG, JPEG, GIF, BMP and WEBP
from magic bytes and is the single existing sniffer — reuse it, do not write a
second one. The plan must state which of those the chosen decoder actually
accepts and refuse the rest **by name, before any GPU work**. Phone uploads are
commonly WEBP; HEIC is not sniffed by `mimeFromHeader` at all and must be
refused with an explicit "convert it to JPEG or PNG first" instruction, per the
FORGE.md rule that refusals name the alternative.

Behaviour:
- Load each path, reject non-images and anything over a byte cap, using
  `mimeFromHeader` for the type.
- Downscale so the long edge is ≤ `max_reference_edge_px`. **This is declared,
  not implied** (review item 11): add it to `SdcppImageBackendSchema` with
  bounds (default **768**, range 256–1536) alongside `auto_fit`, `max_vram_gib`
  and `vision_encoder`, and document it in `config.example.yaml`. Being a
  user-configurable parameter means the no-hardcoded-fallback rule applies, so
  the default lives in the schema rather than in the module.
- **Must be divisible by 32** after scaling — sd.cpp requires it, and we hit
  that limit directly this session. Note this differs from `computeScale`'s
  even-dimension rule: the mod-32 rounding is new and needs its own tests.
- Emit base64 in the shape probe 0.1/0.3 proves.
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

Measured/estimated ladder for one edit at 20 steps. **Every "estimate" below is
an estimate**; only the 512², 768² and 1328² rows have a measured number behind
them, and probes 0.5 must replace the rest before any timing is quoted to a
user.

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
| A1 | An existing config with no `vision_encoder` still renders text-to-image. **Strengthened (review):** "existing cases pass untouched" cannot fail if those cases never asserted the args. Pin the new default with an explicit argv snapshot for a config carrying none of the new keys. | `test/unit/SdcppImageBackend.test.ts` + a new argv-snapshot case asserting the exact spawn args including `--auto-fit` and `--max-vram` at their shipped defaults. |
| A2 | `reference_paths` with no `vision_encoder` configured refuses, and the message names the mmproj and an alternative backend. | New unit test, string assertion. |
| A3 | `--llm_vision` appears in the spawn args exactly when `vision_encoder` is set. | `test/unit/SdServerBackend.test.ts` args assertion. |
| A4 | A **wrong** (existing but not-mmproj) `vision_encoder` behaves as probe 0.8 observed — refused at start, error at render, or documented as undetectable. A **missing** path fails at start. | Two tests: `verifyConfiguredPaths` with a missing fifth entry; plus the probe-0.8 behaviour asserted as observed. The draft's claim that a wrong file fails at start is **not** assumed. |
| A5 | Changing `auto_fit`, `max_vram_gib`, or `vision_encoder` changes `sdServerSignature`. | Unit test: two configs → two signatures. |
| A6 | A running server with a mismatched signature is **not adopted**, on all three paths. | Three named cases, not one: (a) same window, config edited → registry disposes (`sdServerRegistry.ts:99-107`); (b) other window alive → refusal thrown (`sdServerReconciliation.ts:80-85`), **including a case where the model is identical and only `vision_encoder` differs**, asserting the message says the configuration differs; (c) owner dead → orphan killed and respawned, never adopted (`sdServerReconciliation.ts:60-79`). |
| A7 | A 1280×1253 reference is downscaled to long edge ≤768 **and** both dimensions divisible by 32. | `sdcppReferenceInput` unit test with exact expected dimensions. |
| A8 | The tool result states the downscale it performed. | Unit test on the result string. |
| A9 | Reference count over 4 refuses with a named reason. | Unit test. |
| A10 | `count` over 2 refuses; `count: 2` produces two saved files and two distinct reported seeds. | Unit test on `targetPath` collision + seed reporting. |
| A11 | Two variations never overwrite each other. | `targetPath` test: same prompt, same second, different index. |
| A12 | Turn abort mid-edit behaves exactly as mid-txt2img (owned server killed only under the `lastUsedAt` rule). | Extend `test/unit/SdServerAbort.test.ts`. |
| A13 | A reference path **outside** the workspace is accepted (remote uploads and `V:/models/...` sketches live there). A nonexistent path is refused. | Unit tests for both, matching the sandbox decision in Phase 2. |
| A14 | A non-image, an over-cap, or an **unsupported format** (named in the result) reference is refused before any GPU work. | Unit tests; assert no server call was made. One case per refused format, asserting the refusal names the format and the alternative. |
| A15 | If Phase 0 chose the async endpoint: an interrupted poll is reported, not silently resumed, **and** no orphan GPU render is left behind that the next request would queue behind. | New test; **only if applicable**, else mark "not applicable — no async job". Must also cover whether the poll loop touches `lastUsedAt` (idle-timer stop mid-render) and whether `request_timeout_ms` bounds the whole job or each poll. |
| A16 | A request over the measured pixel ceiling refuses with a named reason, and the ceiling sits high enough that a multi-subject output at a usable per-subject size is still allowed. | **NOT IMPLEMENTED IN THIS CHANGE — deferred.** Phase 4 proposed adding explicit `width`/`height` for `sdcpp` behind a measured pixel ceiling. No ceiling was ever measured for the *async edit* path at arbitrary sizes (probe 0e measured only 768², 768×1152 and 896²), and the plan forbids inventing one. `size` therefore stays the three-value enum and no new refusal exists. A16 stays open with its own probe requirement, recorded under Known limitations. |
| A17 | `npm run ci` green: type-check, vitest, ESLint including the 500-line `max-lines` gate on every touched file. | `npm run ci`, exact result reported. |
| A18 | `git diff --check` clean; `git status` reviewed including untracked files. | Named step. |
| A19 | Version bumped in `package.json` **and** `CHANGES.md` updated in the same change. | FORGE.md rule; named step. |
| A20 | Live smoke: one sketch → 3D render from the phone, delivered to the remote chat, timing logged. | Manual, on the 3060, one job at a time. |
| A21 | Warm-server edit timing recorded and compared to the 188s cold baseline. **Pass threshold stated:** the measured warm edit time replaces the estimate in the size table; the row is not "done" until the table matches a measured number. | Phase 0.5 + A20 logs. |
| A22 | An output path that resolves to the same file as any `reference_paths` entry is refused before any GPU work (case-insensitive on Windows). | New unit test. Prevents the edit overwriting its own source. |
| A23 | `count: 2` with an **explicit `path`** produces two distinct files (`name-1`, `name-2`), not one overwritten file. | New `targetPath` test — the case A10/A11 missed. |
| A24 | Duplicate `reference_paths` are de-duplicated and the result says so; the cap of 4 applies after de-duplication. | New unit test. |
| A25 | `count: 2` interrupted after the first image reports exactly one saved file and states the second was not produced. | New unit test on the partial-output path. |
| A26 | A reference the engine **silently ignored** is either detected, or the limitation is documented with how the user would notice. | Probe 0.1 pass rule; unit test on the pixel-difference check if detection is implemented. |
| A27 | `max_reference_edge_px` is a schema field with bounds; no hardcoded fallback sits in the module. | Schema test + grep of the module for a literal default. |
| A28 | The ffmpeg decode path refuses with a named reason (missing ffmpeg, non-zero exit) before GPU work, reusing `FfmpegMissingError`. | Unit test with a fake install, following `test/unit/videoExtract.test.ts` patterns. |

## Known limitations at draft time
Revised after the Claude review of 2026-10-06
(`docs/reports/IMAGE_EDIT_TOOL_PLAN_REVIEW_2026-10-06.md`, 16 items). Both
blockers are resolved in the text above; the open questions are now confined to
Phase 0 probes, which is where they belong.

1. **`txt2img` does NOT take `ref_images` — measured 2026-10-06 (probe 0.1):**
   the field is accepted syntactically and discarded, producing a byte-identical
   render with or without a reference. The open question is now async
   `/sdcpp/v1/img_gen` vs sync `/sdapi/v1/img2img` + `init_image` (probe 0.3),
   and it decides whether this feature needs a job-poll loop at all.
2. **The warm txt2img ladder is measured** (probe 0.5, see Phase 0 RESULTS).
   The warm **edit** ladder is still unmeasured, because no HTTP endpoint that
   actually edits has been confirmed. No edit timing may be quoted to a user
   until probe 0.3 lands. The earlier table's "~4 min" estimate for 768×1152 was
   wrong by ~2× (measured: 112 s).
3. **The 410s run's time budget does not close.** ~380s unaccounted. No speedup
   percentage is promised anywhere in this plan.
4. **`view_image` returned a bare `⟨image⟩` token** for several images on
   2026-10-05 — the chat model's own vision path appeared degraded after
   `strata-vision.exe` was killed and respawned. Unrelated to this plan, but it
   means the pose results of that day were not visually verified. It worked
   normally on 2026-10-06, where both presets were inspected by eye.
5. **Edit outputs stay anchored to the reference.** Two seeds of an edit vary
   far less than two seeds of txt2img. Not a bug; users expecting big variation
   should change the prompt. Confirmed empirically 2026-10-06 in ComfyUI: a
   prompt asking a building sketch for "poses" returned a tidier building.
6. **The decoder is a real dependency decision, not a free function call.** No
   image codec exists in this repo today. Preferred path reuses the shipped
   ffmpeg locator and scaler; the accepted-format list is a consequence of that
   choice and must be stated in the tool's refusals.
7. **A wrong-but-existing `vision_encoder` is caught by the engine, not by
   Forge.** Probe 0.8 measured it: the server exits 1 within ~5 s with
   `model metadata validation failed`. So the risk is not silent garbage — it is
   Forge presenting a fast startup crash as a hang. A4 asserts that.
8. **`--max-vram` raising is not free.** It changes the signature, so on upgrade
   every already-running server is disposed (same window) or refused (another
   window). One line in `CHANGES.md` covers it.
9. **Phase 4 (explicit `width`/`height` behind a measured pixel ceiling) is NOT
   in this change.** `size` remains the three-value enum. The ceiling cannot be
   written without an async-edit measurement at arbitrary sizes, and probe 0e
   measured only 768², 768×1152 and 896². A16 is therefore open, not passed.
10. **The tool-schema character budget is nearly exhausted.** Adding
    `reference_paths` and `count` pushed the maximally-advertised schema to
    55,448 chars against a 55,483 ceiling. The two descriptions were trimmed to
    fit rather than raising the ceiling. Any further tool growth needs one of the
    two sanctioned responses in `TOOL_SCHEMA_GROWTH_PLAN.md` (family-tool merge,
    or scoping by model/conversation).
