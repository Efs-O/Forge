# Local image generation — stable-diffusion.cpp on the RTX 3060

Status: **shipped in 0.16.71** (2026-10-01). Phases 0-3 done: config and
`SdServerBackend` in 44d277b, tool wiring in e30ed3f. Live smoke 2026-10-01:
a 1024x1024 card rendered on the 3060 in about 4 min, cold start included.
The 3060 peaked at about 6.2 GB and both 5060 Tis stayed unchanged. The
server stopped 12 s after a `request_timeout_ms` edit, as designed for a
signature change; the 10-minute idle exit and Telegram delivery are not yet
observed live. Sizes raised to Qwen-Image's native 1328x1328 / 928x1664 /
1664x928 after the smoke. That turn ran on Strata (Flash-Next),
not the Qwen Q6 + mmproj named in Phase 3.
Implementer: decided at hand-off (Qwen via Forge, Codex, or a split by phase).
Reviewer: Claude.

Replaces the **ComfyUI half** of `IMAGE_GENERATION_TOOL_PLAN.md` (its Phases 0,
2 and 4, never started). The cloud half of that plan shipped in 0.16.0 and is
unchanged; this plan adds a second backend kind behind the same
`generate_image` tool.

## Problem

`generate_image` only reaches cloud providers (`xai`, `openai`,
`openai-compatible`, `src/config/imageGenerationSchema.ts:19`). Every image costs
money and leaves the machine. The ComfyUI plan stalled on VRAM: its 12–19 GB
image models could not share the GPUs with a resident chat model, so the only
v1 answer was "unload the chat model first".

Two things changed:

1. **Qwen-Image 2.1** (7B diffusion transformer, 2026) has GGUF quants from
   leejet, the stable-diffusion.cpp author: Q4_K 4.2 GB, Q5_0 5.1 GB,
   Q8_0 7.7 GB. Its text encoder (Qwen3-VL-8B, Q4_K_M 5.0 GB) can run on the CPU.
2. **The RTX 3060 (12 GB) is nearly idle** under both daily chat setups:

   | Chat setup | On the 3060 | Usable for images (keep ≥1 GB free, WDDM) |
   |---|---|---|
   | Strata Flash-Next (`strata-iq3_s-2gpu.json`) | display only, ~1.7 GB | ~9 GB |
   | `qwen38-27b-mtp-ud-q6k-tensor-vision` | display + mmproj (`--mmproj-device CUDA2`, 0.87 GB file) ≈ 3.5 GB | ~7 GB |
   | voice (`voice.compute.device: 2`) | +3–4 GB while whisper transcribes | transient conflict |

So an image model can live on the 3060 **next to** the chat model, and nothing
has to be unloaded.

## Why stable-diffusion.cpp, not ComfyUI

`sd-server.exe` (`V:\Tools\sd.cpp-master-929\`, release `master-929-3f8527a`)
is the image counterpart of `llama-server`: one binary, models as flags, a
loopback HTTP server. Verified from `sd-server -h` and the binary on 2026-10-01:

- Endpoints: `/v1/images/generations`, `/v1/images/edits`, `/v1/models`,
  `/sdapi/v1/txt2img` (A1111 shape), `/sdcpp/v1/img_gen` + `/sdcpp/v1/jobs/`
  (native async), `/sdcpp/v1/capabilities`.
- Placement: `--backend te=cpu,diffusion=cuda0,vae=cuda0`, `--offload-to-cpu`,
  `--max-vram`, and `--auto-fit` (default **on**). Auto-fit may place weights
  on "another GPU", which here means the 5060 Tis. Forge therefore spawns
  with `CUDA_VISIBLE_DEVICES=<ordinal>` so the process cannot see them, and
  passes `--auto-fit off` so an over-budget model fails loudly instead of
  spilling.
- Device names (`--list-devices`): `CUDA0/1` = 5060 Ti, `CUDA2` = 3060. With
  `CUDA_VISIBLE_DEVICES=2` the 3060 becomes `CUDA0` inside the process.
- Default generation options can be set at spawn (`--steps`, `--cfg-scale`,
  `--sampling-method`, `-W`, `-H`).

Compared with ComfyUI: no Python environment, no workflow JSON to export and
patch by node id, and no separately managed app. Forge spawns it, health-checks
it, and stops it after an idle period, the same lifecycle `EmbeddingBackend`
already runs.

## Phase 0 — measure before building (no Forge code)

### 0a. Quant comparison (run 2026-10-01)

Kit in `V:\models\Qwen-Image-2.1\bench\`:

- `prompts.tsv`: three prompts with fixed seeds. `card` tests lettering and
  illustration (the real use case), `portrait` tests faces, hands and skin, and
  `bakery` tests dense detail and small text.
- `run_bench.sh`: `sd-cli` per quant × prompt, 1024×1024, 20 steps, euler,
  cfg 6. Text encoder on CPU, diffusion + VAE on the 3060 only. Peak VRAM is
  polled with `nvidia-smi -lms 200` and written to `results.csv`. The script
  refuses to start if the 3060 already holds more than 2.6 GB. `--dry-run`
  prints the commands.
- `make_compare.py` writes `compare.html`, a grid with time and VRAM per image.

**Output:** the user picks the quant by eye. Record the chosen quant, its peak
VRAM delta and its warm render time in the results table below. The VRAM gate
(Phase 2) is set from that measurement plus a 1 GB margin.

### 0b. Server behaviour (after the quant is chosen)

Start `sd-server` by hand with the chosen quant and answer each question
**before** Phase 1:

1. Cold start: seconds from spawn until the first request succeeds, and which
   endpoint is a reliable readiness probe (`/v1/models` or
   `/sdcpp/v1/capabilities`).
2. VRAM while idle and loaded, and peak VRAM during a render. Does the text
   encoder on CPU stay resident in RAM, and how much RAM does it use?
3. Which request fields `/v1/images/generations` honours (`size`, `seed`,
   `n`, `response_format`) versus `/sdapi/v1/txt2img` (`seed`, `steps`,
   `cfg_scale`, `width`, `height`). Pick **one** endpoint. The default
   choice is `/sdapi/v1/txt2img`, because it carries seed and size
   explicitly. Switch only if 0b shows the OpenAI endpoint honours them too.
4. Abort: does dropping the HTTP connection stop the render? If not, abort
   means killing the server. Measure how long VRAM takes to come back.
5. Does `/sdcpp/v1/capabilities` (or `/v1/models`) report the loaded model
   path? This decides whether another window can verify and adopt a running
   server (see the ledger).
6. Warm render time for 1024×1024 and for 768×1344 portrait.
7. Two requests at once (two chats): does the server queue the second, reject
   it, or run both and run out of memory? If it does not queue, the backend
   serialises requests itself with an in-process queue.
8. The `te` module name in `--backend te=cpu,...` comes from the help text
   ("`--clip-on-cpu` deprecated; use `--backend te=cpu`"). Confirm in the
   verbose log that the Qwen3-VL encoder really lands on the CPU, and not on
   the 3060.

### Results (filled in after Phase 0)

| Measurement | Value |
|---|---|
| Chosen quant | **Q4_K** (user, 2026-10-01). Same speed as the others, smallest footprint, and the only clean card render: Q5_0 left a green smear between the candles, and Q8_0 a faint one in the same spot. Q5_0/Q8_0 files deleted. |
| Peak VRAM delta, 1024² (sd-cli, 0a) | Q4_K 5.1–5.3 GB · Q5_0 5.9 GB · Q8_0 8.4 GB; 1024², 20 steps: ~145 s for every quant (7 s encode on CPU, 124 s sampling, 12 s VAE decode) |
| Idle loaded VRAM | 5.1 GB VRAM + ~5 GB RAM (text encoder) after the first render; **0** before it, since models load lazily (`eager_load: false`) |
| Cold start → ready | HTTP up in 3.1 s (`/v1/models` 200), but nothing is loaded yet. The first render pays the load: 165 s cold vs 132 s warm at 1024². So the VRAM gate runs before the **first request**, not only at spawn. |
| Warm render 1024² / 768×1344 | 132 s / 133 s (20 steps, euler, cfg 6); 512² ≈ 27 s. Same seed → byte-identical PNG. Peak VRAM 5.7 GB. |
| Endpoint chosen | **`/sdapi/v1/txt2img`**. `/v1/images/generations` honours `size` but ignores `seed` (always 42) and uses cfg 7. Response: `images[0]` base64 PNG + `info`. |
| Abort behaviour | Dropping the connection does **not** stop the render: the GPU stayed at 99 % until it finished. Capabilities say `cancel_generating: false`, `cancel_queued: true`. Killing the server frees VRAM in 0.3 s. Abort = kill (owned server only, per the guard above). |
| Model path visible over HTTP | yes: `/sdcpp/v1/capabilities` → `model.path` (diffusion model). Adoption checks this plus the record signature. |
| Concurrent requests | Queued, run one at a time (2 × 512² finished at 28 s and 55 s), `max_queue_size: 64`. No in-process queue needed, but a queued request waits behind the one running, so `request_timeout_ms` must cover a wait plus a render (300 s covers one waiting request at 1024²). |
| Text encoder placement confirmed on CPU | yes — `te=cpu` accepted; Qwen3-VL weights 4.3 GB in RAM on CPU (log, 0a) |

## Design

### Config

A second backend kind in `image_generation.backends`, as a Zod discriminated
union on `provider`. Cloud entries keep their current shape and need no
migration.

```yaml
image_generation:
  default: qwen-image-local
  output_dir: generated-images
  backends:
    - name: qwen-image-local
      provider: sdcpp
      binary: V:/Tools/sd.cpp-master-929/sd-server.exe
      diffusion_model: V:/models/Qwen-Image-2.1/qwen_image_2.1-Q4_K.gguf
      text_encoder: V:/models/Qwen-Image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf
      vae: V:/models/Qwen-Image-2.1/qwen_image_2.1_vae_bf16.safetensors
      cuda_device: 2            # nvidia-smi / PCI-bus ordinal (same convention as voice.compute.device)
      text_encoder_on_cpu: true
      port: 8093
      min_free_vram_mb: 7000    # from Phase 0 peak delta + 1024 margin
      idle_timeout_ms: 600000
      request_timeout_ms: 300000
      defaults: { steps: 20, cfg_scale: 6.0, sampler: euler, width: 1024, height: 1024 }
      extra_args: []            # passed through verbatim, like extra_llama_server_args
      confirm_on_start: true
      confirm_each: false
    - name: grok-imagine
      provider: xai
      model: grok-imagine-image-2.0
      api_key_secret: xai
      confirm_each: true
```

Schema rules (`src/config/imageGenerationSchema.ts`):

- Every path is required, with no fallback discovery. A missing file is
  reported at spawn time by its config key and path.
- `port` is required. The server binds `127.0.0.1` only, and the schema has no
  host field, so nothing else can be configured.
- **`idle_timeout_ms >= request_timeout_ms + 60000`**, enforced by a schema
  refinement. Another window's in-flight render must never outlive the owner's
  idle timer (see the ledger). This is the CI-enforced row.
- `model` is not required for `sdcpp`. The display label is
  `sdcpp · <diffusion_model basename>`.

### New module: `src/backend/SdServerBackend.ts`

Owns the `sd-server` child process. One instance per configured `sdcpp`
backend, registered in `context.subscriptions`. The shape follows
`EmbeddingBackend`: a deduplicated `start()`, `withActivity()` holding an
activity count, an idle stop, and `dispose()`.

- **Spawn** through `src/backend/llamaProcess.ts`. That file is the
  process spawn/teardown owner; it gains an optional `env` parameter instead
  of a sibling spawner. `killLlamaProcess` is reused unchanged for the
  Windows tree kill. Env: `CUDA_DEVICE_ORDER=PCI_BUS_ID`,
  `CUDA_VISIBLE_DEVICES=<cuda_device>`.
- **Args:** `--listen-ip 127.0.0.1 --listen-port <port> --diffusion-model …
  --llm … --vae … --backend te=cpu,diffusion=cuda0,vae=cuda0 --auto-fit off
  --fa` (`te=cuda0` when `text_encoder_on_cpu: false`), the defaults block,
  then `extra_args`.
- **Readiness:** poll the endpoint chosen in 0b until it answers. The timeout
  is cold start from 0b plus a margin. Every stderr line goes to a
  `Forge - image server` output channel. A start failure surfaces the last
  stderr lines and never just "failed to start".
- **Owner record** at `%LOCALAPPDATA%\Forge\sdcpp\<backend name>.json`:
  `{ pid, pidCreatedAt, port, binary, signature, ownerPid, ownerCreatedAt,
  startedAt, lastUsedAt }`, validated with Zod. `signature` hashes every path,
  the port, the device and the args. Written with a temp file and rename.
  **The owner writes it once, at spawn; only adopting windows rewrite it**
  (to update `lastUsedAt`), so owner and adopter never race on the same
  fields. It is used for orphan reaping and for adoption; see the ledger.
- **"Alive" means pid plus creation time.** Windows reuses PIDs, so a bare
  "pid exists" check can mistake a stranger for the owner or the server.
  Both are read with one `Get-CimInstance Win32_Process -Filter "ProcessId=N"`
  query (`ExecutablePath`, `CreationDate`). A pid counts as the same process
  only when its creation time equals the one recorded. There is no `wmic`
  fallback: `wmic` is deprecated, and CLAUDE.md asks for one explicit path.
- **Orphan reaping:** on `start()`, if a record exists, its owner is dead
  and its server is alive (both by pid + creation time), kill the server
  **only if** its `ExecutablePath` also equals the configured `binary`.
  Otherwise leave it alone and report that the port is held by pid N. CLAUDE.md
  forbids killing unrelated processes.
- **Adoption:** if the record's owner is alive (another Forge window), its
  `signature` equals this window's, and the port answers, use the server
  without owning it. Write `lastUsedAt` in the record at request start and end.
  If the signature differs (the two windows have different configs), refuse.
  Name the other window's model file and port, and do not spawn a second
  server on the same card.
- **Idle stop** re-reads the record when the timer fires. If
  `record.lastUsedAt + idle_timeout_ms` is still in the future, it reschedules
  to that time instead of stopping.

### New module: `src/tools/imageGeneration/sdcppImageBackend.ts`

Same output type as `generateCloudImage` (`GeneratedImage`). It reuses
`mimeFromHeader` and `MAX_GENERATED_IMAGE_BYTES`; there is no second sniffer.

1. **VRAM gate** (only when this call has to spawn the server): `probeGpus()`
   from `src/system/systemProbes.ts`, the row whose `index` equals
   `cuda_device`. `GpuInfo.index` is nvidia-smi (PCI-bus) order, and the spawn
   sets `CUDA_DEVICE_ORDER=PCI_BUS_ID`, so the two numbers mean the same card.
   That is why the env var is mandatory, not cosmetic. If
   `memoryTotalMb - memoryUsedMb < min_free_vram_mb`, refuse with the free
   amount, the requirement, and the alternatives: "stop whatever holds the
   3060, or use backend grok-imagine". If the probe fails, or either memory
   field is `null`, refuse with `describeProbeFailure` (fail closed, as in
   `JOB_GPU_GATE_PLAN.md`).
2. `SdServerBackend.withActivity(() => POST …)`, using the endpoint chosen in
   0b, `request_timeout_ms` and the turn's `abortSignal`. On abort: if 0b
   showed that a dropped connection does not stop the render, stop the owned
   server, **but only if** `record.lastUsedAt` is older than
   `request_timeout_ms`, so no other window can have a render in flight.
   Otherwise, and always for an adopted server, let the render finish and
   report that it is still running.
3. HTTP and process errors become strings that name the fix (CLAUDE.md:
   refusals name the alternative). Examples:
   - `sd-server exited during startup: <last stderr line>`
   - `qwen-image-local: out of memory on the RTX 3060 — something else is using it (whisper, a mmproj); retry, or use grok-imagine.`

### `generateImageTool.ts` changes (small)

- Dispatch on `backend.provider`: `sdcpp` goes to `generateSdcppImage`, and
  everything else goes to `generateCloudImage` as today. The dependency
  injection gains `generateLocal` for tests.
- Approval: `startApproval()` from `SdServerBackend` when a spawn is needed
  (`confirm_on_start`). It says the server starts on the RTX 3060 with about
  X GB and unloads after N minutes idle. Otherwise the approval is
  `dangerous: confirm_each`, the same as today.
- Optional `size` argument: `"square" | "portrait" | "landscape"`, mapped to
  1024², 768×1344 and 1344×768 for `sdcpp`. Cloud backends ignore it, and the
  result says so. Tool definition growth stays at or under 250 characters.
- **The description must stop lying.** Today it says "Each call asks the user
  to approve it", which is false for a local backend with
  `confirm_each: false`. CLAUDE.md: a tool that lies costs more than a tool
  that fails. New wording: "Cloud backends ask for approval and bill per image;
  local backends are free."
- **Permission.** The tool keeps `permission: 'fetch'`. A loopback request is
  still a network call, and splitting the permission per backend would need
  a per-call permission, which the registry does not have. Consequence: a
  profile that disables `fetch` also disables local images. Say so in the
  config example.

### Choosing local vs cloud (how the agent knows)

The model does **not** have to be told in the prompt. The mechanism already
exists:

1. **`default` decides when nothing is said.** The tool's `backend` argument
   is optional. Omitted, it resolves to `image_generation.default`, so with
   `default: qwen-image-local` every plain "make me a birthday card" renders
   locally.
2. **The model sees every backend.** `describeWithBackends` turns `backend`
   into an enum of the configured names and lists each one. That listing gains
   a cost tag derived from `provider`, with no new config field:
   `qwen-image-local (local · free · sdcpp · qwen_image_2.1-Q4_K)`,
   `grok-imagine (cloud · billed per image · xai · grok-imagine-image-2.0)`.
   When the user says "use Grok" or "use the cloud one", the model can match it.
3. **No automatic fallback.** A local refusal (VRAM, server crash) is returned
   as an error. Forge never silently re-routes to a paid backend (CLAUDE.md:
   no hidden fallback). If the model decides to retry on `grok-imagine`, that
   backend's `confirm_each: true` shows the user a billing confirmation first,
   so a paid retry is never silent.
4. **The approval dialog names the backend** (existing `approval.detail`), so
   the user sees which one is about to run before a cloud call.

### What is out of scope

- Forge downloading models or the sd.cpp binary. Paths are configured by hand,
  and an install tool is a later plan.
- Image editing (`/v1/images/edits`, Qwen-Image 2.1 supports it). That is a
  follow-on with a `reference_image` argument.
- Voice and image scheduling on the 3060. A whisper call during a render can
  run out of memory. v1 surfaces that error clearly; a shared 3060 mutex is a
  follow-on, measured first.
- `gpu.hold` from `JOB_GPU_GATE_PLAN.md`. That gates *scheduled jobs*. A
  user's image request is not a job, and the VRAM gate covers a training run
  on the 3060.
- `EmbeddingBackend` refactoring. The lifecycle code overlaps. If Phase 1
  shows more than about 60 lines duplicated, extract a shared on-demand-server
  helper in a separate commit with the embedding tests unchanged. Do not
  pre-extract.

## Files touched

| File | Change |
|---|---|
| `src/config/imageGenerationSchema.ts`, `src/config/types.ts` | discriminated union, `sdcpp` fields, idle ≥ timeout refinement |
| `src/backend/llamaProcess.ts` | optional `env` on the spawn helper |
| `src/backend/SdServerBackend.ts` | **new** — process, owner record, reaping, adoption, idle stop |
| `src/tools/imageGeneration/sdcppImageBackend.ts` | **new** — VRAM gate, request, error mapping |
| `src/tools/imageGeneration/generateImageTool.ts` | provider dispatch, start approval, `size` |
| `src/tools/registerAllTools.ts` (line ~191) | construct `SdServerBackend`s next to `makeGenerateImageTool`, push to the disposables |
| `config/config.example.yaml` | commented `sdcpp` example |
| `docs/OWNERS.md` | rows for the two new modules |
| `docs/plans/IMAGE_GENERATION_TOOL_PLAN.md` | status line: ComfyUI half superseded by this plan |
| `CHANGES.md` | entry |

`generate_image` is registered in `registerAllTools.ts`, so the backends are
built there. `extension.ts` (359 lines) is touched only if disposal cannot be
reached from the registration module.

## Phases

0. **Measure** (above). There is no code. Decisions: quant, endpoint, abort
   behaviour.
1. **Config + `SdServerBackend`** with unit tests (fake spawn, fake fetch, fake
   process lookup). No tool change, so it ships dark.
2. **`sdcppImageBackend` + tool dispatch + approval + `size`**, with tests.
3. **Live smoke + docs:** a Qwen Q6 turn with the mmproj on the 3060 generates
   a card image locally, and a Telegram-watched turn receives the photo. Then
   OWNERS, the config example, CHANGES and the old plan's status line.

Each phase ends with `npm run ci` green (CLAUDE.md; not tsc + vitest alone).

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `sd-server` child process (Forge-owned) | First `generate_image` call on an `sdcpp` backend, after the VRAM gate and start approval | `stop()` on idle timeout, `dispose()` on deactivate, or a config change that alters the backend's signature (paths, port, device, args) | Removing the backend or the whole `image_generation` block stops it when the config is applied; `advertise()` hides the tool | Crash during startup: the readiness wait sees the exit, surfaces the last stderr lines, and deletes the owner record. A crash mid-render becomes a tool error and the next call respawns | VS Code crash: the process is orphaned and keeps the 3060's VRAM. The next `start()` in any window reaps it through the owner record, and only when its exe path equals the configured `binary` | `idle_timeout_ms` after the last use, where last use is `max(local, record.lastUsedAt)` |
| Owner record `%LOCALAPPDATA%\Forge\sdcpp\<name>.json` | Written after spawn, before the readiness wait (temp file + rename) | Deleted after `stop()` confirms the process exited; deleted by the reaper after it kills an orphan | Deleted together with the process when the backend is removed | A torn or unparseable file is treated as absent plus a warning in the output channel. If the port is then busy, the error names the port and says Forge will not kill an unverified process | Kept; it is the evidence the next start uses to reap. A record whose `pid` is dead is deleted on read | None of its own. It lives exactly as long as the process it describes |
| `lastUsedAt` written by an adopting window | At the start and end of each request it sends to another window's server | Goes with the record | Not written once the backend is removed from that window's config | A torn write falls under the record row above; the owner then idles out on its local clock, which cannot cut an in-flight render because `idle_timeout_ms ≥ request_timeout_ms + 60 s` | If the adopter dies mid-request, the owner sees no more updates and stops after the idle timeout; the render was already abandoned | Superseded by the next write |
| Generated image files (`output_dir` or the given path) | Saved after a successful render, after `beforeMutate` snapshots the path (existing code) | Undo through the turn checkpoint, or the user deletes it | Not applicable: nothing pauses a saved file | Existing write path: `fs.writeFile` of a fully buffered image, so a crash leaves no file or a whole one | Unaffected; it is a workspace file | None; the user owns it |
| `image_generation.backends[]` entry with `provider: sdcpp` | The user edits `config.yaml` | The user removes it, which stops the process (row 1) | Removal is the only disable; there is no `enabled` flag, so there is one way to turn it off | Invalid YAML or schema: the existing config-load error, and the tool is not advertised | Not applicable: config outlives every process | None |
| Model files and `sd-server.exe` on `V:` | Downloaded by hand (Phase 0); Forge never writes them | Only the user deletes them; Forge never does | Not applicable | A partial download fails at spawn with the server's own load error, surfaced with the path | Not applicable | None |

**CI-enforced row (cheapest):** a schema unit test in which an `sdcpp` backend
with `idle_timeout_ms < request_timeout_ms + 60000` is rejected, and one at
exactly the boundary is accepted. That pins the invariant that lets the
adoption row work without a cross-window activity counter. A later phase that
changes the timeout semantics fails this test.

## Acceptance criteria

1. **Phase 0 recorded.** The results table above is filled in, the chosen
   quant is named, and `min_free_vram_mb` in the example config comes from the
   measured peak plus 1024.
2. **Schema.** A cloud backend with today's shape parses unchanged. An `sdcpp`
   backend missing any path is rejected with that key named. The idle/timeout
   refinement test (the CI row) passes.
3. **Device isolation.** A unit test asserts that the spawn env carries
   `CUDA_DEVICE_ORDER=PCI_BUS_ID` and `CUDA_VISIBLE_DEVICES=<cuda_device>`, and
   that the args contain `--auto-fit off` and `--listen-ip 127.0.0.1`.
4. **Lifecycle.** With a fake spawn:
   - two concurrent calls start one process;
   - the idle timer does not fire while a call is active, and fires after
     `idle_timeout_ms`;
   - `dispose()` kills the process and deletes the record.
5. **Reaping guard.** A dead `ownerPid` with a live pid whose exe path matches
   gets killed. A live pid whose exe path does **not** match is left alone, and
   the error names the pid and port.
6. **Adoption.** With a live `ownerPid` and an answering port, the second
   window does not spawn, writes `lastUsedAt`, and never stops the server.
7. **VRAM gate.** Fake `probeGpus` with less free memory than
   `min_free_vram_mb` refuses with the free amount, the requirement and
   `grok-imagine` named. A probe failure refuses (fails closed).
8. **Errors name the fix.** Missing binary, missing model file, startup exit,
   HTTP 500 and an out-of-memory string each produce a message with the
   config key or the alternative backend.
9. **Abort.** An aborted turn mid-render returns promptly. The owned server is
   stopped if 0b showed that a dropped connection does not cancel the render.
10. **Tool definition** grows by at most 250 characters (report the numbers).
11. **Live smoke** (recorded in the PR): with the Q6 Tensor model loaded, a
    local turn renders a 1024² card on the 3060. `nvidia-smi` shows both 5060
    Tis unchanged during the render, and the server is gone after the idle
    timeout.
12. **CI.** `npm run ci` passes. No `.ts` file passes 500 lines.
13. **Docs.** OWNERS rows, config example, CHANGES entry, and the old plan's
    status line pointing here.
