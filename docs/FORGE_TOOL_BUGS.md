# Forge tool faults

One entry per fault an agent hit in a Forge tool while working. **Recording is not fixing**:
log it, work around it, keep going. The once-a-week look reads this file together with the
daily session-log scan report and decides what to fix, in what order.

The split from `docs/AGENT_TOOL_TRAPS.md`: that file keeps the root-cause post-mortems for
faults already fixed in a release. This one is the live queue — open, by-design, and
wont-fix, all here, each marked.

Entry shape (copy it, fill it, newest entry last):

```
## <short symptom>
- Seen: <YYYY-MM-DD>, Forge <version>, chat <chat-id or "unknown">
- Tool: <tool name, and the argument that triggered it>
- Did: <what came back, quoted from the result, not reworded>
- Should: <what it should have done>
- Workaround: <what was done instead>
- Status: open | by design | wont fix | fixed in <commit or version>
```

---

## `format_file` re-indents a whole file instead of using the repo's formatter

- Seen: 2026-11-09, Forge 0.17.17x, lab chat (tool-lab round)
- Tool: `format_file` on `src/tools/gitReadTools.ts` and its test
- Did: `Formatted: src/tools/gitReadTools.ts` — then 328 and 349 changed lines respectively,
  every line re-indented to 4 spaces
- Should: apply the repository's own Prettier config (2 spaces), or refuse when it cannot
- Workaround: `restore_file` both paths from HEAD, re-apply the edit by hand, gate
  formatting with `npx prettier --check <files>`
- Status: open

## The first `code_intel` call of a session answers nothing while the language server loads

- Seen: 2026-11-09, Forge 0.17.171, lab chat
- Tool: `code_intel` `document_symbols` on `src/tools/gitReadTools.ts`
- Did: `No symbol provider answered for src/tools/gitReadTools.ts. The language server may
  still be starting` — and an immediate retry answered in full
- Should: wait for the provider, or say "warming" rather than reading as "this file has no
  symbols"
- Workaround: retry once before falling back to whole-file reads
- Status: open

## A still-loading server's `references` list is short and says so only in a note

- Seen: 2026-11-09, Forge 0.17.171, lab chat
- Tool: `code_intel` `references` for `makeGitBlameTool`
- Did: `Note: a text search also finds makeGitBlameTool in 1 file(s) the language server did
  not report: test/unit/GitReadToolCap.test.ts.`
- Should: return the complete set, or name the files it could not check
- Workaround: cross-check with `grep_search` before naming the tests that cover a tool
- Status: open

## "No diagnostics found" can be the pre-edit check

- Seen: 2026-11-09, Forge 0.17.17x, lab chat
- Tool: `code_intel` `diagnostics` right after an `edit_file`
- Did: `VS Code reported no new check of src/tools/gitReadTool.ts in the 4 s after Forge's
  edit, so these diagnostics may predate it. No diagnostics found.`
- Should: not answer until a post-edit check exists, or block until one lands
- Workaround: treat it as unknown; gate with the project's own command in the same round
- Status: open

## A glob under `~/.forge/` was not refused where the rule says it should be

- Seen: 2026-11-14, Forge 0.17.17x, lab chat
- Tool: `shell` — `ls ~/.forge/logs/*`
- Did: no refusal; `ls: cannot access '/c/Users/…/.forge/logs/*': No such file or directory`
  (exit 2), while `ls ~/.forge/jobs/*` in the same round listed 40+ paths
- Should: the read/write guard's stance on `~/.forge` paths should be the same for a matching
  and a non-matching glob, and stated in the message
- Workaround: pass the absolute path to `list_directory`
- Status: open

## `wait` returns instantly when a background notice lands, and reads like a held sleep

- Seen: 2026-11-13, lab chat
- Tool: `wait` `seconds: 20`
- Did: `Wait ended after 0s of the 20s requested because a new message arrived.`
- Should: same as now (returning early is correct) — but the trap is reading the call as a
  sleep
- Workaround: read the `ended after Ns` part before concluding it held
- Status: by design

## `stop_execution` on a job that already finished reports the job's own exit code

- Seen: 2026-11-13, lab chat
- Tool: `stop_execution` on a `vitest run test/unit` that had ended in the previous round
- Did: `{"status":"failed","exit_code":1}`, and the completion notice said
  `failed (exit 1) after 1m 24s` — read as "my stop worked"
- Should: the result should say whether the stop terminated anything
- Workaround: check `status` is `terminated` (with `exit_code: null`) before claiming an
  interruption
- Status: open

## `git_read` blame repeats the full header for every line

- Seen: 2026-11-09, lab chat
- Tool: `git_read` `blame`, lines 149-176 of a 230-line file
- Did: `--line-porcelain` repeated the author/committer header per line, so 28 lines came
  back as ~250 lines of text
- Should: default to a compact form and offer the full header on request
- Workaround: ask shell for `git log -L <start>,<end>:<file>`
- Status: open

## `shell` refuses a `timeout_ms` above 600000 even for a background job

- Seen: 2026-11-13, lab chat
- Tool: `shell` `timeout_ms: 900000`, `background: true`
- Did: `"timeout_ms" must be within 1000 to 600000. Resend it in that range.` — no job started
- Should: as now; a background job does not need a long foreground ceiling
- Workaround: `background: true` with the default, then `monitor_execution`
- Status: by design

## `remember` reports success, but the note is gone from disk the next day

- Seen: 2026-11-16, Forge 0.17.17x, chat "Basalt Windows multi-GPU watch" (scheduled job, 2026-11-15 run)
- Tool: `remember` key `basalt-watch-2026-11-13` (written 2026-11-15), then `recall` of the same key on 2026-11-16
- Did: the write returned `Remembered.`; the next day's `recall` returned `(not found)`, and
  `list_directory C:/Users/efso office/.forge/memories/Forge-5f7df423` lists
  `basalt-watch-2026-11-14.md` and `basalt-watch-2026-11-15.md` but no `-2026-11-13.md`
- Should: keep what it accepted, or report that the write did not persist — a silent loss makes
  the previous day's "already reported" state unusable for dedupe
- Workaround: re-derive the lost facts from the current watch run and fold them into the new note
- Status: open

## `desktop_click` on a dialog field reports success but does not move focus

- Seen: 2026-11-16, Forge 0.17.185, chat 86b15ced-06cb-4e3b-9591-c2a2d1d5bda2 (Word 2010 Find and Replace)
- Tool: `desktop_click` at (300,118) inside the "Replace with" combo box
- Did: reported `Clicked (left, 1×)`; the next `desktop_type` still went to "Find what", which read
  `27/724/12` — the click was a silent no-op for focus
- Should: focus the control it hit, or report that focus did not move
- Workaround: move between dialog fields with `desktop_press` `tab`; clear with `ctrl+a` + `delete`
- Status: fixed on main (commit 7e16d9f1) — the driver reads the focused control before and after the click and the tool says which; the decision is made on the focused HWND, not the class

## `desktop_capture` approves a target but does not foreground it

- Seen: 2026-11-16, Forge 0.17.185, chat 86b15ced-06cb-4e3b-9591-c2a2d1d5bda2
- Tool: `desktop_capture` "Find and Replace", then `desktop_press` / `desktop_click`
- Did: input refused — `target lost focus (foreground is 'Strata (127.0.0.1:8091) - Forge - Visual Studio Code')`;
  and capturing a second window drops the first capture id: `unknown capture_id "cap-10"; call desktop_capture first`
- Should: say in the result that the capture is not foreground, so the next action needs `desktop_focus_window`
- Workaround: `desktop_focus_window` immediately before every click or keystroke
- Status: fixed on main (commit 7e16d9f1) — a window capture now ends with "Captured without bringing the window forward: call desktop_focus_window before any input action."

## `desktop_focus_window` refuses `window_id` as a number, after accepting the same form

- Seen: 2026-11-16, Forge 0.17.185, chat 86b15ced-06cb-4e3b-9591-c2a2d1d5bda2
- Tool: `desktop_focus_window` with `window_id` 4523544, copied from `desktop_windows` output
- Did: refused three times — `must be a JSON string, not a number. Resend the call with
  window_id as "text"` — while the identical numeric form was accepted twice earlier in
  the same chat (41617738, 27987174). The refusal cannot be honoured: the parameter block
  renders the value the same way each time
- Should: accept what its own `desktop_windows` prints, or normalise a number to a string
- Workaround: pass `window_title` instead (a case-insensitive substring)
- Status: fixed on main (commit 7e16d9f1) — the schema takes `["string","number"]` and `ToolRegistry.invalidArgs` now checks every type of a union instead of none, so a boolean or an object is still refused
