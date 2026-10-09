# Behaviour fixes from the 2026-10-09 bench review

Source: the forge-bench review `FORGE-BEHAVIOUR-2026-10-09.md` (harness-bench-grader). Every item below is a
decision the user made on 2026-10-09, one finding at a time. This plan turns them into four packages that four
agents implement in parallel, each in its own git worktree, then a reviewer merges them to `main` one at a time.

Out of scope: finding 14 (announced-but-not-acted replies). It is a measurement, done last, by the reviewer.

## Ground rules for every package

- Read `CLAUDE.md` first. Its Hard Stops, the 500-line cap, Single Point of Truth and "No Fallbacks" all apply.
- Touch only the files your package owns (table below). If you need a change in a file another package owns, stop
  and say so in your final report instead of editing it.
- Do **not** edit `CHANGES.md`, `docs/OWNERS.md`, `CLAUDE.md` or `FORGE.md`. The reviewer writes those at merge.
  List in your final report every new module (for OWNERS) and every user-visible change (for CHANGES).
- Every exported function needs a caller in the same package. Every behaviour change needs a test.
- `npm run ci` must pass in your worktree before you report done. Tests never spawn bare `bash`
  (use `TEST_BASH` from `test/support/bash.ts`).
- Write files with LF line endings.
- Commit on your worktree branch with a clear message. Never push, never tag, never touch `main`. The reviewer
  squash-merges each package onto `main` with the project's attribution.
- Several files are at or near the 500-line cap (`ToolDispatch.ts` 500, `ModelTurn.ts` 498, `renderEngine.ts` 439,
  `uxTools.ts` 448, `BackgroundExecutionManager.ts` 441, `extension.ts` 440). New logic goes in a new module; the
  existing file gets the call site only.

## Package ownership

| Package | Findings | Owns (create or edit) |
|---|---|---|
| A — dispatch and small tool fixes | 1, 1b, 13, 17, 9, 10 (`open_file`) | `src/sidebar/ToolDispatch.ts`, `src/tools/lazyToolGroups.ts`, `src/tools/toolGroupTools.ts`, `src/sidebar/visionGate.ts`, `src/sidebar/ModelTurn.ts` (vision lines only), `src/sidebar/visionGate.ts`'s test, `src/tools/imageTool.ts`, `src/tools/videoTool.ts`, `src/tools/browser/browserActionTools.ts`, `src/tools/desktop/desktopTools.ts`, `src/tools/editFileTool.ts`, `write_file`'s description in `src/tools/builtinTools.ts`, `src/tools/uxTools.ts`, `src/util/atomicWrite.ts`, their tests |
| B — stalls and background processes | 15, 10 | `src/llm/streamWatchdog.ts`, `src/llm/OpenAIClient.ts`, `src/llm/OllamaNativeClient.ts` (logging only), new `src/llm/stallProbe.ts`, `src/sidebar/SessionLogger.ts` (`logTurnError` only), `src/tools/BackgroundExecutionManager.ts`, new `src/tools/backgroundRegistry.ts`, `src/sidebar/backgroundExitNotice.ts`, `src/extension.ts` (activation reap + `deactivate` only), their tests |
| C — preview and shader check | 16, 2, 8 | everything under `src/tools/renderHtml/` (new modules welcome there), `src/tools/renderHtmlToImageTool.ts`, `test/integration/RenderHtmlPreviewLive.test.ts`, their tests |
| D — tool usage measurement | 18 | `src/jobs/jobSchema.ts` (new check kind), `src/jobs/checks/` (new check), `src/jobs/checks/runCheck.ts`, new `src/sessions/toolUsage*.ts`, `scripts/tool-visibility-audit.mjs`, `test/unit/ToolVisibilityAudit.test.ts`, their tests |

Known seams:

- B and D may both need a line in `src/extension.ts`. Each keeps its edit to one clearly separate block; the
  reviewer resolves the merge.
- B3's end-of-turn list of running executions needs a call where a turn completes. If that point is in an A-owned
  file (`ModelTurn.ts`, `ToolDispatch.ts`), B writes the function in its own module, tests it, and reports the
  one-line call for the reviewer to add at merge. Do not edit the A-owned file.

---

## Package A — dispatch and small tool fixes

### A1. Remove the lazy-group dispatch gate (finding 1)

Today `ToolDispatch.ts` (~251-268) refuses any grouped tool whose group was not loaded with `load_tool_group`,
even when the tool was in the request's `tools` array. Since 1aaec4e made `files`, `background` and `media`
eager by default, every refusal it made was for an offered tool (7 in the session logs, ~7 bench rounds).

- Delete the gate block (`lazyGroup && convId && !isLazyGroupActive(...)` → "call load_tool_group first").
- Delete the `computer_use` non-vision refusal above it, and the matching throw in `toolGroupTools.ts` (~118).
- `lazyToolGroups.ts` keeps controlling what is **advertised**. Its header already says tools "stay registered
  and dispatchable".
- Unchanged: permissions, the confirmation gate, the shell policy, the tool budget, unknown-tool errors and their
  "did you mean" / "group is unloaded" hints in `unknownToolResult`.
- Clean up imports that become unused.

### A2. Non-vision models: advertise, then refuse in the tool (finding 1, second decision)

Today the B8 vision gate (`visionGate.ts`) both **hides** the `requiresVision` tools (`view_image`, `view_video`,
`browser_screenshot`, `desktop_capture`) from non-vision models and refuses them at dispatch.
`hiddenLazyToolNames` also hides `computer_use` and makes `media` eager only on vision models.

The decision: neither `media` nor `computer_use` is hidden or blocked by model type.

- `hiddenLazyToolNames`: `media` is eager by default on every model; `computer_use` is an ordinary lazy group on
  every model (loadable with `load_tool_group`). Drop the `isVisionModel` parameter if nothing else needs it.
- Advertise the `requiresVision` tools on non-vision models too. Keep refusing them at dispatch with their
  existing `requiresVision` message (the refusal stays; only the hiding goes). In `ModelTurn.ts` the advertise
  filter must stop dropping vision refusals while still dropping the unattended refusals
  (`withUnattendedRefusals`). Keep one source of truth: the drift test in `test/unit/visionGate.test.ts` is
  rewritten to assert the new contract, not deleted.
- Each `requiresVision` tool's description says, in a short clause, that it needs a vision model and what to do
  without one (e.g. "Needs a vision model; on a text-only model use render_html_to_image's console output
  instead"). The refusal message says the same.
- Go through every other tool in `media` and `computer_use` and decide, tool by tool, whether it returns an image
  to the model. Record the list in your final report. Tools that return no image (`send_file`, `generate_image`
  writing to disk, `browser_click`, …) keep working on non-vision models. Note: image parts are already stripped
  from the model-facing copy on non-vision models (`prepareModelTurnMessages` → `stripImageParts`), so a tool that
  returns an image there loses the image, not the turn.
- `desktop_*` coordinate actions require a `capture_id` from `desktop_capture`; on a non-vision model they fail on
  that. Make sure that error names the reason.

### A3. `write_file` says large files go in one call (finding 13)

Measured: 0 write cut-offs in 525 Strata `write_file` calls, 16 of them 30-74 KB in one call. Models still split
pages into part-files and join them with the shell, and one run delivered a stale join.

- Add to `write_file`'s description: write a whole file in one call even when it is large; do not split it into
  part-files to join with the shell; if a call is cut off, Forge says so and gives the size for the retry.
- The last claim is true today: `src/agent/truncationRecovery.ts` answers a cut-off write with a hard character
  limit for the next call and tells the model to `append_file` the rest. Keep the description consistent with it.
- Keep it short: this description ships on every request.

### A4. `edit_file` cap 40 → 200 (finding 17)

A 41-edit call (66 KB, 880 s to generate) was refused whole. No backend enforces `maxItems`.

- `MAX_EDITS_PER_CALL = 200`. The `edits` description states "up to 200 edits". Keep the batch all-or-nothing.
- Update the cap test.

### A5. `open_file` opens binary files (finding 10)

`open_file` on a PNG fails: `openTextDocument` reports "File seems to be binary" (`uxTools.ts` ~126).

- Binary files (decide by extension list or a sniff; say which in the report) open with
  `vscode.commands.executeCommand('vscode.open', uri)`. Text files are unchanged. Add a test.

### A6. Longer rename retry (finding 9)

`renameContendedSync` retries `EPERM/EBUSY/EACCES` 6 times with 5-25 ms backoff, ~75 ms in total. Under the full
CI suite (and plausibly two windows) contention lasts longer: `agentTask.test.ts` flaked with `EPERM rename`.

- Raise the total budget to about 2-3 s, with growing backoff (cap each sleep, e.g. 250 ms).
- A genuine non-contention error still throws at once; contention past the budget still throws the last error.
- Note: `sleepSync` blocks the extension host thread. This is acceptable only because it happens under contention;
  say so in a comment. Do not convert the module to async in this package.
- The flaky test stays unchanged. Add a unit test for the budget with an injected `rename` and clock.

### Acceptance criteria — A

- A contract test: for every grouped tool, on vision and non-vision models, with and without
  `tool_groups.eager` and a `tools` allowlist, **advertised ⇒ dispatch does not refuse it for group reasons**.
- A test that each `requiresVision` tool is advertised on a non-vision model and refuses with its message.
- A test that `load_tool_group computer_use` works on a non-vision model.
- `edit_file` with 200 edits is accepted, 201 is refused; the description contains "200".
- `npm run ci` green; `ToolDispatch.ts` under the 500-line cap without new splitting.

---

## Package B — stalls and background processes

### B1. Probe before giving up on a silent stream (finding 15)

`StreamWatchdog` ends a stream after 120 s with no bytes (600 s before the first byte). On Strata the cause was
server-side (held array arguments; patched locally, upstream issue #1666), but llama.cpp stalls are unexplained,
and any server that holds output trips it.

- At the 120 s mark, before cancelling, ask the server whether it is still generating. New module
  `src/llm/stallProbe.ts`, called from the watchdog through an optional async callback (the watchdog stays
  provider-agnostic):
  - only for loopback base URLs (`localhost`, `127.0.0.1`, `::1`); cloud providers behave as today;
  - `GET {origin}/slots`: any slot with `is_processing: true` → alive;
  - else `GET {origin}/v1/status` (Strata): `busy: true` **and** `generated` higher on a second read ~2 s later →
    alive;
  - never read `phase` (it keeps its last value after a request ends);
  - each probe request has a short timeout (≤ 5 s) and its own `AbortController`; a probe error counts as "not
    alive".
- Alive → keep waiting and probe again at the next 120 s of silence, up to a hard ceiling of 15 minutes of total
  silence (`STREAM_STALL_CEILING_MS = 900_000`, exported from `streamWatchdog.ts`). Not alive, or the ceiling →
  end the turn exactly as today.
- Known limit, write it in a comment: with `--parallel > 1` an `is_processing` slot may belong to another
  conversation. The ceiling bounds the cost.
- The watchdog's interval and stop logic must not leak a probe that resolves after `stop()`.

### B2. Log what a stall looked like (finding 15)

- The stall error carries: the kind of the last delta (`reasoning` | `content` | `tool_args` | `none`), the time
  it arrived (ms since request start), the idle time, and the probe answer (`alive` / `not-alive` / `error: …` /
  `skipped: not loopback`).
- `SessionLogger.logTurnError` writes them as a structured `stall` field on the `turn_error` row (optional, only
  for stalls). Ollama's client records the last delta kind too (no probe).

### B3. Background executions do not outlive Forge (finding 10)

A `python -m http.server` started with background exec kept listening after the bench window was closed and
relaunched twice. `backgroundExecutionManager.dispose()` is registered in `context.subscriptions`
(`extension.ts` ~411), but it fires `terminateCliProcessTree` without awaiting it, and a host that is killed
rather than deactivated never runs it.

- First, find out which happened (un-awaited termination vs host killed); write the answer in your report.
- `deactivate()` awaits termination of every running background execution, bounded (e.g. 5 s total).
- For the killed-host case: a registry of running background executions in `src/tools/backgroundRegistry.ts`,
  one file per execution under `~/.forge/background-execs/` (see the ledger), written when one starts and
  removed when it exits or is stopped. Each entry records the PID, the process start time, the command line, the
  owner extension-host PID and that host's start time.
- On activation, reap entries whose owner host is dead: kill the process tree **only if** a process with that PID
  still exists **and** its start time matches the entry (never kill a reused PID). Then drop the entry. Log each
  kill. This follows the rule "kill only verified PIDs".
- While the window is open, background executions keep running across turns (no change).
- At the end of a turn, the final message lists background executions from that conversation that are still
  running (id, command, how long), so the user knows something is still listening.

### Acceptance criteria — B

- Unit tests with a fake clock and a fake probe: alive keeps the stream open past 120 s; not-alive, probe error
  and the 15-min ceiling end it; non-loopback URLs are never probed; `phase` is never read.
- A `turn_error` row from a stall carries the `stall` field.
- Background registry: start adds an entry, exit and stop remove it; a reap kills only an entry whose PID and start
  time both match, and never one whose owner host is alive.
- `deactivate()` awaits termination (test with a fake manager).
- `npm run ci` green.

---

## Package C — preview on a secure page, and a shader check

### C1. Preview serves the page at a routed `https://` URL (finding 16)

WebGPU exists only in a secure context. Preview loads pages with `page.setContent`, whose `about:blank` is not
one, so `navigator.gpu` is undefined and a WebGPU page cannot be previewed at all. Tested 2026-10-09 with Chrome
and Edge 154: the same page served at a routed `https://` URL gets an adapter.

- Serve the preview page at a fixed synthetic origin under the reserved `.invalid` TLD (e.g.
  `https://forge-preview.invalid/`), fulfilled host-side from the route handler **before** the public-fetch path.
  It never reaches DNS (and Chrome resolves nothing anyway: `--host-resolver-rules=MAP * ~NOTFOUND`).
- Any other request to that origin (relative URLs in the page) is refused and listed in "Requests that did not
  load", with a reason saying preview serves only the page itself. Do not serve workspace files.
- Preview uses the real GPU (user decision, 2026-10-09): no software-adapter flags. The 2026-10-09 test found the
  default WebGPU adapter is the NVIDIA GPU the model server uses. The contention lasts only while one preview's
  browser is open (it closes after every call). The tool description says preview may briefly slow a local model
  on the same GPU.
- Everything else is unchanged: other origins still go through `guardedFetchResource`, WebSockets are closed,
  WebRTC UDP is disabled. `file://` is never used.
- `RenderHtmlPreviewLive.test.ts` must stay green (zero TCP connections and zero UDP datagrams to a local
  listener). Add a live test that a page using `navigator.gpu` sees it defined in preview, skipped where no
  Chrome/Edge channel is installed.
- The reviewer updates the CLAUDE.md paragraph that says "`setContent` only, so no `file://` origin". Put the
  new wording you propose in your report.

### C2. Shader-check mode (finding 16)

jelly-press's page never drew: WGSL rejected `let ref = …` ("'ref' is a reserved keyword"), and a second error
(`textureSampleLevel` on a depth texture with a comparison sampler) sat behind it. The model had no way to check
WGSL without a browser and was told not to open one.

- A new mode of `render_html_to_image` (no new tool), in new modules under `src/tools/renderHtml/` (e.g.
  `shaderExtract.ts` for finding shaders and mapping lines, `shaderCheck.ts` for compiling); `renderEngine.ts` is
  at 439 lines and keeps only shared launch code: `mode: "shader_check"` with `path` to a workspace file.
  - `.wgsl` → the whole file is one WGSL shader. `.glsl`, `.vert`, `.frag` → GLSL (stage from the extension, or
    from `gl_Position` / fragment outputs).
  - `.js`, `.mjs`, `.ts`, `.html` → extract candidate shaders: template literals and strings containing WGSL entry
    attributes (`@vertex`, `@fragment`, `@compute`) or GLSL `void main(`, plus `<script type="x-shader/...">`
    blocks. A template literal with `${…}` interpolation is reported as skipped, with its line, not guessed at.
  - Report every compiler message with its line and column **mapped back to the file**, plus a one-line count per
    shader. "No shaders found" is an explicit result, not an empty success.
- How it compiles: headless system Chrome/Edge (the channel already configured for this tool), a Forge-owned page
  fulfilled at the synthetic `https://` origin, page JavaScript on (it is Forge's own script), every other request
  aborted, `--host-resolver-rules=MAP * ~NOTFOUND`. The workspace file is read by the host and passed in as data;
  the browser never loads it.
  - WGSL: `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader` (software adapter,
    no GPU, no VRAM taken from the model server). Never `--use-angle=swiftshader`: with it, no adapter is found
    (tested). `device.createShaderModule` + `getCompilationInfo()`.
  - GLSL: WebGL2 `compileShader` + `getShaderInfoLog` in the same page.
- The description says plainly: it compiles shader text only, opens no page from the workspace, uses no network
  and no GPU. That lets the model use it under a prompt that says "do not open a browser".
- No new npm dependency.

### C3. Frames and wait up to 30 s (finding 2)

- `MAX_PREVIEW_WAIT_MS` 15 000 → 30 000. `frames` and `wait_ms` share it, so both move. Both descriptions state
  "0–30000 ms". Make sure the tool's overall timeout still leaves room for a 30 s frame.

### C4. Accept Playwright key codes (finding 8)

- Accept `KeyA`…`KeyZ` (map to the lowercase letter), `Digit0`…`Digit9` (map to the digit), and the arrow/edit
  names already listed. Pressing `w` already sends code `KeyW`; say so in a comment.
- The error for an unsupported key lists what is accepted, instead of "must be a supported Playwright key name".

### Acceptance criteria — C

- A fixture with the `let ref` WGSL inside a JS template literal → shader check reports
  `'ref' is a reserved keyword` at the right file line and column. A clean `.wgsl` → zero messages. A broken GLSL
  fragment shader → its error with the right line. Interpolated literal → reported as skipped.
- Shader check makes zero network connections (extend the live-socket walls to cover it).
- Preview: `navigator.gpu` defined; relative URL refused and listed; existing preview tests green.
- `frames: [30000]` accepted, `30001` refused with the range; `KeyW` accepted.
- `npm run ci` green; every `renderHtml/` file under 500 lines.

---

## Package D — daily tool-usage measurement (finding 18)

The lazy-group split rests on a one-time audit (2026-09-30, refreshed 10-07). Usage will shift. Measure it
continuously, locally, with no model and no network.

- A new job check kind `tool_usage` (`jobSchema.ts`, `src/jobs/checks/`), runnable on the existing `daily`
  schedule. Forge does not create the job on its own; the user (or the reviewer, for this install) creates it
  with `manage_jobs`.
- The counting logic moves out of `scripts/tool-visibility-audit.mjs` into a TypeScript module under
  `src/sessions/`, reusing `src/sessions/sessionLogRows.ts` (the existing deduplicating reader) instead of the
  script's mirror copy. The script then either calls the built module or is removed; there must be exactly one
  implementation (CLAUDE.md "No duplicate implementations"). Keep `ToolVisibilityAudit.test.ts` meaningful by
  pointing it at the new module.
- Each run writes one JSON file for the previous complete day (local time) to `~/.forge/tool-usage/YYYY-MM-DD.json`
  via `writeFileAtomicSync`, recomputed from scratch, so a re-run overwrites with the same result:
  - per tool: calls, sessions, failures, and whether it was offered when called;
  - per lazy group: how many times `load_tool_group` loaded it;
  - shell workarounds for hidden tools (the script's existing rules);
  - all split by `forge_version` (from `session_start`) and model.
- A missed day (machine off) is filled on the next run: compute every missing day back to the oldest session file,
  capped at 30 days.
- The check's `observation` is the last date written and its `summary` a one-line count. It always returns
  `changed: false`, so the job's required `on_change` (`notify`) never fires: no messages, files only. Say this in
  a comment, since a check that writes files is new.
- No telemetry: nothing leaves the machine.

### Acceptance criteria — D

- Fixture session logs (including a replayed duplicate stretch and a `cursor` row) produce the expected day file.
- Re-running the same day gives a byte-identical file. A crash mid-write leaves the previous file intact.
- Missing days are back-filled, at most 30.
- The audit script and the job agree on the same fixtures, or the script is gone.
- `npm run ci` green.

---

## State × lifecycle ledger

Packages A and C write no durable state (C1 and C2 keep everything in an ephemeral browser profile).

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| B3 registry file `~/.forge/background-execs/<hostPid>-<execId>.json` (one file per running exec, so two windows never write the same file) | When a background exec starts, before `start` returns | When the exec exits, is stopped, or is reaped | Not pausable; disabling background exec means no new files, existing ones are still reaped | `writeFileAtomicSync`: whole file or none; an unparseable file is logged and deleted, never silently skipped, and its process is not killed (nothing to verify it against) | The next activation of any Forge window reaps files whose owner host is dead (PID gone, or PID alive with a different start time): kills the exec's tree only if its PID exists with the recorded start time, then deletes the file | None needed: a file lives only as long as its process; a reap of a dead PID just deletes it |
| D `~/.forge/tool-usage/YYYY-MM-DD.json` | The `tool_usage` check writes the previous complete day, plus up to 30 missing days | Never by Forge; the user deletes files | Pausing or deleting the job stops new files; existing files stay | `writeFileAtomicSync`: the previous file or no file, never a half file | No in-flight state: the next run recomputes the day from the session logs | None; ~5 KB per day, stated in the check's description |
| D `tool_usage` job entry in the job store | Created by the user or reviewer with `manage_jobs` | `manage_jobs` delete | `manage_jobs` pause; the check does not run | Existing JobStore guarantees (atomic patch) | Existing job lease: another window's scheduler takes over | Existing job behaviour; no expiry |

CI-enforced row (cheapest): **B3 entry create/delete**. A unit test starts a fake background exec, asserts the
registry has its entry, ends it by exit and by stop, and asserts the entry is gone both times. A later change that
adds a new way for an exec to end without removing its entry fails this test.

## Merge order and review

1. A (it changes dispatch, which every later test runs through).
2. C.
3. B.
4. D.

For each: the reviewer reads the whole diff against this plan, runs `npm run ci` in the worktree, merges to
`main`, runs `npm run ci` again, and writes the CHANGES/OWNERS entries. After all four: `npm run package`, a live
test of the VSIX on Strata, then the reruns of the failed bench items.

## Acceptance criteria

- Every per-package criterion above holds on `main` after the merge.
- `npm run ci` and `npm run package` are green on `main`.
- `CHANGES.md` (0.17.0 section) and `docs/OWNERS.md` cover every user-visible change and new module.
- CLAUDE.md's render-preview paragraph matches the new secure-origin preview and the shader-check mode.
- The live VSIX test on Strata shows: an offered `apply_line_edits` call is not refused; a WebGPU page previews;
  a shader check catches `ref`.
- Nothing is pushed or tagged without the user.
