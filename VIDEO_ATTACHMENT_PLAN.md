# Video attachment — `view_video` via ffmpeg frame extraction (impl plan)

**Goal:** let the agent inspect a short workspace video clip. Forge extracts a
small, ordered, downscaled set of frames with ffmpeg and returns them as
numbered images through the multimodal tool path that `view_image` already
uses. Optional, off-by-default audio extraction for the two projectors that
actually carry an audio tower.

**Scope discipline (no complexity):** one new module for the ffmpeg work, one
new tool file, one registration line, one config block. No new UI, no webview
attachment path, no video player, no thumbnails in chat. The agent calls a
tool; it gets frames back. Everything else is out of scope for v1.

---

## Why extraction and not llama.cpp's `input_video`

Measured on this machine 2026-08-25 (see **Evidence** below). llama.cpp
b10608+ has a native `input_video` content part, and it works. We are not
using it as the primary path, for four reasons that are all measurements
rather than preferences:

1. **We need ffmpeg either way.** One unscaled 5 s 1920×1088 Ssuno clip costs
   **22,501 prompt tokens** on Qwen3.8-27B and is rejected outright against a
   16k context. Downscaling to 640 px costs 2,479; to 384 px, 983. Any usable
   native path needs an ffmpeg pre-pass for exactly the same reason ours does,
   so the dependency is not avoidable — only its owner is.
2. **`input_video` carries no audio.** Verified: Gemma 4 12B, asked to describe
   only the audio track of a clip that has an AAC stream, answered
   `NO AUDIO RECEIVED`. Sound is only reachable by extracting it ourselves.
3. **It is llama.cpp-only.** Frames are ordinary images, so extraction works on
   llama.cpp, Ollama, and the OpenAI-compatible cloud providers alike. Building
   on `input_video` would give Forge a capability that silently disappears when
   the user switches to an Ollama or OpenRouter model — the same invisible
   capability gap that caused the `view_image` confusion in 0.13.3.
4. **Upstream is not settled.** [#24429](https://github.com/ggml-org/llama.cpp/issues/24429)
   hung `llama-server` for 300 s with no error, no slot launch, and no ffmpeg
   subprocess. [PR #27596](https://github.com/ggml-org/llama.cpp/pull/27596)
   (merged 2026-08-24, first in **b10608**) fixes the case we hit, but the issue
   is still open and `bug-unconfirmed`. A llama.cpp bump can break
   `input_video` again; it cannot break "send N JPEGs".

The cost of our own extraction, given ffmpeg is already required, is roughly
the frame loop — small next to what it buys.

---

## Evidence

All numbers measured 2026-08-25 on the 16 GB RTX 5060 Ti, llama.cpp b10621
(`c1d0e7a00`), thinking disabled, `--media-path` + `file://`.

**Projector capabilities** (from the mmproj GGUF metadata; `/props` agrees):

| mmproj | vision | audio |
| ------ | ------ | ----- |
| Qwen3.8-27B `mmproj-BF16` (`qwen3vl_merger`) | yes | **no** |
| Gemma 4 E4B `mmproj-F16` (`gemma4v` + `gemma4a`) | yes | **yes** |
| Gemma 4 12B `mmproj-F16` (`gemma4uv` + `gemma4ua`) | yes | **yes** |
| Gemma 4 26B-QAT `mmproj-BF16` (`gemma4v`) | yes | no |
| Gemma 4 31B `mmproj-F16` (`gemma4v`) | yes | no |

Audio is a **projector** property, not a model-family one. Qwen's `/props`
reports `audio: false` and returns a clean HTTP 500 for audio input.

**Token cost by resolution** — the constraint the whole design turns on:

| Clip | Model | Prompt tokens |
| ---- | ----- | ------------- |
| 5 s @ 1920×1088 | Qwen3.8-27B | **22,501** (rejected at 16k ctx) |
| 5 s @ 1920×1088 | Gemma 4 12B | 5,363 |
| 5 s @ 640 px | Qwen3.8-27B | 2,479 |
| 5 s @ 384 px | Qwen3.8-27B | 983 |
| 3.9 s @ 568×320 | Gemma 4 E4B | 1,319 |

**Audio reliability — do not skip this.** Gemma 4 12B, same 5 s WAV, two
requests: alone it reported *"noise, specifically a loud, constant buzzing or
humming sound"*; alongside a video it described *a man giving advice about a
conflict with a friend*. Those cannot both be true. llama.cpp itself warns at
load time that audio input is experimental. This is why audio ships **off by
default and flagged experimental** — see Todo 5.

---

## Design

### Ownership

Two new files, matching the existing `imageTool.ts` / `resultCap.ts` split
between "does the work" and "is the tool".

| Concern | Owner |
| ------- | ----- |
| ffmpeg discovery, probe, frame + audio extraction | `src/tools/videoExtract.ts` |
| `view_video` tool definition + handler | `src/tools/videoTool.ts` |

Both rows get added to `docs/OWNERS.md` under **Tools**.

`videoExtract.ts` must not import `vscode` — it is pure subprocess + fs, which
keeps it unit-testable without the extension host, the same property that makes
`resultCap.ts` easy to test today.

### `src/tools/videoExtract.ts` (~220 LOC)

```ts
export interface VideoProbe {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface ExtractedFrame {
  jpegBase64: string;
  timeSeconds: number;
}

export interface VideoExtraction {
  frames: ExtractedFrame[];
  probe: VideoProbe;
  audioWavBase64?: string;
}

export function resolveFfmpeg(configuredPath?: string): FfmpegTools;
export async function probeVideo(t: FfmpegTools, file: string): Promise<VideoProbe>;
export async function extractFrames(
  t: FfmpegTools, file: string, probe: VideoProbe, opts: VideoOptions,
): Promise<VideoExtraction>;
```

**ffmpeg discovery**, in order, mirroring the Gemma4kids resolver that is known
to work on this machine:

1. `video.ffmpeg_path` from config, if set.
2. `PATH` scan for `ffmpeg`/`ffmpeg.exe` (and `ffprobe` beside it).
3. Windows only: bounded walk of `%LOCALAPPDATA%\Microsoft\WinGet\Packages`
   (cap the walk — Gemma4kids used 2500 dirs).

Not found ⇒ throw a typed `FfmpegMissingError`. **No silent fallback, no
degraded mode.** Per the no-fallbacks rule, the tool surfaces the failure and
names the fix.

**Probe** shells `ffprobe -v error -select_streams v:0 -show_entries
stream=width,height,duration -show_entries format=duration -of json`, plus a
second call for the audio stream presence. Parse JSON, not stderr regex — the
Gemma4kids version scraped `Duration:` out of stderr, which is brittle.

**Frame sampling.** Frame times are computed in TS, then one `ffmpeg -ss <t> -i
<file> -frames:v 1` per frame. Times use the *centre* of each slice, not the
boundary, so a sample never lands on a cut:

```
t_i = duration * ((i + 0.5) / frameCount)     clamped to [0, duration - 0.12]
frameCount = clamp(round(duration / 5), 3, max_frames)
```

Each frame: `-q:v <frame_quality> -update 1 -vf
scale=<frame_max_dimension>:-2:force_original_aspect_ratio=decrease`.

**Spawn discipline.** `spawn` with `shell: false` and an argv array — never a
command string. Every ffmpeg invocation gets an `AbortSignal` and a hard
timeout; a hung ffmpeg must not hang the tool round. stderr is captured and
tail-truncated for the error message. Temp dir via `fs.mkdtemp`, removed in
`finally`.

### `src/tools/videoTool.ts` (~130 LOC)

Follows `makeViewImageTool()` exactly — same permission, same path containment,
same multimodal return shape.

```ts
{
  name: 'view_video',
  description:
    'Load and inspect a short video from the workspace. Returns a small set of '
    + 'still frames sampled across the clip, in time order — you do NOT receive '
    + 'the video itself or its audio. Path is workspace-relative or absolute '
    + 'inside the workspace. Supported: MP4, WebM, MOV, MKV.',
  parameters: {
    path: string,                        // required
    max_frames: integer (optional),      // <= configured cap, never above it
  },
}
```

- `permission: 'read'` — same as `view_image`. No new permission key: this reads
  a workspace file and returns pixels, which is exactly the `read` surface.
  Adding a `video` capability would trip the deny-by-default warning added in
  0.13.3 for every existing config, for no security gain.
- Path resolution reuses `resolveWorkspacePath` + `isPathInside` + `realpath`,
  copied from `imageTool.ts:66-79`. Symlink escape is already handled there;
  do not write a second containment check.
- `max_frames` in args may only *lower* the configured cap, never raise it. The
  model must not be able to talk itself into a 20k-token prompt.

**Return shape** — `MultimodalToolResult` ([ToolRegistry.ts:20-23](src/tools/ToolRegistry.ts#L20-L23))
already carries `ContentPart[]`, so nothing new is needed in the LLM layer:

```ts
content = [
  { type: 'text', text: 'Video clip.mp4 — 5.0s, 1920x1088, 4 frames sampled at 0.6s, 1.9s, 3.1s, 4.4s. Frames are stills; you cannot see motion between them.' },
  { type: 'text', text: 'Frame 1 of 4 — t=0.6s' },
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
  { type: 'text', text: 'Frame 2 of 4 — t=1.9s' },
  ...
]
```

Interleaving a text label before each frame is deliberate: it is what lets the
model reason about ordering and elapsed time rather than treating the set as an
unordered bag of pictures.

### Gating on vision, reusing the 0.13.3 machinery

`view_video` is useless without a projector, exactly like `view_image`. Reuse
the enforcement added in 0.13.3 rather than inventing a second mechanism —
[ModelTurn.ts](src/sidebar/ModelTurn.ts) already builds an `unavailableTools`
map from `deriveStaticCapabilities(model).includes('vision')`
([ConfigResolver.ts:322-329](src/config/ConfigResolver.ts#L322-L329)). Add
`view_video` to that same map with its own message:

> `Error: view_video is not available because the active model "<name>" has no
> vision projector configured (mmproj_path). Do not try to read the video with
> another tool: report that you cannot see it and ask the user to switch to a
> vision-capable model.`

This is the "refusals must name the sanctioned alternative" rule from
`CLAUDE.md`. A bare "unknown tool" is what sent the agent looking for `rm`.

**There are two edits here, not one.** 0.13.3 gates `view_image` in *two*
places, and missing the second is the bug this note exists to prevent:

- [`ModelTurn.ts:170-172`](src/sidebar/ModelTurn.ts#L170-L172) — the
  `unavailableTools` map, which **refuses at dispatch**.
- [`ModelTurn.ts:174-176`](src/sidebar/ModelTurn.ts#L174-L176) — the
  `advertisedDefinitions` filter, which **withholds the definition** and
  currently hard-codes `definition.function.name !== 'view_image'`.

Adding only the first advertises a tool that always refuses. Since the list is
about to have two entries, replace the inline name comparison with a
`VISION_ONLY_TOOLS` set so a third vision tool cannot half-land the same way.

### Result capping

Frames are base64 in `content`, not in `text`, so `capResultText` does not
apply and must not be bolted on. The bound is `max_frames` ×
`frame_max_dimension`, enforced before extraction. Add a hard byte ceiling on
the summed base64 (mirroring `MAX_VIEW_IMAGE_BYTES` at
[imageTool.ts:10](src/tools/imageTool.ts#L10)) as a backstop, and fail with a
clear message rather than truncating a frame set into incoherence.

---

## Config

New optional top-level `video:` block in `src/config/schema.ts`, defaults
applied in `ConfigResolver`. Typed and Zod-validated, following the
`max_result_chars` precedent at [schema.ts:267](src/config/schema.ts#L267):

```yaml
video:
  max_duration_seconds: 30      # reject longer clips early, with a clear message
  max_frames: 8                 # hard cap; tool arg may lower, never raise
  frame_max_dimension: 640      # THE context knob: 640 ≈ 2.5k tok, 384 ≈ 1k on Qwen
  frame_quality: 3              # ffmpeg -q:v, 2 (best) .. 5
  extract_audio: false          # EXPERIMENTAL — see Todo 5
  ffmpeg_path: ""               # empty = resolve from PATH / WinGet
```

- Every field optional; the whole block optional. Absent block ⇒ documented
  defaults above, which is the only place they are written down in code.
- **Top-level only in v1 — not per-model.** The earlier draft claimed this
  merges through the `defaults < group < model < profile` chain. It cannot.
  That chain is `ProfileConfig` ([types.ts:81-92](src/config/types.ts#L81-L92)),
  resolved per turn by `resolveRequestModel()`; tools are registered once at
  activation and a handler never sees the resolved model —
  `ToolHandlerContext` carries `beforeMutate`/`abortSignal`/`conversationId`
  and nothing else. Per-model tuning would mean widening `ProfileConfig`,
  `ModelConfig`, the merge, *and* threading the active model into every tool
  handler. That is a plumbing change, not a config block, and it is not worth
  it before the tool has shipped once.
  `video:` therefore sits beside `search:` and `embeddings:` on `ForgeConfig`,
  read through the `getConfig()` already passed to `registerAllTools`
  ([extension.ts:128-136](src/extension.ts#L128-L136)). Read it **at call
  time**, not at registration, so a config reload takes effect.
  Qwen and the 12B do have different token appetites, so if per-model tuning
  proves necessary, the follow-up is `ToolHandlerContext.model` — one addition
  that pays for several future tools, not a special case for this one.
- **No raw `extra_ffmpeg_args` in v1.** `extra_llama_server_args` feeds a server
  the user already trusts; raw ffmpeg argv feeds a subprocess that reads and
  writes arbitrary paths. If a real case appears that the typed fields cannot
  express, add it then, documented as unvalidated, with typed fields winning.
- Add the block, commented, to `config/config.example.yaml` with the measured
  token costs in the comment — that table is the reason the defaults are what
  they are, and a user retuning `frame_max_dimension` needs it.

---

## Testing seam — decide this before Todo 1

Every "Exit" below said *"a probe of a real fixture clip"*. Taken literally that
breaks `npm run ci` on any machine without ffmpeg, and commits a binary video to
the repo. Neither is acceptable, so the module is built around an injectable
runner from the first line:

```ts
export type RunFfmpeg = (
  bin: string, argv: string[], opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;
```

- Default is the real `spawn`-based implementation; every exported function
  takes an optional `run: RunFfmpeg` last parameter.
- **Unit tests inject a fake runner** and assert on the *argv* — that the frame
  times are centre-of-slice, that `scale=` carries the configured dimension,
  that `-q:v` is passed, that the temp dir is cleaned in `finally`, that an
  abort propagates. Argv assertions are the real contract here and they need no
  ffmpeg at all.
- One optional integration test uses real ffmpeg and a real clip, `describe.skip`
  unless both `resolveFfmpeg()` succeeds and `FORGE_VIDEO_FIXTURE` points at a
  file. It never runs in CI and never blocks a build.

Read the exit criteria below with this substitution in mind.

---

## Implementation order

Each step builds and passes `npm run ci` on its own. Do not skip ahead.

### Todo 1 — `videoExtract.ts`, probe + discovery only ✅ DONE

Discovery, `probeVideo`, `FfmpegMissingError`. No frames yet.
**Exit:** unit tests for the PATH/WinGet/config resolution order and for a
probe of a real fixture clip; missing-ffmpeg throws the typed error.

### Todo 2 — frame extraction ✅ DONE

`extractFrames`, centre-of-slice timing, downscale, temp-dir cleanup, per-call
timeout + abort.
**Exit:** given a fixture clip, returns N ordered frames with correct
timestamps; frame count honours `max_frames`; temp dir gone after both success
and failure; an aborted call kills the ffmpeg child.

### Todo 3 — `videoTool.ts` + registration ✅ DONE

Tool definition, path containment, `MultimodalToolResult` assembly with
interleaved labels, one line in `registerAllTools.ts` beside
[`makeViewImageTool()`](src/tools/registerAllTools.ts#L82).

`getConfig` is **optional** on the `registerAllTools` signature and the unit
harness only passes it when testing delegation
([RegisterAllTools.test.ts:100-108](test/unit/RegisterAllTools.test.ts#L100-L108)).
`view_video` must therefore register unconditionally and fall back to the
documented defaults when `getConfig` is absent — not be gated behind it, which
would silently drop the tool from the catalog test.
**Exit:** integration test dispatches `view_video` on a fixture and asserts the
content array shape (label/image alternation, frame count, ordering); a path
outside the workspace is refused; a non-video file is refused by probe.

### Todo 4 — vision gating + config block ✅ DONE

`unavailableTools` entry, `video:` schema + defaults + example config, OWNERS
rows.
**Exit:** unit test that a model without `mmproj_path` gets the refusal message
instead of execution; config test for defaults and per-model override.

### Todo 5 — audio, experimental, off by default — NOT STARTED

Only after 1–4 are green. `extract_audio: true` adds a 16 kHz mono WAV as an
`input_audio` part **and** a blunt caveat line in the summary text.

**This is not a small addition, and the earlier draft made it sound like one.**
`ContentPart` is `ContentPartText | ContentPartImage`
([types.ts:3-11](src/llm/types.ts#L3-L11)) — there is no audio variant. Adding
one widens a union consumed by seven files (`OllamaNativeClient`,
`CliChatRunner`, `ConversationOps`, `sessionTypes`, `ToolRegistry`,
`imageTool`, `types`), including transcript persistence and the webview render
path. Separately, `Capability` is the closed union
`'tool-call' | 'vision' | 'long-context'`
([ConfigResolver.ts:313](src/config/ConfigResolver.ts#L313)) with a matching
Zod enum, so gating on a projector's audio tower means adding an `audio`
capability there too — and audio is a *projector* property that
`deriveStaticCapabilities` has no way to derive from `mmproj_path` alone, so it
would have to be declared explicitly per model.

Todo 5 is therefore its own plan, not a tail on this one. Todos 1–4 ship
`view_video` complete and useful without it.

**Required decision gate before this ships:** the 12B gave two irreconcilable
descriptions of the same WAV. Before enabling this by default — or at all —
run clips whose audio content is known and confirm the model describes them
correctly. If it does not, keep the flag but document it as unreliable, or drop
it. Do not let a confabulated transcript reach the agent as fact.

Also note `input_audio` is not supported by every backend; on Qwen it is a hard
HTTP 500. The tool must check the projector's audio capability the same way it
checks vision, and simply omit the audio part when unavailable rather than
erroring the whole call.

---

## What was built (2026-08-25)

Todos 1-4 shipped; `npm run ci` green (1040 passed, 3 skipped). Deviations from
the plan as written, all decided during implementation:

- **Discovery split into its own file.** `videoExtract.ts` reached 443 lines,
  past the 350 soft threshold, with a clean seam between "where is ffmpeg" and
  "drive ffmpeg". Discovery now lives in `src/tools/ffmpegLocate.ts` and is
  re-exported from `videoExtract.ts`, so callers still have one import.
- **`spawnAndWait` extracted to `src/util/processSpawn.ts`.** It was exactly the
  primitive needed, but `execHelpers.ts` imports `vscode`, which would have
  broken the vscode-free rule. Moved rather than duplicated; `execHelpers`
  re-exports it and every existing importer is untouched.
- **Scale computed in TypeScript, not by an ffmpeg expression.** The planned
  `scale=N:-2:force_original_aspect_ratio=decrease` is self-contradictory
  (`-2` and `force_original_aspect_ratio` fight each other) and would upscale a
  small source. `computeScale()` uses the probed dimensions, emits `scale=W:H`,
  and omits `-vf` entirely when the clip already fits.
- **`video:` config landed in Todo 3, not 4.** The tool needs it to exist.
- **`-nostdin` on every ffmpeg call.** The upstream Windows hang was an
  unclosed stdin pipe; Forge does not reproduce that shape.
- **Live ffmpeg test added** at `test/integration/videoExtractLive.test.ts`,
  skipped unless `FORGE_VIDEO_FIXTURE` is set and ffmpeg resolves. Verified
  against a real 9.0 s 1920x1088 Ssuno clip: 3 frames, downscaled to 640x362,
  valid JPEG SOI markers.

Tests: 41 in `videoExtract.test.ts`, 18 in `VideoTool.test.ts`, 2 gated live.

---

## Out of scope for v1

- Webview drag-and-drop of video files. This is a *tool*, not an attachment UI.
- Frame export / "save these frames" tooling. Gemma4kids' own note says
  `save_video_frame` was unreliable because the model described frames instead
  of calling the tool — that is a separate tool-calling reliability problem and
  it should not ride along with extraction.
- llama.cpp `input_video`. Reassess if extraction proves inadequate; the config
  shape above would not have to change.
- Audio transcription of vision-only models via a second model. Real, and the
  only route to sound on Qwen, but it needs model switching and belongs in its
  own plan.

---

## Risks

- **ffmpeg absent on a user machine.** Mitigated by the typed error naming the
  fix. This is a new external dependency for Forge and must be documented in
  README setup, not discovered at first call.
- **Token cost surprises the user.** A 30 s clip at 8 frames × 640 px is roughly
  5k tokens. The summary text states the frame count and the clip length so the
  cost is visible in the transcript, and `max_duration_seconds` rejects the
  pathological case early.
- **Stills are not motion.** The model can and will over-claim about action
  between frames. The summary line says so explicitly; that wording is load
  bearing, not decoration.
- **Windows spawn quoting.** Paths on `N:` with spaces are the norm here. argv
  array + `shell: false` throughout; no string concatenation into a command.
