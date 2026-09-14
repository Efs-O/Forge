# `generate_image` — cloud (xAI) + local (ComfyUI) image generation (impl plan)

Status (2026-09-14): **cloud half shipped in 0.16.0** — Phase 1 (cloud
backend + tool + config) and Phase 3 (Telegram photo) are built, for `xai`,
`openai` and `openai-compatible` image endpoints. **ComfyUI (Phases 0, 2, 4)
is not started** and remains the plan below.

Where the build deviated from this draft, and why:
- Config keys are `provider` (not `kind`) and per-backend `confirm_each`
  (default true → approval is `dangerous`, so /clanker still asks).
- The tool returns **text only**, not an `image_url` part: a 1–2 MB image as
  base64 in every later request would cost far more context than it earns. The
  model gets the path and can call `view_image`.
- The sidebar shows the image by opening it in an editor tab beside the chat
  (plus the result row); no webview change was needed.
- Telegram delivery rides `RemoteAgentProgress.deliverImage` (the live turn
  message), reached through `UserNotificationService.deliverImage` — not a new
  `AgentProgressEvent` kind. That keeps `ToolDispatch.ts` and `extension.ts`
  (both at the 500-line cap) untouched, and it reports 0 honestly when no chat
  is watching the turn.
- No new permission group: the tool needs the existing `net.fetch` plus
  `fs.write`. The returned image URL is required to be `https://`, not pinned
  to `imgen.x.ai` — a host pin would break `openai-compatible` backends, and
  the URL comes from the provider the user configured.

## Goal

One tool, `generate_image`, callable by **every** tool-using model (local
llama.cpp, Ollama, cloud). It renders an image through a user-configured
backend, saves it into the workspace, shows it in the sidebar, hands it back to
the model as an image part, and — when a Telegram chat watches the turn — sends
it to the phone as a photo.

Two backend kinds in v1:

| Kind | Endpoint | Verified 2026-09-14 |
|---|---|---|
| `xai` | `POST https://api.x.ai/v1/images/generations` | ✅ `grok-imagine-image-2.0` returned a JPEG URL in 7.7s with the OpenCode OAuth token; `$0.04` (1k/low). The same model on `/v1/chat/completions` answers `Model not found`, so it can never be a chat model entry. |
| `comfyui` | local ComfyUI HTTP API (`127.0.0.1:8188`) | ⚠️ Not running today; launcher is `N:\AI\Tools\start_comfyui_stable_audio.bat`. |

Local image models present under `N:\AI\ComfyUI\models` (found, not tested):
`z_image_turbo_bf16` (12.3 GB), `krea2_turbo_fp8_scaled` (13.1 GB),
`flux2_dev_Q4_K_M.gguf` (18.7 GB, needs ComfyUI-GGUF — installed),
`qwen-image-2512-Q4_K_M.gguf` (13.2 GB), `qwen-image-edit-2511-Q4_K_M.gguf`
(edit model — out of scope for v1). **No image workflow is saved** in
`user/default/workflows` (only audio/video ones), so Phase 0 has to build them.

---

## Design

### Config (`config.yaml`, Zod-validated)

```yaml
image_generation:
  default: z-image-turbo          # used when the model omits `backend`
  output_dir: .forge/images       # workspace-relative default for output_path
  backends:
    - name: grok-imagine
      kind: xai
      model: grok-imagine-image-2.0
      api_key_secret: xai          # same resolution as chat: SecretStorage → OpenCode auth.json
      confirm: always              # costs money per image
    - name: z-image-turbo
      kind: comfyui
      url: http://127.0.0.1:8188
      workflow: N:/AI/ComfyUI/user/default/workflows/api/z_image_turbo.api.json
      inputs:                      # "<node id>.<input name>" in the API-format workflow
        prompt: "6.text"
        seed: "3.seed"
        width: "5.width"
        height: "5.height"
      timeout_s: 300
```

- No `image_generation` block → the tool is not registered. No fallback
  backend, no guessed URL (CLAUDE.md: explicit config over hidden fallback).
- `backend` in the tool schema is an **enum built from the configured names**,
  so the model cannot invent one.
- `url` must be loopback for `kind: comfyui` in v1 (it is a local tool; a
  remote ComfyUI is a different trust decision).

### Tool schema (strict)

```ts
generate_image {
  prompt: string            // what to draw (≤ 4000 chars, validated)
  backend?: enum<configured names>
  output_path?: string      // workspace-relative; default <output_dir>/<timestamp>-<slug>.png|jpg
  size?: "square" | "portrait" | "landscape"   // mapped per backend
  seed?: integer            // comfyui only; ignored + noted for xai
}
```

`prompt` is a natural-language string, the same class as `web_search`'s
`query` — not a free-form argument blob. Description text must say paths are
relative to `workspaceFolders[0]` (CLAUDE.md ergonomics trap).

### New module: `src/tools/imageGeneration/` (split on real seams)

| File | Owns | ~LOC |
|---|---|---|
| `generateImageTool.ts` | schema, arg validation, output path, checkpoint (`beforeMutate`), save, `MultimodalToolResult`, progress event | 130 |
| `xaiImageBackend.ts` | token via `resolveXaiToken` (reuse, no copy), POST, download the temporary URL **immediately**, map HTTP errors to actionable strings | 70 |
| `comfyuiBackend.ts` | load API workflow JSON, patch mapped inputs, `POST /prompt`, poll `GET /history/{id}`, fetch via `GET /view`, cancel via `POST /interrupt` on abort | 140 |
| `imageBackendTypes.ts` | `ImageBackend` interface + result type | 25 |

Shared rules for both backends:
- `AbortController` threaded from `ToolHandlerContext.abortSignal`; ComfyUI
  gets `/interrupt` + queue delete on abort, not just a dropped fetch.
- Bytes are sniffed with the existing `mimeFromHeader` (`src/tools/imageTool.ts`)
  — not a second sniffer — and capped at `MAX_VIEW_IMAGE_BYTES` (10 MB).
- Every failure returns a string that names the fix (CLAUDE.md: a refusal names
  the sanctioned alternative). Examples:
  - `ComfyUI is not reachable at http://127.0.0.1:8188 — start it (N:\AI\Tools\…bat) or use backend "grok-imagine".`
  - `xAI rejected the token (401) — run "opencode auth login" → xAI.`
  - `ComfyUI node 6 has no input "text" — the inputs map in config.yaml does not match the workflow.`
- Failures use the default `ToolFailureTracker` behaviour: an offline backend
  or a VRAM refusal is a real tool failure, not an environment limit like
  output truncation.

### Permissions & cost gate

- New permission group entry in `PermissionResolver`: `generate_image` under
  `net` (cloud) — it is outbound for `kind: xai`.
- `confirm: always` on a backend forces the per-action confirmation dialog even
  under auto-approve profiles: a looping model must not buy 40 images. Local
  ComfyUI defaults to `confirm: never`.
- CLAUDE.md network rule: xAI is already an opt-in configured provider; ComfyUI
  is loopback-only. No new outbound hosts beyond `api.x.ai` and the image URL
  host xAI returns (`imgen.x.ai`) — list that host explicitly in the backend so
  a redirect elsewhere is refused.

### VRAM (the hard part for local)

Measured 2026-09-14: `nvidia-smi` shows **two 16 GB cards, 15.6 GB and 15.5 GB
used** with a local model resident. (Memory notes say the second card is a 12 GB
3060 — the hardware changed or that note is stale; verify before sizing.) The
local image models are 12–19 GB plus text encoders. **A resident llama-server
and a ComfyUI render cannot share the cards today.**

Options, in order of complexity:

1. **Refuse with a clear message (v1 default).** Before `/prompt`, read ComfyUI
   `GET /system_stats` free VRAM; if below the configured `min_free_vram_gb`,
   fail with: `Not enough free VRAM for z-image-turbo (1.2 GB free, needs ~13) —
   unload the local model (/unloadModel) or use backend "grok-imagine".`
   A cloud or CLI model driving the turn is unaffected.
2. **`vram_policy: unload_local` (Phase 3, opt-in).** Unload through
   `unloadModel` in `src/backend/ControlModelLifecycle.ts` (the existing path —
   `DirectBackend` stays the sole spawn site), render, let the next round
   reload. Cost: reload time + full prompt re-processing for the calling local
   model, since its KV cache is gone. Worth measuring before shipping.
3. ComfyUI `--lowvram` RAM offload — possible but slow over the PCIe x2/x4
   links; measure only if 1+2 disappoint.

Forge does **not** start or stop ComfyUI in v1 (CLAUDE.md: process management
stays explicit). Open question 2 below.

### Sidebar display

Return a `MultimodalToolResult` (`text` + `image_url` part), same shape as
`view_image`, so vision models see their own output. Phase 1 verifies the
webview renders tool-result images; if it only renders text today, add an image
row to `toolResultView.ts` through the typed `messageBridge` (no new channel).
Non-vision models get text only (`saved .forge/images/…png, 1024×1024,
backend z-image-turbo`) — reuse the existing capability check that `view_image`
uses.

### Telegram

- `src/remote/TelegramPhoto.ts` (~35 LOC), a copy of the shape of
  `TelegramVoice.ts`: multipart `sendPhoto`, through the per-chat
  `telegramSendQueue` so it cannot overtake the text around it. Fall back to
  `sendDocument` when Telegram rejects photo dimensions/size (>10 MB, or aspect
  ratio beyond 20:1) — a named, logged fallback, not a silent one.
- `RemoteChannel.sendPhoto?(chatId, path, caption, signal)` in `types.ts`.
- New `AgentProgressEvent` kind `image { path, caption }` emitted by the tool.
  `RemoteAgentProgress.handle` queues it on `state.tail` exactly like a
  narration, so order is preserved and it only reaches a chat that already
  watches this turn (remote-origin or mirrored host turn) — same targeting,
  no new policy. Caption = backend + first 200 chars of the prompt.
- Photos notify (a send, not an edit), which is the point.

---

## Files touched

| File | Change |
|---|---|
| `src/tools/imageGeneration/*` | new (above) |
| `src/tools/registerAllTools.ts` | register when `image_generation` configured |
| `src/tools/PermissionResolver.ts` | group + `confirm: always` handling |
| `src/config/schema*.ts`, `src/config/types.ts` | `image_generation` block |
| `src/sidebar/AgentProgress.ts` | `image` event kind |
| `src/remote/RemoteAgentProgress.ts` | deliver `image` via `sendPhoto` |
| `src/remote/TelegramPhoto.ts`, `TelegramChannel.ts`, `types.ts` | `sendPhoto` |
| `src/sidebar/toolResultView.ts` (+ webview) | only if Phase 1 finds images unrendered |
| `config/config.example.yaml` | commented example block |
| `docs/OWNERS.md` | rows for the new modules |
| `CHANGES.md` | release entry |

Every exported function gets a caller in the same commit (CLAUDE.md).

## Test plan

Unit (vitest, fake fetch — no network, no GPU):
- schema: unknown backend rejected; missing config → tool absent.
- xai: 200 → download → sniff → saved; 401 / 400 / expired image URL / HTML
  body instead of image → actionable string; abort mid-download.
- comfyui: workflow patching by `node.input` map; missing node/input → config
  error; `/history` poll until outputs; `/view` fetch; abort → `/interrupt`
  called; unreachable → names the launcher and the cloud alternative;
  low-VRAM `/system_stats` → refusal text.
- checkpoint: `beforeMutate` called with the output path before the write;
  Undo removes the file.
- remote: `image` event rides `state.tail` after a preceding narration;
  no chat bound → nothing sent; `sendPhoto` failure → `sendDocument` fallback
  once, then reported via `onError`.

Live smoke (manual, recorded in the PR):
1. Grok: a local Qwen turn calls `generate_image backend=grok-imagine` →
   confirmation dialog → file saved → sidebar shows it → Telegram photo arrives.
2. ComfyUI with the local model unloaded: `z-image-turbo` render end-to-end.
3. ComfyUI with a local model resident: clean VRAM refusal, turn continues.

## Phases

0. **Workflows (no Forge code).** Start ComfyUI, build a text-to-image graph for
   `z_image_turbo` (and optionally `qwen-image-2512`, `flux2_dev`), export each
   with *Export (API)* into `user/default/workflows/api/`, note node ids for the
   `inputs` map, record VRAM peak and seconds per image.
1. xAI backend + tool + sidebar + config + tests. Ships alone and is useful.
2. ComfyUI backend with the VRAM refusal (option 1).
3. Telegram `sendPhoto` + `image` progress event.
4. Opt-in `vram_policy: unload_local`, only after measuring reload cost.

## Out of scope (follow-ons)

- Image **editing** (`qwen-image-edit-2511` + Lightning LoRA, or xAI image
  input) — needs a `reference_image` arg and a second workflow shape.
- Video (LTX-2.5, MiniMax H3, `ComfyUI-Grok-Imagine-Video`) — minutes-long
  jobs, needs background execution, not a blocking tool call.
- Forge launching/stopping ComfyUI.
- Multiple images per call (`n > 1`).

## Open questions for the user

1. **VRAM:** is refusing (option 1) acceptable for v1, or must a local-model
   turn be able to auto-unload itself to render?
2. **ComfyUI lifecycle:** keep starting it by hand, or should Forge get an
   opt-in `launch_command` (spawned, owned, disposed in `deactivate()`)?
3. **Which local model first** for Phase 0 — `z_image_turbo` (fastest, smallest)
   is the suggestion.
4. **Where images land:** `.forge/images/` (git-ignored) or a visible
   workspace folder?
