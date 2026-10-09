# Tool follow-up fixes (bench audit 2026-10-09)

Source: the audit of the six forge-bench sessions from 2026-10-09 (jelly-press `5dd2e479`,
pelican-joust `9e9e82dc` / `acb292bd`, large-edit `ba509707`, matchbox `ec50524a`,
jelly-press `ecf9437e`; JSONL in `~/.forge/sessions/`). Every item below is a case where a
Forge tool either refused input it could understand, said something misleading, or lost a
turn the loop could have saved. None of them is a prompt change.

Rules for this work: CLAUDE.md applies in full (500-LOC cap, single owner per concern,
refusals name the alternative, no substring guards, Zod at boundaries, tests never spawn
WSL bash). One commit per numbered item, each after a green `npm run ci`. No push, no tag.

## 1. A stream that ends mid tool call is a truncation, not a turn error

Evidence: `ba509707` row 27, `turn_error` "Stream ended with incomplete tool call arguments
for edit_file." The turn died; the model never got a retry.

Cause: `src/llm/OpenAIClient.ts:~416` and `src/llm/OllamaNativeClient.ts:~455` raise a plain
`Error` when the stream ends with unparseable accumulated arguments. `asTruncation()` in
`src/agent/truncationRecovery.ts` only recognises `ToolCallTruncatedError` or the llama-server
500 wording, so the recovery path (hard character ceiling for the next call) never runs.

Fix: raise `ToolCallTruncatedError` (from `src/llm/ToolCallTruncatedError.ts`) there, with the
tool name and the partial argument length, so the existing recovery handles it. Keep the
`watchdog.stalled` branch unchanged (a stall is not a truncation). Per CLAUDE.md "Output
Budget & Tool-Call Truncation": it must not advance `ToolFailureTracker`.

Review note (added after the plan was sent): the cause of the stream end is not known. The
stream ended without a terminal frame after ~7 minutes of generation, so it may be a server
drop, not a length cut. The recovery text must therefore not claim the output limit was hit
(`finishReason` stays null); it should say the call was cut off before it was complete and ask
for a smaller one.

Also check the recovery text names a tool-appropriate shape for `edit_file`: fewer edits per
call (the model had just been refused at "at most 40 edits per call"), not only "write in
chunks", which is `write_file` advice.

## 2. apply_line_edits refuses input it could understand

Evidence (all `Error: apply_line_edits: ...`): 2x `operations` as a string, 1x `missing
start_line`, 1x `missing end_line`, 2x `expected_lines must contain N lines`, 1x `operations
must be ordered and non-overlapping`, 1x stale.

a. **String-wrapped `operations` was not coerced**, although `coerceToolArgs` in
   `src/tools/argCoercion.ts` handles a JSON array in a string. Find out why for these two
   calls (raw args are in `5dd2e479` and `9e9e82dc`; search for `"operations":"[`): is the
   coercion not reached for this tool, or is the string not valid JSON? Fix the actual cause.
   If the string is not valid JSON, keep refusing, but say what made it invalid (the
   `JSON.parse` position), not "resend as a bare array" — the model already thinks it did.
b. **Missing one bound**: when `expected_lines` is present and exactly one of
   `start_line` / `end_line` is given, derive the other from `expected_lines.length`. The
   `expected_lines` check still guards against a wrong guess.
c. **Out-of-order operations**: sort by `start_line` before validating. Refuse only real
   overlaps, and name the two operations and their ranges. First confirm in
   `structuredEditTool.ts` that every operation's line numbers refer to the file as it was
   before the call (not after earlier operations); sorting is only safe then. If they are
   applied sequentially, skip this sub-item and record why.
d. **Line-count mismatch** ("expected_lines must contain 4 lines"): keep refusing, and include
   the file's current lines for that range (numbered, capped like the edit_file miss region)
   so the retry does not need a `read_file` round.

## 3. Preview may not see WebGPU errors

Evidence: in `5dd2e479`, previews between 20:23 and 20:27 reported zero page errors and zero
console lines while the page's WGSL did not compile (later found by shader_check at 271:21).

First prove it: a fixture page whose WGSL has a type error, rendered in preview mode on the
real GPU. If preview reports nothing, add capture in `src/tools/renderHtml/` (page init
script): wrap `GPUAdapter.prototype.requestDevice` so each device gets an `uncapturederror`
listener, and wrap `GPUDevice.prototype.createShaderModule` to read `getCompilationInfo()` and
report error messages with line:column. Report them in the same errors list as page errors,
prefixed `webgpu:`. If preview already reports them, write the finding in this file and
drop the change.

Result (2026-10-09): the live Chrome test failed as expected; preview returned `Page errors:
none.` and no console output for the invalid WGSL. Added the planned WebGPU init capture and
enabled the regression test, which requires a `webgpu: line:column:` error in preview output.

## 4. Preview errors are not deduplicated

Evidence: `5dd2e479`, 363 identical `drawIndexed` errors; the list kept the first 10, all
the same line, so the other distinct errors were lost.

Fix in `renderEngine.ts` `record()`: key by message text; keep the first
`MAX_PREVIEW_ERRORS` distinct messages with a repeat count (`(x363)`), and keep the total.

## 5. frames and wait_ms together

Evidence: `5dd2e479`, `{"frames":[1500,3000,6000],"wait_ms":6000,...}` refused with
"frames replaces wait_ms; provide only one."

Fix in `previewMode.ts` `readFrames`: accept both; `frames` wins; add one line to the result
("wait_ms ignored: frames sets the capture times"). Update the schema description to match.

## 6. Refusals that name the alternative

a. **A tool the run does not offer**: `5dd2e479` row 2607, the model called `browser_open`
   (never offered; `permissions.browser` off) and got "requires permission "browser" which is
   not granted for this Forge turn" from `ToolRegistry.assertAllowed`. That reads as "ask for
   permission". **Change only the text of this existing refusal**: say the tool is not
   available in this conversation, and name the alternative when one exists. Add no new
   refusal: by design, registered tools that were not advertised (lazy groups) stay
   dispatchable, and that must not change. Keep the
   alternative map in one place (extend an existing owner; see `DenyListEntry.alternative`):
   `browser_*` -> `render_html_to_image` with `mode: "preview"`; otherwise list nothing.
b. **shader_check skipping a template literal with `${...}`**
   (`shaderExtract.ts`, "template literal has ${...} interpolation"): add to the skip message
   that the model can write the assembled shader to a `.wgsl` / `.glsl` file and run
   shader_check on that. That is exactly what the model worked out alone in `5dd2e479`
   (`.t/extract-wgsl.mjs`), and the check then found the real bug. Do not substitute `${}`.
c. **read_file past the end** (`9e9e82dc`: "start_line 2165 is past end_line 2126 (file has
   2126 lines)"): when `start_line` is beyond the file, say so plainly: "start_line 2165 is
   past the end of the file (2126 lines)".

## 7. Compaction: condense the earlier summary instead of carrying it

Evidence: `5dd2e479`, 5 compactions; the summary grew 6.9K -> 20.1K characters.

`compactionPrompt.ts` passes the previous summary as "EARLIER SUMMARY". Change the
instruction so the new summary merges and condenses it: completed work shrinks to one line
per item, superseded decisions and resolved errors are dropped, open work and current file
state keep their detail. Target size does not grow with the compaction count. Keep the
required sections that `compactionSummaryRunner.ts` checks. Test: a fixture with a long
earlier summary produces a prompt with the condense instruction; the summary allowance is
unchanged.

## Out of scope

- `view_image` in the bench profile (a bench config choice, not Forge code).
- Prompt (`execute.njk`) changes.
- Substituting `${}` in shader_check.

## State × lifecycle ledger

No durable state. Every change is to tool result strings, argument handling, the
compaction prompt text, or an in-memory error list; nothing new is written to disk, config,
or any store.

## Acceptance criteria

- Item 1: a unit test feeds the client a stream that ends inside a tool call's arguments
  and gets `ToolCallTruncatedError`; a loop test shows the recovery message is sent and the
  turn continues; `ToolFailureTracker` is not advanced.
- Item 2: unit tests for each of a-d, including the two real argument strings from the
  sessions (trimmed) for 2a.
- Item 3: a live test (skipped where no system Chrome/Edge channel exists, and where the
  page reports no WebGPU adapter — CI machines have no GPU) with a broken
  WGSL page; preview reports the compile error with line:column — or this file records that
  it already did.
- Item 4: 363 identical errors plus 2 distinct ones report as 3 lines, one with `(x363)`.
- Item 5: frames + wait_ms renders the frames and says wait_ms was ignored.
- Item 6: tests for each refusal string; the alternative map has one owner.
- Item 7: prompt test as above.
- `npm run ci` green after every commit; `npm run package` green at the end; a row in
  `docs/OWNERS.md` for any new module; `CHANGES.md` entry per the repo's convention.

## Review findings for a follow-up pass (Claude, after item 1 was written)

- R1. Item 1's recovery text says "This is an output-size limit". For a stream that ended
  without a terminal frame (`finishReason` null) the cause is unknown; say the call was cut
  off before it was complete, and keep the output-limit wording only when `finishReason` is
  `length`.
- R2. The `edit_file` branch says "fewer edits than in the call that was cut off" with no
  number. CLAUDE.md requires a hard ceiling: state the same character ceiling the generic
  branch computes (total `old_str` + `new_str` characters per call), and optionally a count
  (the number of complete edits that arrived before the cut).
