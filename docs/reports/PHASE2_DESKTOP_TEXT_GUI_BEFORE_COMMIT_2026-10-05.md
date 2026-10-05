# Phase 2 before-commit report — desktop text transport + visible GUI launch

Date: 2026-10-05. Prepared for Codex review. **Nothing is committed yet.**
Baseline HEAD: `e00bbda` (unchanged through the whole phase). Phase 1 reference: `565c2b4`.

## 1. Scope and gate state

| Gate | Result |
| --- | --- |
| `npm run ci` after the final edit | **exit 0** — 414 passed / 7 skipped files, **4289 passed / 44 skipped** tests, build + `check:bundle` clean. Duration 51.16 s, finished 12:28 local. |
| Edits after that CI run | **none.** The report is written from the same tree CI measured. |
| `git diff --check` | exit 0, no whitespace errors (one benign CRLF→LF warning on `docs/BROWSER_DESKTOP_TOOLS.md`, which already has CRLF line endings in the repo). |
| `git status --short --untracked-files=all` | Only the 9 files in §2. HEAD still `e00bbda`. No other agent's file touched. |
| `max-lines` (500) | Largest touched file: `execTools.ts` 324. New files: `execShowWindow.test.ts` 226, `DesktopGuiInput.live.test.ts` 292. |
| Lint/Prettier | Clean inside `npm run ci`. (Owning the Phase 1 lapse: this run is after the last edit, not narrated.) |
| Live GUI smoke | Ran **live** on this host, 3/3 passed, then removed from the default set by its env gate. Reported as a live run, not as a CI pass. |
| Scratch probes | `scratch/` deleted (recycle bin). No probe file remains. |

## 2. Exact changed-file scope (9 files)

Modified:

1. `src/tools/desktop/desktopDriver.ps1` — strict UTF-8 stdin reader, diagnostic `echo` op, `Get-CodePoints` helper.
2. `src/tools/desktop/PowerShellTransport.ts` — test-only `preferredExecutable` pin + `driverExecutable` getter (spawn flags unchanged).
3. `src/tools/BackgroundExecutionManager.ts` — `showWindow?: boolean` on `BackgroundExecutionStartOptions`; the single spawn uses `windowsHide: options.showWindow !== true`.
4. `src/tools/execTools.ts` — `show_window` schema + pre-spawn validation + launcher/child note + foreground-route comment.
5. `test/integration/DesktopTransport.test.ts` — echo round-trip suites (both engines), sequential-state test, invalid-UTF-8 refusal test.
6. `docs/BROWSER_DESKTOP_TOOLS.md` — new "Visible background GUI launches" section + UTF-8 desktop text paragraph.
7. `docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md` — "Implemented shape (Phase 2, deliberate)" note.

Added:

8. `test/unit/execShowWindow.test.ts` — 10 spawn-option / boundary tests.
9. `test/live/DesktopGuiInput.live.test.ts` — 3 live GUI tests, env-gated.

## 3. Item-by-item against the plan

**Item 1 — JSON-line input boundary.** `[Console]::In.ReadLine()` replaced by
`System.IO.StreamReader([Console]::OpenStandardInput(), UTF8Encoding($false, $true))`.
Strict decoding means malformed bytes **throw**: the driver writes a named stderr line
(`stdin is not valid UTF-8 …`), runs `Send-ReleaseAll`, and exits **4** — the transport
surfaces that as `desktop driver process exited (code 4): …`. UTF-8 stdout JSON, request
IDs, blank-line handling, timeout, crash/respawn and release-all-on-teardown are untouched.
The `-ReleaseAll` one-shot stays **before** the reader is constructed, so that path never
opens stdin. A diagnostic-only `echo` op returns the decoded text, its `utf16_length`, and
comma-joined UTF-16 units; it sits above the target-checked default branch, so it needs no
approved target and never reaches `SendInput`.

Mechanism, measured before fixing: the old loop decoded the redirected pipe as **CP437** on
pwsh 7.6.6 *and* Windows PowerShell 5.1 (`café` → U+233C U+03C3). The explicit reader returns
exact code points on both.

**Item 2 — real-child echo round trips.** `test/integration/DesktopTransport.test.ts` now runs
the same payload table twice: default engine (pwsh with 5.1 fallback) and **pinned 5.1**.
Payloads: ASCII, `café`, `Γειά σου`, `你好`, `🚀`, `a€中😀b`. Each asserts exact string, exact
UTF-16 units computed in TS, the **driver-reported** units, and `utf16_length` — so a decode
that only worked on one side of the pipe cannot pass. A sequential two-request test on one
child exercises decoder state and line framing. A separate test writes raw invalid UTF-8
(`c3 28`) while a `sleep` request is in flight and asserts exit 4 + the named stderr reason.

**Which engines actually ran:** both. `pwsh` is installed (`C:\Program Files\PowerShell\7\pwsh.exe`),
so the default suite ran on `pwsh` and the pinned suite ran on `powershell`; the
`ran on the engine it claims` test asserts the pin held rather than silently substituting.
File total: 14 tests, **13 passed, 1 skipped** (the skip is second-monitor capture, host has one display).

**Regression proof (fails on pre-fix code):** with only the `StreamReader` reverted to
`[Console]::In`, the round-trip test fails on both engines — `café` → `caf├σ`. Reinstated
before any further work.

**Item 2 second half — live Notepad smoke.** `test/live/DesktopGuiInput.live.test.ts`,
gated on `FORGE_LIVE_DESKTOP_GUI=1`, so `npm run ci` **skips** it (visible in the CI output as
`↓ … 3 tests | 3 skipped`). It launched real Notepad through `exec_command show_window`,
found it in `desktop_windows` with a nonzero rect, typed `café Γειά 你好 😀 tail`, did
`Ctrl+A`/`Ctrl+C`, and asserted the clipboard equals the payload **exactly**. Then a
focus-loss test: a second test-owned Notepad takes the foreground, and a direct driver
`type` naming the first window is refused by `Test-Target` (`target lost focus`), with a
sentinel proving nothing leaked into the new foreground window and the first window's
content still exact. Cleanup killed only the pids it started; the user's clipboard was
restored (verified: it reads back their prior content).

**Host-safety notes:** every window is identified only by a unique fixture filename, never a
generic title, so this test cannot find/focus/close a window it did not start. On tabbed-Notepad
systems (build ≥ 22000) it refuses to run while any Notepad exists. This host is Windows 10
19045 (one process+window per launch), so a unique fixture name is sufficient isolation.

**A harness defect found while writing it (not a driver defect).** The first live run failed
with `caf? ���� ?? ?? tail`. A direct probe showed the **clipboard held the exact text** —
the corruption was in the *read-back*: Windows PowerShell 5.1's `[Console]::OutputEncoding`
on a redirected pipe is the OEM code page (this host: **ibm737**, Greek). The test now sets
`[Console]::OutputEncoding = UTF8` before `Get-Clipboard -Raw`, strips a possible BOM, and
`beforeAll` asserts that harness round trip **first**, so any later failure names the driver
rather than the harness. This is recorded in the plan doc too, because it will bite anyone who
writes the next clipboard assertion.

**Item 3 — `show_window`.** Strict `boolean` in the schema. Validation happens **before any
spawn**: non-boolean → named error; `true` without `background: true` → named error; `true`
on non-Windows → named error. Threaded through `BackgroundExecutionStartOptions` to the
**single** `BackgroundExecutionManager.start` spawn as `windowsHide: options.showWindow !== true`,
so the default stays hidden. No executable-name inference. `PowerShellTransport`, `gitRepo`
and `gitDiscovery` spawn flags untouched (verified: `PowerShellTransport` still uses
`windowsHide: true`; its diff is only the engine pin + getter). `spawnAndWait` is documented
in-place as the separate foreground route that sets no window flag and is **not** the route
the report proved.

**Item 4 — behavior preserved.** Denylist, cwd normalization, env validation, process
count/timeout/stop/exit notices are all still ahead of / around the flag (a test asserts a
denylisted command is refused with `show_window: true` and **zero** spawns). The flag grants
no desktop target approval. When a visible launch is used, the tool result appends a NOTE
naming the tracked process and stating that a launcher may report `completed` while its GUI
stays open and that `stop` will not close it. No claim of tracking or stopping an unowned child.

**Item 5 — focused tests.** `test/unit/execShowWindow.test.ts` (10 tests) fakes
`child_process.spawn` and asserts the exact `windowsHide` value at the one spawn site:
default hidden, `true` visible, `false` hidden, tool-level pass-through with exactly one
spawn, tool-level default hidden, `true` without background refused before spawn, non-boolean
refused before spawn, non-Windows guard (follows the host's platform rather than hard-coding),
denylist ahead of visibility, and a launcher-stub case that asserts nothing about a GUI child.
Live half: the live test above covers launch → `desktop_windows` → capture/focus → one
reversible input → close only the test-owned process. Default-hidden console helpers are
covered by the unit default case.

## 4. Design decisions worth your attention

1. **`echo` is a permanent diagnostic op, not a temporary probe.** It costs one branch, needs
   no approval, and gives the encoding fix a way to fail loudly forever. It is documented in
   the driver as diagnostic-only and sits above the target-checked branch deliberately.
2. **Exit code 4 for an undecodable stdin stream** rather than answering one request with an
   error: once a strict decoder throws mid-stream, line framing is untrustworthy, so no
   further request can be answered correctly. Release-all still runs, because the worse
   failure is a held key.
3. **The engine pin is a constructor parameter, not an env var**, so the 5.1 path is testable
   on a host where pwsh exists and a run can name the engine that served it. Production call
   sites are unchanged.
4. **`show_window` validation precedes the denylist check deliberately?** No — the denylist
   still runs first in the existing guard block; my validation only adds refusals for a
   malformed visibility request. The test asserting "denylist wins, zero spawns" pins that.
5. **The live GUI test lives in `test/live/`**, matching the existing env-gated convention
   (`FORGE_LIVE_*`), so it is a named manual step rather than a flaky CI test.

## 5. Known limitations / honest gaps

- **Second-monitor capture and mixed-DPI remain unverified** (this host reports 1 display).
  Reported as skipped, never as a pass.
- **The live GUI smoke is one host, one run** (Windows 10 19045, Notepad, one payload string).
  It is not in CI by design; a Windows 11 host has not run it, and the tabbed-Notepad guard is
  reasoned rather than observed.
- **`echo` proves the transport, not `SendInput`.** The live test closes that gap for one
  payload; per-character input correctness for other scripts still rests on the driver's
  `KEYEVENTF_UNICODE` path.
- **CI flakiness (pre-existing, not attributed to this change):** earlier full runs in this
  session saw a few unrelated load-sensitive tests fail while passing in isolation. This
  phase's final run had **zero** failures, so nothing to hand you as a defect — flagging it
  only so a future red run is not misread.
- **`docs/` is gitignored, but these two docs are already tracked.** `git ls-files --error-unmatch` confirms `docs/BROWSER_DESKTOP_TOOLS.md` and `docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md` are tracked, so plain `git add` suffices for both. (An earlier draft of this report wrongly said they needed `git add -f`; corrected after Codex's review. The *new* report file under `docs/reports/` is untracked and does need deliberate inclusion.)

## 6. Proposed commit

```
fix(desktop): truthful UTF-8 stdin, and visible background GUI launches

- desktopDriver.ps1: read stdin through a strict-UTF8 StreamReader, so
  desktop_type receives the characters that were sent and invalid UTF-8 is
  refused (exit 4, after release-all) instead of typed as U+FFFD. Adds a
  diagnostic `echo` op that reports decoded UTF-16 units.
- exec_command: `show_window: true` for a background job on Windows spawns with
  windowsHide:false; validated before spawn, default stays hidden, and the
  result states that the id tracks the started process, not a launcher's GUI.
- tests: real-child echo round trips on pwsh and pinned 5.1, invalid-UTF-8
  refusal, spawn-option/boundary units, and an env-gated live Notepad
  type -> clipboard round trip including a focus-loss refusal.
```

Staged by name: the 7 modified + 2 added files, plus this report. Both docs paths are already tracked, so plain `git add` is correct for them.
No push. Awaiting your GO.

---

## 7. Round 2 — Codex's four findings, all fixed

Codex reviewed §1–6 and returned NO GO with four defects. All four are fixed; none was a disagreement.

**1. Cleanup stopped nothing (real defect).** The suite created its own `new BackgroundExecutionManager()` but launched both Notepads through `makeExecCommandTool()`, which starts jobs on the module **singleton**. `afterAll` called `stop()` on the empty separate instance, swallowed the error, and would have left Notepad windows on the owner's desktop while deleting their fixture directory. Fixed: the test now imports and uses `backgroundExecutionManager` itself, records each job's **pid** from `observe()`, and after stopping **verifies** the pid is gone (`Get-Process -Id`) and the fixture window is off screen (`list_windows`). A cleanup problem is collected and thrown as a loud `afterAll` failure — no silent `catch`. Verified live: after a full run, `find-orphan-notepads.ps1` reports zero `forge-live` windows and zero notepad processes.

**2. Temp directory created even when fully skipped (real defect).** `fs.mkdtempSync` ran in the `describe.skipIf` callback, which executes even when every test is skipped. Codex reproduced it and cleaned up after me; two empty `forge-gui-live-*` directories from my earlier skipped runs were still in `%TEMP%` (they sit outside my sandbox, so they need your `Remove-Item`). Fixed: fixtures are created in `beforeAll`, after the live gate and the preflight. Verified with Codex's exact repro — `npx vitest run test/live/DesktopGuiInput.live.test.ts` with the env unset → 3 skipped, **temp dir count unchanged** (3 before, 3 after).

**3. Clipboard save/restore was lossy, and the preflight ran too late (real defect).** `Get-Clipboard -Raw` + `Set-Clipboard -Value` silently drops image/file/HTML/RTF formats, and the Windows-11 Notepad refusal happened *after* the clipboard had already been overwritten. Fixed by refusing **before any write** when the clipboard holds a format the harness cannot restore — probing `ContainsAudio` / `ContainsFileDropList` / `ContainsImage` / `GetText(Html)` / `GetText(Rtf)` via `System.Windows.Forms.Clipboard` (verified working STA in a spawned non-interactive PS 5.1 process). A plain-text or empty clipboard *is* within reach, so it is snapshotted to a file and restored with the equality check done **inside** PowerShell using `-ceq`, because comparing through stdout disagrees on trailing newlines alone (measured 34 vs 32 chars for 30 characters of content). The Win11/Notepad refusal now runs first, ahead of every clipboard operation, and `afterAll` runs even when `beforeAll` threw, so a refused preflight still cleans up. Also fixed a related trap: `Clipboard.Flush()` does not exist on .NET Framework (PS 5.1) — calling it printed `MethodNotFound` on every restore; it is now guarded by `GetMethod('Flush')`.

**4. Report was untracked and its `git add -f` claim was wrong (real defect).** This report file is untracked, so it is now listed as part of the phase commit rather than left behind. The claim that both modified docs need `git add -f` was wrong and is corrected in §5: `git ls-files --error-unmatch` shows `docs/BROWSER_DESKTOP_TOOLS.md` and `docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md` are already tracked, so plain `git add` suffices.

**Two further defects found while verifying the fixes** (both mine, both fixed, worth your attention because they were invisible in the earlier "passing" run):

- `afterAll` called `driver.dispose()` **before** the window verification that needs the driver, so the verification threw `desktop driver is disposed` and the suite failed *after* its tests passed. Reordered: stop jobs → verify pids → verify windows → dispose driver last.
- Focusing the second Notepad was racy: it could be the foreground window with `GUITHREADINFO.hwndFocus` still null, and the driver correctly refused with `target has no keyboard focus`. Added `focusAndSettle()`, which re-focuses and probes with a harmless `End` keypress until input is accepted, so the focus-loss test asserts against a window that verifiably holds keyboard focus instead of assuming it.

**Round-2 gates:** `npm run type-check` exit 0. Live suite re-run **3/3 passed with no stderr**. Skipped-run temp-artifact check: unchanged count. Orphan check: zero windows, zero processes. Clipboard verified restored to the owner's own prior content externally, not just by the test's own claim. `npm run ci` and `git diff --check` results are reported in the round-2 message (run after the final edit, with no edits after them).

## 8. Codex final harness review

After two Forge turns stalled without tool calls, Codex applied three focused test-harness corrections while Forge was idle:

1. A refused `beforeAll` no longer produces a false `afterAll` error about a missing clipboard snapshot. Cleanup requires restoration only when the harness may have written to the clipboard.
2. The preflight inspects actual clipboard formats with `GetFormats(false)` and rejects every non-text format, including custom formats and empty rich-text formats. The earlier named-format checks could miss those and destroy them during a UnicodeText-only restore.
3. `launchVisible` records the accepted job ID before awaiting `observe()`, so cleanup still knows the job if observation fails.

Focused tests: 23 passed, 4 skipped across the transport, spawn option, and env-gated GUI files. Live GUI smoke after these corrections: 3 passed. The final repository-wide and package gates are run after this report edit and will be reported to the supervisor separately; no commit has been made.
