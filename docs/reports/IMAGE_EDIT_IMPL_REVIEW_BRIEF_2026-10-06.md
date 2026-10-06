# Implementation review brief — Plan C (image editing reference inputs)

Branch: `feat/image-edit-reference-inputs` (based on `ca9053d`, 0.16.89).
Nothing is committed yet. `npm run ci` is green: 4458 passed, 41 skipped, 432 files.
Type-check, lint (incl. 500-line and Prettier gates), vitest, build, bundle-load all exit 0.

Your own audit is at `docs/reports/IMAGE_EDIT_TOOL_PLAN_REVIEW_2026-10-06.md` (16 items).
The plan is `docs/plans/IMAGE_EDIT_TOOL_PLAN.md` (revised; Phase 0e results recorded,
A16 marked NOT IMPLEMENTED, known limitation #9 added).

## What to review — the whole diff

Tracked modifications:

- `CHANGES.md` (new 0.16.90 section)
- `package.json` (0.16.89 → 0.16.90)
- `docs/plans/IMAGE_EDIT_TOOL_PLAN.md`
- `src/backend/SdServerBackend.ts`
- `src/backend/sdServerArgs.ts`
- `src/backend/sdServerReconciliation.ts`
- `src/config/imageGenerationSchema.ts`
- `src/config/mediaTypes.ts`
- `src/tools/imageGeneration/generateImageTool.ts`
- `src/tools/imageGeneration/sdcppImageBackend.ts`
- `test/unit/SdServerBackend.test.ts`

New files:

- `src/backend/sdServerPaths.ts`
- `src/tools/imageGeneration/sdcppErrors.ts`
- `src/tools/imageGeneration/sdcppVramGate.ts`
- `src/tools/imageGeneration/sdcppJobPoll.ts`
- `src/tools/imageGeneration/sdcppReferenceInput.ts`
- `src/tools/imageGeneration/generateImageToolFormat.ts`
- `src/tools/imageGeneration/generateImageToolLocal.ts`
- `test/unit/SdcppReferenceInput.test.ts` (21)
- `test/unit/SdcppJobPoll.test.ts` (14)
- `test/unit/GenerateImageToolReferences.test.ts` (11)

`docs/reports/` is untracked-by-convention (`docs/*` is gitignored); the plan doc was
force-added earlier. Review the files on disk, not `git status`.

## The measurement facts the design rests on

All measured against the real `sd-server` on an RTX 3060 12 GB (probes in
`N:\SSUNO\scratch\`, results in the plan's Phase 0e table):

1. `txt2img` + `ref_images` → pixel diff **0.0** vs no reference. The field is accepted
   and **silently discarded**. Same for `init_images`, `ref_images_b64`, `image`.
2. `img2img` + `init_image` → honoured (diff 62.12) but a **plain latent re-denoise**:
   a magenta initial image at strength 0.4 *and* 0.75 stays magenta. Not vision conditioning.
3. **Async `/sdcpp/v1/img_gen` + `ref_images` is the only true editing path**
   (diff 47.70, server logs "Using 'qwen' preset", edit-mode graph).
4. `img_gen` also honours `init_image` (diff 62.12) and `init_plus_strength`; ignores `init_images`.
5. Same seed → byte-identical output. Different seed → different. **No seed echo** in the
   job result, so Forge generates and reports the seed itself.
6. Requested size is honoured (768×1152 came back 768×1152).
7. Warm edit ladder: 768×768 1 ref = **174 s**; 768×1152 1 ref = **402 s**;
   896×896 2 refs = **606 s**. A 1536 px reference on the old path took ~20 min.
8. Job shape: `{id, kind, status, queue_position, created, started, completed, error,
   result:{images:[{b64_json,index}], output_format}}`.

## Invariants to check (each should map to a test)

1. **A reference is never silently ignored.** If `vision_encoder` is unset, refuse before
   any GPU work and name the setting. (`A2`)
2. **An output path that resolves to a reference is refused** before GPU work, including
   through a probe/`..` indirection. (`A15`)
3. **The poll loop keeps the server marked active.** The whole submit→poll→extract cycle is
   inside one `withActivity`, so the idle timer cannot stop the server mid-render.
   There is a test asserting `activeUses` stays > 0 across polls.
4. **A job that outlives `request_timeout_ms` is reported, not resumed**, and the message
   says the render may still hold the GPU. No retry, no second submit.
5. **Fail-closed VRAM gate**: if the GPU probe fails, refuse — do not start a render that
   may OOM the serving model. (`A11`)
6. **Reference downscale is deterministic and reported**: longest edge → 768 (configurable
   256–1536), both sides a multiple of 32, and the result text says what was changed.
7. **`count` > 1 puts the suffix on the first file too** (`name-1`, `name-2`), each variation
   has its own seed, and a partial failure names the file that *was* saved and says the
   second was not produced. (`A10`, `A22`–`A26`)
8. **Server signature covers the new settings** (`auto_fit`, `max_vram_gib`, `vision_encoder`,
   `max_reference_edge_px`) so a stale `sd-server` is disposed/refused. (`A6`)
9. **The refusal says "configuration differs", not "model X"**, when only `vision_encoder`
   differs. (`A6(b)`, test in `test/unit/SdServerBackend.test.ts`)
10. **All five model paths (incl. `vision_encoder`) are verified at start** with a missing-path
    error that names the setting. (`A5`)
11. **`--auto-fit on` is the default** and `--max-vram` is emitted in GiB.
12. **No path traversal / arbitrary read**: `reference_paths` are read from disk by the tool,
    so check the path handling and that a directory or oversized/non-image file is refused
    with a clear message rather than a stack trace.
13. **No duplicate implementations**: HTTP-failure text, VRAM gate and job polling must exist
    once, shared between the plain-generation path and the reference path.
14. Every `.ts` file stays under 500 lines; no dead exports left behind.

## Deliberate deviations, please sanity-check these

- **A16 (cancel on abort) is NOT implemented.** The server reports
  `cancel_queued: true` but `cancel_generating: false`, so a running render cannot be
  cancelled. Recorded as known limitation #9 with the measurement. Is deferral right, or
  should Forge at least mark the server busy so a follow-up call queues instead of OOMing?
- **`max_reference_edge_px` bounds are 256–1536** — 1536 is the value measured to take ~20 min.
  Should the upper bound be lower?
- **`count` is capped at 2** because each variation costs 174–606 s on this hardware.
- **`reference_paths` accepts absolute paths outside the workspace** by design (phone uploads).
  Check nothing else in the tool assumes workspace-relative.
