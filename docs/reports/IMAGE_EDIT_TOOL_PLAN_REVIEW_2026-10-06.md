# Review: IMAGE_EDIT_TOOL_PLAN.md

Reviewer: Claude, 2026-10-06. This is a review only: the plan and the source files are unchanged.
Line numbers cite the plan as `plan:N` and code as `file:N`.

Result: **2 blockers**, 9 fix-before-code, 5 notes.

---

## Blockers

### 1. The downscale step has no image decoder, so the plan's main speed fix cannot be built as written. BLOCKER
- **The plan:** `sdcppReferenceInput.ts` must "Load each path… Downscale so the long edge is ≤ 768… divisible by 32" (plan:179-185). That is the only fix for the 20-minute case.
- **The code:** `package.json` dependencies have no image codec or resizer: no sharp, jimp, pngjs or jpeg-js. Nothing in `src/` decodes pixels. The extension host also has no Electron `nativeImage`. Node cannot resize a PNG or JPEG without one of these.
- **Correction:** choose the mechanism in the plan before Phase 2, and record it in the ledger and in Known limitations.
  - (a) Add a dependency. CLAUDE.md says "Keep dependencies minimal unless the user explicitly asks", so this needs the user's explicit OK, and it must be named. A native module such as sharp also breaks the cross-platform VSIX.
  - (b) A PowerShell `System.Drawing` helper, following the desktop driver's pattern. This is Windows-only, which is acceptable because sdcpp is already Windows-only. It needs its own spawn, timeout and exit-code ledger row.
  - (c) Make the server do the resize, if Phase 0 shows it can.
- **The decoder choice also sets which reference formats are supported**, and phone uploads are often WEBP or HEIC. The plan must list the accepted formats, and every unsupported one must be refused by name before any GPU work. A14 only says "non-image".

### 2. Phase 0.1 can pass when the endpoint has actually ignored the references. BLOCKER
- **The plan:** probe 0.1 is "`POST /sdapi/v1/txt2img` with `ref_images`", and it settles "whether `ref_images` is accepted" (plan:94). The table in plan:59-62 branches on that answer.
- **What can go wrong:** the existing body parser ignores unknown fields. HTTP 200 with an image in `images[0]` is exactly what a txt2img endpoint returns when it drops `ref_images` silently. The resulting image is a plain txt2img render. That passes 0.1 and selects the cheap branch, which is wrong. `sdcppImageBackend.ts:123-171` only checks for `images[0]`, so the tool would also report success forever after.
- **Correction:** define "accepted" as *the output depends on the reference*, not as "HTTP 200".
  - Run the same seed, prompt and size twice: with no reference, and with one strongly distinctive reference such as a solid-colour block or a large glyph.
  - Accept only if the images differ measurably, for example by a pixel-difference threshold recorded in the plan.
  - Also grep the server log for the conditioner's reference-image line, since `Conditioner params … vision` shows it actually ran.
- **Add an acceptance row** for silent ignoring: a test fixture that returns an unconditioned image must be detectable, or the plan must state that it is undetectable at runtime and say how the user would notice.

---

## Fix before code

### 3. Ledger rows 2-3: "signature mismatch forces a restart" is wrong in two of the three paths
- **What the code does:**
  - **Signature contents:** `sdServerSignature` (`sdServerArgs.ts:35-45`) already hashes `args: composeSdServerArgs(config)`. Any field that emits a CLI arg joins the signature automatically, so `--auto-fit`, `--max-vram` and `--llm_vision` need no separate signature edit. The plan's "must now hash" (plan:75, plan:136) is redundant; adding them as separate keys would be harmless.
  - **Same window, config edited:** `sdServerRegistry.ts:99-107` `sameConfig` compares the WHOLE config as JSON and disposes the old server. That is the real mechanism behind "server stopped 12 s after a `request_timeout_ms` edit". It is the registry, not `reconcileSdServerRecord`, so the plan:76 attribution is wrong.
  - **Other window alive, different signature:** `sdServerReconciliation.ts:80-85` **refuses** by throwing. It does **not** restart. The error says "owned by another Forge window using model X". When both windows use the same model and only `auto_fit` or `vision_encoder` differ, that message points the user at the wrong cause.
  - **Owner dead, server orphaned:** `sdServerReconciliation.ts:60-79` **never compares the signature**. It refuses if the server was used within `idle_timeout_ms`; otherwise it kills the server (after an exe check) and respawns. So it never adopts a stale-signature orphan, but it isn't a signature check either.
- **Verdict:** adoption safety holds. No path adopts a server with a mismatched signature (line 80 for a live owner; an orphan is never adopted). "Forces a restart" is false for the cross-window case: that case is a hard refusal until the other window stops.
- **Corrections:**
  - (a) Rewrite ledger rows 2-3 with these three paths and cite the lines above.
  - (b) Change the line-82 refusal to say the *server configuration* differs, not only the model. Add a test where the model is the same and `vision_encoder` differs.
  - (c) A6 says "Existing refusal test, extended". Name the test file and case, and add the orphan path as its own case, so that a later signature check added to the orphan path isn't mistaken for already being covered.

### 4. `count: 2` with an explicit `path` overwrites the first variation
- **The code:** `targetPath` (`generateImageTool.ts:293-305`) returns `requested` unchanged, apart from the extension, whenever `path` is given. The default name has one-second resolution (`slice(0,15)`), with no index. A10 and A11 only test the default-name case.
- **Correction:**
  - Define the naming rule for count>1 under both branches, e.g. `name-1.png` / `name-2.png`.
  - Say whether an existing file at `path` is overwritten today. If it is, that existing behaviour should be stated, not inherited silently.
  - Add A11b: an explicit `path` with `count: 2` produces two distinct files.

### 5. The reference image can also be the output path
- If `path` (or a variation index) resolves to the same file as a `reference_paths` entry, the edit overwrites its own source. That is data loss in a tool marketed for "edit this picture".
- **Correction:** refuse the call when a resolved output path equals any resolved reference path. Compare case-insensitively on Windows; see the drive-case trap in memory/OWNERS. Add an acceptance row for it.

### 6. Duplicate reference paths are undefined
- **Correction:** pick one behaviour (refuse, or de-duplicate and say so in the result) and test it. Duplicates count toward the cap of 4 and double the conditioning cost. That cost is exactly the VRAM pressure the plan is trying to avoid.

### 7. A13 contradicts the argument spec
- **The plan:** plan:160 allows "workspace-relative or absolute image paths". A13 refuses "outside the workspace".
- **Correction:** pick one. Remote and Telegram uploads, and the user's `V:/models/...` sketches, may live outside the workspace. If outside paths are refused, the refusal must name the alternative ("copy it into the workspace first"), per the FORGE.md refusal rule.

### 8. The async-job ledger row contradicts A15 and the existing abort model
- **The ledger** (plan:80) says, on turn abort, the existing `stopAfterAbort()` "kill owned server only if `lastUsedAt` older than `request_timeout_ms`". A15 says the interrupted job is "reported, not silently resumed".
- **What's missing:**
  - **(a)** Today's abort cancels by killing the server, because an in-flight HTTP request is the unit. With polling, aborting the poll leaves a job **still running on the GPU**. If the server is not killed, the next request queues behind an orphan render the user believes is cancelled.
  - **(b)** Who touches `lastUsedAt` during a poll loop? If polls don't touch it, the idle timer can stop the server mid-render. If they do, abort will never kill it.
  - **(c)** `request_timeout_ms` currently bounds one fetch (`sdcppImageBackend.ts:116`). For async jobs, say whether it bounds submit-to-result or each poll.
- **Correction:** fill these three cells explicitly. The honest answer may be "abort kills the owned server, exactly as today", which keeps A12's invariant true. "Forge never cancels" (plan:80) contradicts the shipped abort path (`SdServerBackend` stop at :216-217).

### 9. `count` is ledgered as "argument, not state", but it writes two durable files
- **Partial output:** with abort or timeout between image 1 and image 2, image 1 is on disk and image 2 is not.
- **Correction:**
  - Add a ledger row for the second output: what is reported, and whether image 1 is still delivered to the remote chat.
  - Add an acceptance row for "count:2, abort after first" → result names one saved file and states that the second was not produced.
  - Also say whether `request_timeout_ms` is per image or per call.

### 10. `vision_encoder` pointing at a non-mmproj GGUF
- **The plan:** A4 only covers a *missing* file. `verifyConfiguredPaths` (`SdServerBackend.ts:341-347`) checks existence only.
- **What can go wrong:** a wrong GGUF, such as the text encoder itself, may load and fail at the first edit, or produce garbage silently.
- **Correction:** Phase 0 should run one start with a wrong GGUF as `--llm_vision` and record what happens: refused at start, error at render, or silent. Then add an acceptance row matching the observed behaviour.
- Also verify the flag spelling (`--llm_vision` vs `--llm-vision`) from `sd-server.exe --help`. The plan asserts it without citing a source.

### 11. `max_reference_edge_px` is used but never declared
- **The plan:** plan:181 makes it a configurable value (default 768). Phase 1 and Phase 2 add only `auto_fit`, `max_vram_gib` and `vision_encoder` to the schema.
- **Correction:** either declare it, with schema bounds and a docs row, or make it a constant. If it is a constant, say so: the CLAUDE.md "no hardcoded fallback for user-configurable params" rule applies only if it is configurable.

---

## Notes

### 12. Line counts are verified correct, but the plan omits the one file that is actually tight
- The counts below match the real files exactly:
  - `generateImageTool.ts` 353
  - `sdcppImageBackend.ts` 276
  - `imageGenerationSchema.ts` 119
  - `mediaTypes.ts` 115
  - `sdServerArgs.ts` 46
- **Not cited:** `src/backend/SdServerBackend.ts` is **470** lines. Phase 2 adds the fifth `verifyConfiguredPaths` entry there, and the vision-capability check in #10 would land there too. Put it in the plan's line budget.
- **On the split:** `generateImageTool.ts` is already past the 350 soft threshold. "Split if it crosses ~450" (plan:172) turns a seam decision into a line-count trigger, which CLAUDE.md warns against. The seam is real now: `targetPath`, `displayPath`, `describeWithBackends` and `pickBackend` are pure naming and description helpers, not the run path. Make the split a stated Phase 2 step, add an OWNERS.md row, and don't let the line count decide.
- The `sdcppJobPoll.ts` and `sdcppReferenceInput.ts` seams are sound.

### 13. Phase 1 promises the number that Known limitation 3 retracts
- **The plan:** plan:143 says "Expected: 549s → 410s class improvement on cold runs, no code path risk". plan:118-122 and limitation 3 say the 410 s run "does not close" (about 380 s unaccounted for) and not to promise 25%.
- **Also:** the `max_vram_gib` default is 9 (plan:133), while probe 0.4 exists to find out whether 10 or 11 is needed.
- **Correction:** Phase 1's default comes from 0.4. Its "Expected" line should cite 0.4 and 0.5, not the unexplained run. "No code path risk" is not true either: changing the args changes the signature, so every already-running server is disposed (same window) or refused (other windows) on upgrade. That is worth one line in CHANGES.md.

### 14. Ledger `count` row states a 0.6 result as already measured
- **The plan:** plan:81 says "Measured: two images share the expensive conditioning pass (~4.5 min vs ~6 min)". Probe 0.6 (plan:99) asks exactly that question as open.
- **Correction:** pick one. If it was measured, cite the run and drop 0.6. If not, mark plan:81 as an estimate.

### 15. Unit of `--max-vram` is unverified
- The config key is named `max_vram_gib`, but the plan never cites the unit sd.cpp expects (GiB, GB or MiB). Verify it from `--help` or the source in Phase 0.
- The name must match the unit, or a later "11" means 11 MiB.

### 16. Plan edits `.forge/config.yaml` "in the same change" (plan:138)
- That is the owner's live config. The standing rule is to never edit it mid-turn, and the 0.16.71 plan treated it as user-owned.
- **Correction:** ship `config.example.yaml` plus a schema default. Put the live-config edit in a named manual step for the owner, or do it only between turns with the owner's OK.

---

## Acceptance-criteria mapping summary
- **Unfalsifiable as written:**
  - A1 "existing cases pass untouched": this cannot fail if the cases never exercised the args. Add an explicit arg-snapshot for a config with none of the new keys, which pins `--auto-fit on --max-vram 9` as the new default.
  - A20 (manual, judged by the user, which is acceptable but must stay a manual row).
  - A21, which has no pass threshold.
- **Missing:** these are covered in the items above.
  - silent ignoring of references (#2)
  - explicit path with count 2 (#4)
  - output equal to a reference (#5)
  - duplicate references (#6)
  - partial count output (#9)
  - wrong-GGUF vision encoder (#10)
  - the decoder's accepted formats (#1)
  - the cross-window refusal message with the same model and a different config (#3b)
