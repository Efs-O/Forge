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
- Status: closed 2026-11-19 — not a store bug. Claude traced the loss to an explicit call: chat
  ec64f51f ran `forget {"key":"basalt-watch-2026-11-13"}` at 11-14 09:59 (and forgot
  `basalt-watch-2026-11-12` as well). The entry's dates were also wrong: the note was written
  11-13 06:51 in eef4b3f8, and 11-15 06:48 is the recall that found nothing. A `forget` that removes
  the file is correct behaviour, so there is nothing here to fix — and the 2026-11-19 duplicate-key
  heal (chat 8f53bf68, ledger BL-038) is a different mechanism: it leaves a file present but skipped.

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

## A scheduled job that finished and reported is logged as "interrupted — Forge restarted during the run"

- Seen: 2026-11-17, also 2026-11-16, 2026-11-19, five times on 2026-11-21 (the 06:45, 06:51,
  06:54, 06:58 and 07:14 turns each ended with their `RESULT:` line in the chat minutes before the
  runner logged them) and three times on 2026-11-22 (10:45, 10:54, 10:59), Forge 0.17.18x →
  0.17.207, job "Basalt Windows multi-GPU watch"
- Tool: the scheduled job runner, recorded in `~/.forge/jobs/runs/basalt-watch.jsonl`
- Did: `{"at":1794891190572,"outcome":"failed","summary":"interrupted — Forge restarted during
  the run"}` written about three minutes after the same turn ended with `RESULT: ok — the first
  Windows two-GPU peer run with published numbers…`; the file holds no entry carrying that
  summary, nor the previous day's (`…the maintainer says layer split is on main…`), and a second
  run of the same job fires minutes later. The 2026-11-21 variant logs
  `interrupted — no heartbeat for 2 min; the run's window stopped responding or exited (started
  06:45)` (widening to `no heartbeat for 3 min` by 07:14) for five runs in a row whose turns kept
  answering tool calls and ended with their `RESULT:` line
- Should: record the `RESULT:` line the finished turn produced, and not mark a run interrupted
  when the restart comes after its last message. The numbers do not fit the task it guards: the
  beat is every 30 s and the marker is stale after 120 s (`TASK_RUN_HEARTBEAT_MS` /
  `TASK_RUN_STALE_MS`, `src/jobs/agentTaskState.ts:63-66`), while the same job's action allows a
  20-minute agent task, so any turn that spends more than two minutes between tool calls looks
  dead. Clearing the marker also leaves the daily run not-done, so the next tick starts it again:
  five notices in 20 minutes on 2026-11-22, one Telegram ping each.
- Workaround: the report is in the chat; the retried run re-sweeps and answers "nothing new since
  the report minutes ago"
- Status: open

---

## laptop-test `run` prints the exchange id as `CHAT=`, so `wait` and `status` 404

- Seen: 2026-11-18, laptop Forge 0.17.197, chat b1657c11-378e-44f2-a6ac-7a955cd0c59d
- Tool: `scripts/laptop.ps1 run <prompt.md>` — it printed `CHAT=9fda2847-09b3-4825-b700-34a8c0989dfe`,
  which is that call's `exchangeId`, not the `conversationId` every other verb takes
- Did: `wait 9fda2847-…` → `curl: (22) The requested URL returned error: 404` /
  `forge.sh: Forge's endpoint did not accept it (see above).` / `EXIT=1` — not the `EXIT=124` a
  still-running chat prints, so it reads as a dead chat
- Should: print the id its own `wait`/`status`/`collect` accept, e.g.
  `CHAT=<conversationId> EXCHANGE=<exchangeId>`
- Workaround: take `conversationId` from the `run` JSON; `status <exchangeId>` names it in its own
  error (`is an exchange id, not a chat id: its chat is --to b1657c11-…`)
- Status: fixed in the skill script (edited 2026-11-18 16:36): `run` now prints
  `CHAT=<conversationId>  (pass this to wait / status / collect)` and `EXCHANGE=<exchangeId>  (not a chat id)`

---

## `shell` aborts a plain `ls | grep` pipeline with exit 134 and prints no result

- Seen: 2026-11-19, Forge 0.17.202, chat "SEARCH THE CODEBASE TO FIND 5 CRITICAL BUGS"
- Tool: `shell` — `ls test/unit | grep -i -e ssrf -e webfetch -e fetch`
- Did: `exit 134 · 0.5 s` with `/usr/bin/bash: line 1: 2003 Done ls test/unit` / `2004 Aborted | grep …`;
  the listing printed nothing, so the answer to "is there an SSRF test?" was lost, not just failed
- Should: run the pipeline, or refuse with the reason; a SIGABRT from the shell's own job control
  is not something the caller can act on
- Workaround: `find_files` / `grep_search` instead of piping `ls` into `grep`
- Status: open

## `manage_jobs` `resume` fails with EPERM when another window holds the job state file

- Seen: 2026-11-22, Forge 0.17.211, chat 6de9dc67-b750-424a-8a52-26678e98d6dc
- Tool: `manage_jobs` action `resume`, job `strata-update`
- Did: `Error: EPERM: operation not permitted, rename 'C:\Users\efso office\.forge\jobs\state\.strata-update.json.forge-<uuid>.tmp' -> 'C:\Users\efso office\.forge\jobs\state\strata-update.json' — rename onto ... was retried for 2500 ms and gave up; held by 30544 Visual Studio Code.` The job stayed paused, so `run_now` on it would have been a no-op.
- Should: retry longer than the 2500 ms it already spent (an editor/watcher holding a file releases in seconds), or report `resume deferred: state file held by <pid>, retry` instead of an Error, so the caller does not read it as a failed operation
- Workaround: `wait` 8 s and resend the identical `resume`; it applied on the second try
- Status: open

## `shell` refuses a read-only handle query over `~/.forge/jobs/state`

- Seen: 2026-11-25, Forge 0.17.216, chat 740d9587-89e6-49fa-b5f6-d40e32d608bb
- Tool: `shell`, running `powershell.exe -File .forge/tmp/b8-holders.ps1`
- Did: `refuses to change Forge's own files (C:\Users\efso office\.forge\jobs\state) (deny list)`. The script only enumerated open handles on those files (Restart Manager `RmGetList`) and wrote nothing there; the guard matched a path inside the script's own text rather than a write in the command line.
- Should: allow a command whose only access to a `~/.forge` path is a read, or name the write it inferred so the caller can answer for it.
- Workaround: the rule says tell the user, so the live holder question was answered from the code plus `~/.forge/sessions` logs instead of a live handle scan.
- Status: open
