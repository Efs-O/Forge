# Desktop and browser tool repair plan

**Source:** `docs/DESKTOP_BROWSER_TOOL_TEST_REPORT.md` (2026-10-04)
**Status:** All three phases implemented and committed — Phase 1 `565c2b4` (format correction `318cf17`), Phase 2 `8881b18`, Phase 3 `4b744b8`. The four-tier smoke sequence was re-run on this Windows host on 2026-10-06 (§ "Four-tier smoke re-run"). Release 0.16.87 is committed as `89cae66` (`chore(release): 0.16.87`) with `npm run ci` green on that commit, and the matching VSIX is **installed** (Codex GO, 2026-10-06 00:52) — see § "Package and install record". The running VS Code window still executes the pre-reload build until a Reload Window. Live cases that could not be run here are listed as unverified in § "Limitations and unverified live cases" — none of them is claimed as passed.
**Pass rule:** a capability succeeds on its first attempt, or at worst its second, with an observable effect or a clear refusal.

**Implementation owner:** Strata, supervised by Codex. Start this as a new Forge conversation only after the Telegram upgrade, final review, build, VSIX install, and clean-worktree handoff are complete. Before Phase 1, Codex commits this currently untracked plan as a separate preparation commit and verifies `git status` is clean; do not fold it into a Telegram commit or leave it untracked. Work in the existing owners named below. One implementation phase is one commit with `npm run ci` green; stage only phase files by name. Forge reports after each phase, Codex reviews and gives the commit go, and Forge performs the final review before the release go. Record the commit hash and test result for each phase. Do not modify the user's live `.forge/config.yaml` or their already-open windows. This plan is the scope of the delegated work; an unverified live claim stays marked unverified.

## Validation of the report

The live observations in the report are evidence from one Windows 11 machine. The source checks below confirm mechanisms where possible; they do not replace a live retest after the changes.

| Finding | Validation | Implementation decision |
| --- | --- | --- |
| `browser_inspect` returns `undefined` and the handler throws on `.length` (§3.2) | Confirmed by `BrowserSessionManager.inspect`: it passes a string containing a function to `page.evaluate`, then `browserActionTools` reads the result as an array. The current browser integration test never calls inspect. | Fix and add a real browser integration assertion for inspect and an index action. |
| `desktop_windows` shows `0×0` rects (§3.1) | Confirmed source defect: `desktopDriver.ps1` returns geometry under `w.rect`; `PowerShellDesktopDriver.listWindows` reads `w.x`, `w.y`, `w.width`, `w.height`. Its numeric fallback turns missing fields into zero. | Read `w.rect` and validate the response shape. |
| Monitor capture fails at `BitBlt` (§3.7) | Confirmed: `BitBlt` is declared from `user32.dll`, while the monitor path calls it. | Import from `gdi32.dll`; verify a nonempty monitor image. |
| `monitor` index is ignored (found during plan review) | `desktopTools.ts` and `PowerShellDesktopDriver.ts` pass the index, but `desktopDriver.ps1` always calls `Capture-VirtualDesktop` without reading it. Its response says `monitor` even though it captures all screens. | Make index 0 capture the primary monitor, use deterministic indices for other displays, and refuse an invalid index. Preserve a separate explicit virtual-desktop mode only if the public tool contract is extended and approved in this phase. |
| `desktop_type` corrupts Unicode (§3.10) | The live clipboard round trip establishes corruption. Node writes JSON as UTF-8, while the driver sets output encodings but does not explicitly set **input** decoding before `[Console]::In.ReadLine()`. The exact code-page mechanism still needs a direct transport probe. | Set or explicitly decode UTF-8 input, then test the real child with ASCII, accented text, CJK, and emoji before exercising desktop input. |
| GUI apps started by background `exec_command` are hidden (§3.3) | `BackgroundExecutionManager.start` always uses `windowsHide: true`; the report's visible/hidden Notepad A/B and `EnumWindows` probe support this cause. The evidence covers the **background** route. | Keep hidden console launches as the default; add an explicit visible-window option for background GUI launches. Check the foreground route during implementation before making claims about it. |
| Out-of-viewport `browser_click` reports success (§3.8) | Confirmed source defect: coordinate click calls `page.mouse.click` and immediately returns success, with no viewport check. | Reject nonfinite or out-of-viewport coordinates before the click. |
| Bad selectors take 30 seconds (§3.5) | The report's timing is credible; the selector path uses Playwright's default locator timeout. This is a usability issue, not a broken click primitive. | Set an explicit, shorter action timeout for selector-based input and preserve the detailed Playwright error. Measure on a slow but valid page before settling the value. |
| Boolean strings need coercion (§3.9) | The observed refusals are expected: `ToolRegistry.invalidArgs` deliberately checks the declared boolean type, and unit tests assert the corrective message. Coercion would weaken the strict JSON schema contract and silently change the meaning of malformed calls. | Keep rejection. Make the schema/help text and retry instruction clearer if the same model repeats the error after inspect is repaired; no central coercion. |
| VS Code cannot be controlled (§4) | Confirmed intentional guard in `targetWindowGate.ts`, with a unit test. This is a requested policy change, not a defect. | Add a narrow config opt-in for the ordinary `code` process; preserve other editor, UAC, secure desktop, and taskbar refusals. |
| DevTools shortcuts do nothing (§7) | The live no-op is established. The claimed browser-process explanation is plausible, but source inspection alone cannot prove where Chrome consumed the keys. | No DevTools feature in this repair. `browser_inspect` is the supported structured inspection path. |
| Index actions can silently hit a different element (found during plan review) | `browser_click`, `browser_type`, and `browser_hover` call `inspect` again for the requested index. A DOM change between the user's inspect and the action can assign that index to another element. A unique ancestry selector plus role/text checks is still insufficient: inserting an identical sibling can shift the selector to a different node. The current click/hover path also uses coordinates, so overlay or movement can redirect it. | Bind indices to the last inspection of that tab and to the same DOM node, recheck that node, and act on it directly or through an identity-bound locator. Refuse stale/ambiguous targets. |
| Desktop-root rectangle is wrong (§3.7 old draft), WordPad absent (§3.6), focus lock is universal (§3.4) | The report explicitly retracts or narrows these claims. | No fix based on the retracted diagnoses. Do not replace `EnumWindows` with `EnumDesktopWindows`. |

`browser_click` by selector needing three tries in the report was caused by two incorrect selectors, not three failed executions of a valid selector. Its result is a test-design problem under the two-attempt pass rule. Retest with a known valid element and an inspect-derived index.

## Implementation order

### Shared implementation rules

- Keep browser session state and lifecycle in `BrowserSessionManager.ts`, desktop policy in `targetWindowGate.ts` plus the existing desktop driver, desktop OS calls in `desktopDriver.ps1`, and argument validation at the existing tool boundary. `BrowserSessionManager.ts` is already 476 physical lines and `desktopTools.ts` is 430; split focused DOM inspection/selector or approval helpers before either source file crosses the 500-line lint limit. The manager remains the sole owner of browser sessions and snapshots; helper modules must not duplicate transport or state. Search for an existing symbol before adding one.
- Keep browser origin approval, desktop HWND+pid+start-time approval, foreground checks, in-rect checks, screenshot storage, and key/button release behavior. A failing action must not report that it clicked, typed, or captured successfully.
- Validate at the closest boundary and preserve the real error. Avoid `num()`/`str()` defaults for required driver response fields: they can turn protocol corruption into a plausible `0` or empty value.
- Include a regression test that fails on the pre-fix code for each confirmed defect. Use a controlled local `data:` page or a disposable test window; no external site or user document is a deterministic test fixture.

### Phase 1 — restore truthful read and input results

1. In `src/tools/browser/BrowserSessionManager.ts`, pass a **real callback** and one serializable `{selector, limit}` argument to `page.evaluate`. Type its DOM values within the callback without disabling strict TypeScript. Keep the current `INTERACTIVE_SELECTOR` heuristic and the default `max=50`; clamp an explicit `max` to a documented finite upper bound so one call cannot produce an unbounded result. An empty page returns `[]`. An unexpected nonarray result raises a named `browser_inspect` error.
2. Build a unique selector for each inspected element: use a CSS-escaped ID only if unique in the document; otherwise build a full `tag:nth-of-type(n)` ancestry path up to `html`. Keep `{index,role,text,selector,bbox}` and viewport CSS-pixel coordinates. Include repeated sibling elements, duplicate IDs, and nested elements in the test page. Never treat the current bare leaf `nth-of-type` selector as unique.
3. Store the last inspection snapshot **per Page**: page URL, numbered entries, selector, role, text, and a stable identity for each DOM node (for example, a retained Playwright `ElementHandle`). Replace it on inspect; dispose old handles and clear the snapshot on main-frame navigation (`framenavigated`), tab close, and browser close. An index action requires that snapshot and checks that the saved node is still attached, visible, enabled where applicable, and has the expected role/text. Act on that **same node** using its handle, or an identity-bound locator that cannot silently resolve to a replacement. A unique CSS selector and role/text comparison alone do not establish identity: inserting an identical sibling can shift an `nth-of-type` selector. Refuse missing, changed, hidden, disabled, or ambiguous elements and say to inspect again. This covers all three index consumers; do not re-enumerate and silently reinterpret the same number. For `browser_type`, use `fill` where supported and surface a clear noneditable-target error. Page script can mutate the DOM without navigation: the recheck is mandatory even when the snapshot exists.
4. In `src/tools/desktop/PowerShellDesktopDriver.ts`, map `w.rect` into `DesktopWindow.rect`. Require finite `x/y` and positive finite `width/height`; a malformed item should produce a named protocol error instead of a `0×0` row. Keep physical pixels, including valid negative origins. Reuse the existing nested-rect mapping in `focusWindow` as the shape reference.
   **Implemented shape (deliberate, reviewed with Codex):** a malformed row is a *per-row* protocol error, not a whole-list failure. `listWindows()` returns `{windows, skipped}`; each dropped row contributes a named reason (title + HWND), and the `desktop_windows` tool renders them as a `desktop_windows protocol error for N window(s): …` line. A single transiently-undecodable row must not cost the model every other window on screen, and the reason travels in the tool result because the model never sees the log channel. The whole-list case (missing/renamed `windows` field) remains a thrown named protocol error.
5. In `src/tools/desktop/desktopDriver.ps1`, import `BitBlt` from `gdi32.dll`, check its Boolean result, and throw on failure. Dispose GDI bitmap/DC objects in `finally` on both success and failure so a failed capture cannot leak handles. Keep `PrintWindow` for window captures.
6. Make monitor selection match the tool schema: `monitor:0` means the primary display; enumerate displays with Win32 `EnumDisplayMonitors`/`GetMonitorInfoW`, put the primary first, then sort remaining monitors by physical `left`, `top`, and device name. Other nonnegative integer indices follow that order; an invalid index returns the available range. Capture exactly the chosen display rect with its physical source origin in `BitBlt`; report that origin and capture dimensions separately from downscaled PNG dimensions. Implement this in the existing PowerShell driver, and keep monitor captures read-only. Update `desktopTools.ts` description, `DesktopDriver.ts` contract, and cloud-monitor approval text to name the selected scope. When the layout changes, indices are re-enumerated; never silently substitute the virtual desktop.
7. In `BrowserSessionManager.click`, validate explicit coordinate clicks against `page.viewportSize()` using finite `x/y` and `0 <= x < width`, `0 <= y < height`. Do this before `page.mouse.click`; report the point and viewport in the refusal. Apply the same validation to any remaining coordinate action that takes an inspect-derived center. The success text means input was dispatched at that point; page effects require a separate screenshot/tab-state check.

**Tests:** extend `test/integration/BrowserTools.test.ts` with inspect contents, unique selector resolution, click/type/hover by index, empty page, stale DOM/URL refusal, hidden/disabled target refusal, and an out-of-bounds coordinate that never fires a page click handler. Assert an in-bounds coordinate does fire it. Include an identical sibling inserted before an inspected target: the old index must act on the original node or refuse, never act on the new sibling. Add a fake-transport unit test for `listWindows` with a negative origin and malformed rect; extend Windows integration coverage for a visible window's nonzero rect, primary monitor PNG/header/rect, invalid index, and a second monitor when present. Skip host-dependent tests explicitly where no GUI/browser exists. Do not classify a skipped test as a live pass.

### Phase 2 — repair desktop text and visible GUI launch

1. Fix the JSON-line input boundary in `src/tools/desktop/desktopDriver.ps1`. First add a diagnostic test-only `echo` operation in the fixed driver protocol, or an equivalent injected script, to prove the bytes reach PowerShell intact without OS input. Prefer an explicit `System.IO.StreamReader([Console]::OpenStandardInput(), UTF8Encoding(false, true))` for reading lines; strict decoding must reject invalid UTF-8 instead of silently replacing characters. Preserve the existing UTF-8 stdout JSON, request IDs, blank-line handling, timeout, crash/respawn, and release-all on EOF/teardown. If the explicit reader conflicts with `-ReleaseAll`, keep the one-shot path before the loop. Test with both `pwsh` and the 5.1 fallback when installed; report which actually ran.
2. Extend `test/integration/DesktopTransport.test.ts` with real-child echo round trips for ASCII, `café`, Greek, `你好`, and `🚀`, including two sequential requests so decoder state and line framing are exercised. Assert exact code points/JSON values. Then run an approved, disposable Notepad type → `Ctrl+A`/`Ctrl+C` → clipboard read-back smoke; assert exact text and verify no input was sent when focus moved away. Keep this live GUI test outside unattended CI unless the host supplies a controlled interactive desktop.
3. Add `show_window?: boolean` to background `exec_command` only. Declare a strict Boolean in `execTools.ts`; require `background:true` and Windows when true, with a named error before spawn otherwise. Thread it through `BackgroundExecutionStartOptions` to the **single** `BackgroundExecutionManager.start` spawn as `windowsHide: !showWindow`. The default `windowsHide:true` remains for console helpers. Do not infer GUI status from executable names or change `PowerShellTransport`, `gitRepo`, or `gitDiscovery` spawn flags. `spawnAndWait` is a separate foreground route and already does not set `windowsHide`; document that it is not the route proven by the report.
4. Keep the existing command denylist, cwd normalization, env validation, process count/timeout/stop/exit notices, and per-action confirmation behavior for `show_window` launches. The new flag changes visibility only; it must not imply desktop target approval. Explain in the tool result/docs that `write.exe`-style launcher exit status covers the launcher, not its child GUI app. A background execution ID may be completed while the GUI remains open; do not claim it tracks or can stop an unowned child process.
5. Add focused spawn-option and argument tests: default hidden, true visible, false hidden, true without background rejected, true on non-Windows rejected, denylisted command still refused, and launcher-stub exit reported without an assertion that its GUI child died. Live smoke: launch a disposable GUI app with `show_window:true`, observe it in `desktop_windows`, capture/focus it, perform one reversible input, and close only the test-owned process. Verify default background console helpers remain hidden.

**Implemented shape (Phase 2, deliberate):**

- The stdin fix is an explicit `System.IO.StreamReader([Console]::OpenStandardInput(), UTF8Encoding($false, $true))`; strict decoding means malformed bytes THROW, so the driver names the fault on stderr and exits 4 after `Send-ReleaseAll` rather than typing U+FFFD. The `-ReleaseAll` one-shot stays before the reader is constructed, so that path never opens stdin.
- The live GUI smoke lives in `test/live/DesktopGuiInput.live.test.ts`, gated on `FORGE_LIVE_DESKTOP_GUI=1`, so it is skipped by `npm run ci` and reported as skipped — not as a pass. It owns every window it touches by a unique fixture filename (never a generic title), refuses to run on tabbed-Notepad systems with a pre-existing Notepad, and saves/restores the user's clipboard.
- Codex's final harness review tightened the clipboard preflight to allow only actual plain-text formats (`GetFormats(false)`), made cleanup conditional on a clipboard write, and registered the launched background job before awaiting its observation. These protect a refusal path, custom clipboard formats, and a launch error respectively.
- **Harness defects found while writing it (not driver defects).** Three, each now pinned by the test itself:
  1. Reading the clipboard back through Windows PowerShell 5.1 stdout uses the OEM console code page (this host: `ibm737`), which corrupts the *measurement* while the clipboard itself holds the exact text. The test sets `[Console]::OutputEncoding = UTF8` before `Get-Clipboard -Raw`, and `beforeAll` asserts that harness round trip first so a later failure names the driver, not the reader.
  2. Comparing a saved clipboard string against a re-read one through PowerShell **stdout** disagrees on trailing newlines alone (measured 34 vs 32 chars for 30 characters of content). The snapshot is therefore written to a file and the restore is verified INSIDE PowerShell with `-ceq`.
  3. `Clipboard.Flush()` exists only on .NET Core / PowerShell 7; Windows PowerShell 5.1 runs .NET Framework, where the method is absent and calling it printed a `MethodNotFound` error on every restore. It is now invoked only when `GetMethod('Flush')` finds it.
- **The live harness may not damage the owner's environment.** It refuses before touching anything if the clipboard holds a format it cannot restore (image, file-list, HTML, RTF, audio); a plain-text or empty clipboard is snapshotted and restored with verification. Cleanup stops jobs through the SAME `backgroundExecutionManager` singleton the tool used (a second manager would silently no-op and leave Notepad on the user's desktop), then VERIFIES each pid is gone and each fixture window is off screen, and fails loudly rather than swallowing a cleanup error. No fixture directory is created unless the live gate is on, so a fully skipped run leaves no temp artifact.
- `PowerShellTransport` gained a test-only `preferredExecutable` constructor pin and a `driverExecutable` getter so the 5.1 fallback can be exercised on a host where `pwsh` is installed, and so a run can NAME the engine that served it. Its spawn flags are unchanged — `windowsHide: true` there stays, per item 3.

### Phase 3 — reduce bad-selector latency and make VS Code control optional

1. Set an explicit **5,000 ms** timeout for selector/index locator actions (`click`, `fill`, `hover`, selector-scoped `press`, selector-scoped `scroll`) in `BrowserSessionManager.ts`. Keep navigation's 30-second timeout. Preserve Playwright's cause in the error and add the tool/action/selector context; do not convert a timeout to success or retry automatically. Test a missing selector and a permanently hidden element fail within the bound, and a valid element appearing after a short delay succeeds. Adjust the timeout only from measured valid-page evidence and document the new bound.
2. Add `permissions.desktop.allow_vscode: false` to the existing `DesktopPermissionSchema` in `src/config/browserSchema.ts`, the `ForgeConfig` type in `src/config/types.ts`, and `config/config.example.yaml`. It has no effect while `permissions.desktop.enabled` is false. The opt-in applies only to process name `code`/`code.exe`, never to title or `Chrome_WidgetWin_1` class matching. Keep the other editor names, UAC/secure desktop, and taskbar unconditionally refused. Update `targetWindowGate.ts` to accept the policy. Wire a live config getter from `makeDesktopTools(getConfig)` into the existing singleton `PowerShellDesktopDriver`/gate; do not capture the Boolean once at factory creation, create a second gate, or read `.forge/config.yaml` directly in the driver.
3. Recheck the editor policy **before every input**, including input through an old `capture_id`: both the current-target path (`requireApproved`) and the capture-bound path (`resolvePoint`/`checkAgainst`) must refuse a now-disallowed Code target. On revocation, clear the Code approval and its capture records, without dropping unrelated window approvals/captures. Re-enabling does not resurrect an old approval: `desktop_focus_window` or a newly approved window capture must bind it again. Preserve HWND, pid, process start time, foreground, and point checks. Recheck the live policy in the handler after approval as well, since config or target can change while a confirmation is pending.
4. For a Code target, require an explicit **per-call** confirmation for all six input tools: `desktop_move_mouse`, `desktop_click`, `desktop_drag`, `desktop_scroll`, `desktop_type`, and `desktop_press`, even when `consequential` is false or the tool has `autoApprove: true`. Extend the existing approval predicates in `desktopApprovals.ts` and registrations in `desktopTools.ts`. For coordinate tools, derive the target from the supplied `capture_id`; for type/press, use the current approved target. Expose read-only target details from the driver to these predicates rather than duplicating gate state. Compose Code confirmation with the existing consequential and system-chord dangerous metadata, retaining the stronger warning. Approval text must name the Code window and action. The binding approval from `desktop_focus_window` or `desktop_capture` is not a substitute for input confirmation. This prevents the opt-in alone from silently driving Forge's own chat input.
5. Update `test/unit/targetWindowGate.test.ts` for default refusal, ordinary Code approval when opted in, fork/devenv/UAC/taskbar refusal in both configurations, and policy revocation after an existing approval. Add tool-layer tests that each of the six Code-target inputs requests confirmation, including the currently auto-approved move/scroll paths; a non-Code target retains its existing approval behavior; consequential/system-chord warnings remain dangerous; and an old capture cannot act after revocation or re-enable. A manual smoke test may use a disposable VS Code window and harmless text, never the live Forge chat input or a command that reloads the extension host.
6. Update `docs/BROWSER_DESKTOP_TOOLS.md`, the tool descriptions, and the original `docs/plans/BROWSER_DESKTOP_USE_TOOLS_PLAN.md` status/acceptance entries that currently say VS Code is **always** refused. Document the explicit opt-in, per-action confirmation, visible GUI launch, monitor-index meaning, coordinate bounds, and inspect/index snapshot behavior. Do not promise that `browser_press` operates browser chrome or DevTools.

**Implemented shape (Phase 3, deliberate):**

- The 5 s bound is a per-call `{ timeout: LOCATOR_ACTION_TIMEOUT_MS }` on each locator action plus a
  `withLocatorActionTimeout` wrapper that names the tool, action, and target and keeps the Playwright
  cause on `cause` **and** quoted in the message. Navigation keeps its own 30 s. A bare keyboard
  `browser_press` (no selector) is deliberately not wrapped: there is no element to wait on, so there is
  nothing to bound. The bound lives in a new stateless owner, `src/tools/browser/browserActionGuards.ts`,
  alongside `requireViewportPoint` (the Phase 1 coordinate rule, moved out of the manager so the rule is
  unit-testable without a browser and has one implementation). `BrowserSessionManager` stays the sole owner
  of sessions, tabs, origins, and inspection snapshots; the guard module calls no transport.
- `allow_vscode` is threaded as a **getter** (`getDesktopDriver(policy?)` → `setPolicySource`), never a
  captured Boolean, and `PowerShellDesktopDriver.currentPolicy()` reconciles held state on every read.
  `revokeRefusedCodeTargets` lives in `targetWindowGate.ts` (not the driver) so the driver stays under the
  500-line gate; it drops **every** capture record bound to a refused Code window, including ones a
  superseded approval still left addressable, and leaves unrelated windows' approvals and captures alone.
- The per-input policy re-check is applied on **both** paths — `requireApproved` (type/press) and
  `checkAgainst` (capture-bound coordinates) — via one shared `policyRefusalFor`, so the approve-time
  refusal and the recheck cannot drift. `requireApproved` checks its local copy of the target so the
  refusal still names the revoked window instead of reporting a bare "no approved target". The
  unknown-`capture_id` refusal also says a revoked target's captures are dropped, so a stale id after
  revocation is not mistaken for a typo.
- The six Code confirmations are composed with the existing consequential / system-chord predicates by
  `composeApprovals`, which keeps `dangerous` if any part is dangerous and shows **every** reason, so a
  `win+r` into a Code window names both. `ToolDispatch` asks whenever `approval()` returns anything, so
  the two `autoApprove: true` tools are gated too — pinned by a test rather than assumed. Coordinate tools
  declare `capture_id` as required, so the prompt always names the window the call will act on, and an
  unknown `capture_id` gets no invented prompt.
- `isSystemChord` moved from `PowerShellDesktopDriver.ts` to the `DesktopDriver.ts` contract (re-exported
  for existing importers) purely to keep the driver under 500 lines with one implementation of the rule.

## State × lifecycle ledger

| State | Creation and owner | Reload/restart behavior | Failure and cleanup |
| --- | --- | --- | --- |
| `show_window` | One `exec_command` call, handled by `BackgroundExecutionManager` | Not persisted; each new launch chooses explicitly | Existing execution tracking applies to the spawned process only; a launcher child is not falsely claimed as owned or stopped. |
| VS Code control opt-in | User's `permissions.desktop.allow_vscode`, validated by `src/config/browserSchema.ts`; live getter supplied through `makeDesktopTools` | Re-read on every approval and input, including capture-bound input; absent means false | Turning off clears only Code approval/captures; invalid config surfaces as an error. A later opt-in requires fresh approval and per-call input confirmation. |
| Browser inspection indices | Per-page, in-memory snapshot and stable element identities in `BrowserSessionManager` | Old handles disposed and snapshot cleared on replacement/navigation/tab close/browser close/restart | Missing/changed/ambiguous target refuses and asks for a fresh inspect; no action on a newly assigned index or an identical replacement node. |
| Monitor ordering | Enumerated by the existing desktop driver per request | Primary remains 0; remaining displays follow the documented deterministic order | Removed display/index returns a clear range error; no capture of the whole virtual desktop in its place. A fractional/negative/nonfinite index is refused at BOTH the tool handler and the driver entry, before any request reaches PowerShell's `[int]` cast. A monitor response that cannot name its display (missing/mismatched `monitor_index`, count not containing the index, empty device) is a refusal — never a capture rendered as `monitor ? of ?`. |
| Window listing rows | `list_windows` response, decoded per row by `PowerShellDesktopDriver.listWindows` | Re-enumerated per call; nothing persists across calls | A row with malformed geometry is dropped and NAMED in the result as a `desktop_windows` protocol error for that HWND — never rendered as a plausible `0×0`. A missing/renamed `windows` array throws a named protocol error rather than reporting an empty desktop. |
| Desktop driver request stream | `PowerShellTransport` child and JSON-line protocol | Child respawns after exit; fresh encoding initialization precedes reads | Request timeout rejects; teardown still releases held keys/buttons. |

## Acceptance and handoff

- Re-run the report's four-tier smoke sequence on this Windows host. Record each first/second attempt and verify effects with screenshots or clipboard round trips. Use known valid selectors for the pass rule; test wrong selectors separately for fast, clear failure.
- For each phase, record changed files, the source finding it resolves, failing-before/passing-after test evidence, `npm run ci` exit code, and the commit hash. Before each commit, re-read the original report and the relevant section of `docs/plans/BROWSER_DESKTOP_USE_TOOLS_PLAN.md`; update acceptance/status if shipped behavior differs. Do not silently broaden scope or reset an agent conversation because a fix is difficult.
- Repeat monitor capture and desktop type on the user's mixed-DPI, multi-monitor setup if available; the current report exercised only one reported DPI scale. Do not mark those combinations verified if they were not run.
- Keep the user's existing Notepad and other non-test windows untouched. Close only windows and processes created by the retest.
- Start only from a clean worktree after the Telegram release. Keep this plan's preparation commit separate, inspect `git status --short --untracked-files=all` before every phase commit, stage only owned files, and finish with no modified or untracked repository files.
- Before the final package gate, bump `package.json` to the next unused release version and add the matching `CHANGES.md` heading/entry; `CHANGELOG.md` is generated, not the source of truth. The existing same-version VSIX guard must not be bypassed or its artifact overwritten. Run `npm run ci`, `npm run package`, `git diff --check`, and inspect `git status` after the last source, test, changelog, or plan edit. Record exact exit results, test counts, skipped live tests, and remaining live-system risk.

## Phase commit and test record

Each phase is one commit; only that phase's files were staged, by name. `npm run ci` was green before each commit.

| Phase | Commit | Source findings resolved | Test evidence | `npm run ci` |
| --- | --- | --- | --- | --- |
| Preparation (plan committed) | `5e108ef` | plan was untracked | n/a (docs only) | n/a |
| 1 — truthful read and input results | `565c2b4` (prettier correction `318cf17`) | §3.2 inspect throws; §3.1 `0×0` rects; §3.7 `BitBlt` from `user32.dll`; ignored `monitor` index; §3.8 out-of-viewport success; index-identity race found in review | `test/integration/BrowserTools.test.ts` inspect/identity/coordinate cases; `desktopDriver` listWindows fake-transport tests; monitor capture tests | exit 0 |
| 2 — desktop text and visible GUI launch | `8881b18` | §3.10 Unicode corruption on stdin; §3.3 hidden background GUI launches | `test/integration/DesktopTransport.test.ts` echo round trips on both engines; `test/unit/execShowWindow.test.ts` (10 tests); `test/live/DesktopGuiInput.live.test.ts` (3 tests, env-gated) ran live 3/3 on 2026-10-05 | exit 0 — 414 passed / 7 skipped files, 4289 passed / 44 skipped tests |
| Release (version + `CHANGES.md`) | `89cae66` | n/a (release preparation) | `npm run ci` **on that commit**: exit 0 — 427 passed / 7 skipped files, 4409 passed / 41 skipped tests, 43.16 s; `build` and `check:bundle` report `forge-llm@0.16.87` | exit 0 |
| 3-follow-up — `browser_type` on a `<select>` (found in live verification, 2026-10-06) | the `fix(browser): type into a <select> …` commit on `main`, child of `c3391e5` (hash reported to Codex and the owner rather than pasted here, so this row cannot go stale) | §Phase 1 item 4's "use `fill` where supported" was implemented as an editability **guess** from inspected facts, which claimed a `<select>` was fillable; Playwright's `fill()` rejects it, so the call died as a raw 5 s timeout with no usable reason | `test/unit/BrowserSelectInput.test.ts` (17), `test/integration/BrowserSelectInput.test.ts` (6, real headless Chrome), `test/unit/BrowserInspectRules.test.ts` (mode instead of editable) | **exit 0** with the complete source/test change in the tree — 431 passed / 7 skipped files, **4445 passed / 41 skipped** tests (4486), 40.18 s, 02:28–02:29 local; `build` and `check:bundle` clean. The only edit after that run is this docs row. |
| 3 — selector latency and optional VS Code control | `4b744b8` | §3.5 30 s bad-selector wait; §4 VS Code policy change; per-input policy revalidation; per-call Code input confirmation | `test/unit/browserActionGuards.test.ts` (10), `test/unit/targetWindowGate.test.ts` (26), `test/unit/desktopVsCodePolicy.test.ts` (8), `test/unit/desktopCodeInputApproval.test.ts` (9), `test/unit/desktopTools.test.ts` (9), `test/unit/desktopApprovals.test.ts` (6) = 68; `test/integration/BrowserTools.test.ts` 5 s-bound case (9 tests, 38.4 s, real headless Chrome) | exit 0 at `782b0d3` — 427 passed / 7 skipped files, **4409 passed / 41 skipped** tests |

Phase 3 review notes (independent re-read against items 1–6 at `782b0d3`, 2026-10-06): all six items are
implemented, documented, and tested; **no substantive defect found**. Two points confirmed rather than assumed:
`ToolDispatch` (`approvalMetadata !== undefined || (!reg.autoApprove && …)`) forces the prompt for the two
`autoApprove: true` input tools, and `desktop_*` coordinate tools declare `capture_id` as **required**, so
the Code prompt always resolves the window the call will actually act on. The four commits after `4b744b8`
touch no Phase 3 file, so the review at HEAD is the review of the shipped code.

## Four-tier smoke re-run (this Windows host, 2026-10-06)

Re-run of `docs/DESKTOP_BROWSER_TOOL_TEST_REPORT.md` § 2 on the current build. Attempt numbering is per
capability. "Effect verified" means a screenshot, a clipboard read, or a refusal that demonstrably
prevented the effect — not a success string.

### Tier 1 — read-only

| Call | Attempt | Result | Effect / evidence |
| --- | --- | --- | --- |
| `desktop_windows` | 1 | ✅ pass | 9 windows with **real** rects (VS Code `-8,-8 3856×1616`, Chrome `130,0 1693×1533`). §3.1 `0×0` is gone. |
| `browser_open` | 1 | ✅ pass | Ephemeral Chrome, tab `t1`. |
| `browser_inspect` (blank page) | 1 | ✅ pass | "No interactive elements found on this page." — the empty-page contract, not the old `undefined.length` throw. |
| `browser_inspect` (5 controls) | 1 | ✅ pass | 5 numbered `{index,role,text,selector,bbox}` entries; unique selectors (`#q`, `#go`, `html > body:nth-of-type(1) > a:nth-of-type(1)`, `#s`, `#ta`). |
| `desktop_capture monitor:0` | 1 | ✅ pass | Names its display: `monitor 0 of 1 (\\.\DISPLAY9)`, captured region `3840×1600` physical vs image `1344×560`, `dpi_scale=1`, read-only note. |
| `desktop_focus_window` (VS Code, live config) | 1 | ✅ pass (refusal) | `refusing to control a VS Code window (…) … set permissions.desktop.allow_vscode: true`. Default-off confirmed against the real config. |

### Tier 2 — typing round-trip

| Call | Attempt | Result | Effect / evidence |
| --- | --- | --- | --- |
| `browser_type` by index, `T2OK 🚀你好 café` | 1 | ✅ pass | `browser_screenshot` shows all glyphs in the input; typed into element 0 by identity, not by re-count. |
| `exec_command notepad … show_window:true` (background) | 1 | ⚠️ my misuse | I passed `notepad.exe` as both command and `args[0]`, so Notepad opened an "Untitled" document. Killed only that test-owned pid (`26672`). |
| same, correctly | 2 | ✅ pass | Launched visibly and found in `desktop_windows` as a fixture-named window; the launcher/child caveat was reported by the tool. |
| `desktop_focus_window` (fixture window) | 1 | ✅ pass | Bound HWND 10750346. The report's "Windows refused to focus (focus lock)" blocker did **not** recur on this host. |
| `desktop_type` `café Γειά 你好 😀 tail` | 1 | ✅ pass | Window capture shows the exact text. §3.10 corruption is gone. (The tool's "20 character(s)" counts UTF-16 units; the emoji is one code point.) |
| `browser_click` bad selector `#definitely-not-here` | 1 | ✅ pass | Refused in **≈5 s** (wall clock 00:04:56 → 00:05:xx), naming tool/action/selector and preserving the Playwright cause. §3.5's 30 s is gone. |
| `browser_click (1500,400)` out of viewport | 1 | ✅ pass | Instant refusal naming the point and the `1280×800` viewport; no click dispatched. §3.8 confirmed fixed. |

### Tier 3 — geometry

| Call | Attempt | Result | Effect / evidence |
| --- | --- | --- | --- |
| `browser_press Control+A` → `Control+C` | 1 | ✅ pass | Accepted on the focused input. **This wrote the user's clipboard — see the clipboard note below.** |
| `read_clipboard` | 1 | ✅ pass | Returned `T2OK 🚀你好 café` byte-exact — the round trip the report needed a screenshot for. |

### Tier 4 — self-referential + browser loop

| Call | Attempt | Result | Effect / evidence |
| --- | --- | --- | --- |
| `browser_new_tab` / `browser_tabs` | 1 | ✅ pass | `t2` opened; active-tab marker on `t2`. |
| `browser_click index:1` on the **uninspected** tab `t2` | 1 | ✅ pass (refusal) | `no inspection for this tab; call browser_inspect first` — indices are per-tab, not global. |
| `browser_click index:1` on `t1` **after navigation** | 1 | ✅ pass (refusal) | Same refusal: the snapshot was dropped by the main-frame navigation, so an old index cannot resolve against a new page. |
| `desktop_focus_window` VS Code | 1 | ✅ pass (refusal) | Refused under the live config (see Tier 1) — the §4 guard still holds by default. |
| `browser_close` | 1 | ✅ pass | Session closed. |

**Cleanup:** browser session closed; the fixture Notepad pid (`26676`) and the misopened one (`26672`) killed
via `taskkill`; the fixture file `%TEMP%\forge_phase2_smoke_20261006.txt` removed. No user window was
captured, focused, typed into, or closed. Screenshots went to `~/.forge/screenshots/<conversation-id>/`,
outside the workspace.

### Clipboard: the Tier 3 round trip overwrote the user's clipboard — not restored

The Tier 3 copy round trip **was** a write to the user's clipboard, and its previous content is gone.
Exact order, from tool timestamps:

| Time | Event | Clipboard state |
| --- | --- | --- |
| 23:58 | `Get-Clipboard -Raw` probe | Returned an **empty string** — no *text* present. |
| 23:59:57 | `test/live/DesktopGuiInput.live.test.ts` preflight | Found **`Bitmap, DeviceIndependentBitmap, Format17`** and refused before touching anything. A non-text payload was already on the clipboard, before any copy I issued. |
| 00:07 | my `browser_press Control+C` (Tier 3) | **Replaced that clipboard content with text.** |
| 00:10 | `read_clipboard` | Returned `T2OK 🚀你好 café`. |

No snapshot of the original clipboard was taken and nothing was restored, so the image that was there
**cannot be restored from a snapshot made in this run — no snapshot was taken**. Two things follow,
stated rather than glossed:

- The user's clipboard was **not** left untouched. The Tier 3 result is still a valid observation (the
  bytes round-tripped exactly), but it cost the user a clipboard image to obtain.
- "No Forge code calls `Set-Clipboard`" is **not** a safety argument. `Set-Clipboard` / `SetImage` appear
  nowhere in `src/`, but the input tools can drive `Ctrl+C` in a focused app, and that writes the
  clipboard. Any future clipboard round trip must snapshot and restore first — which is exactly what the
  live harness's preflight does, and why it refused here.

For a retest: prefer a verification that does not touch the clipboard (a window screenshot), or run the
env-gated harness only after the user has cleared it, since that harness snapshots and restores.

## Package and install record (2026-10-06)

| Item | Value |
| --- | --- |
| Release commit | `89cae66` — `chore(release): 0.16.87`; staged by name (`package.json`, `CHANGES.md`), `git diff --cached --check` clean, nothing pushed, no tag |
| `npm run ci` on `89cae66` | **exit 0** — 427 files passed / 7 skipped, 4409 tests passed / 41 skipped (4450), 43.16 s, 00:52–00:53 local; `build` and `check:bundle` report `forge-llm@0.16.87` |
| Artifact | `forge-llm-0.16.87.vsix` — 12,274,964 bytes, 135 files, built 00:29:56, SHA-256 `5180D001E0E9FA7E674E8507BB549A653824FBC12772BDEA105237439E9E6430` (re-verified 00:52 before install) |
| Install | **Installed** 00:52:23 via the local VS Code CLI: `Code.exe <commitHash>\resources\app\out\cli.js --install-extension forge-llm-0.16.87.vsix` with `ELECTRON_RUN_AS_NODE=1`; exit 0, `Extension 'forge-llm-0.16.87.vsix' was successfully installed.` (the `url.parse()` DeprecationWarning is benign). `~/.vscode/extensions` now holds `efsoo.forge-llm-0.16.87` alongside `efsoo.forge-llm-0.16.86` |
| Not done | No Reload Window, no push, no tag, no publish — each needs its own GO. The running window still executes the pre-reload build, so 0.16.87's behaviour is **not yet live-verified in this session** |

**Package-guard limitation.** The `.vsix` was built at 00:29:56, after the last source, version, and `CHANGES.md` edit, and `docs/**` is excluded from the package by `.vscodeignore`. The docs commits that follow therefore do not change the artifact, and the same-version `.vsix` must **not** be rebuilt or overwritten after the final docs edit — doing so would replace the exact bytes that were hashed and installed with no version change to tell them apart. Any further source edit after this point requires a new version and a fresh package gate.

## Post-release finding: `browser_type` refused every dropdown (2026-10-06)

Found while answering the owner's question "what about the browser properties — is it working", not by the
smoke matrix above. `browser_type` against a `<select>` (VS Code's Settings page is the obvious case) failed.

**Root cause.** Phase 1 item 4 says "use `fill` where supported and surface a clear noneditable-target error".
What shipped was a boolean `fillableFromFacts` computed from the *inspected* role/tag/text, and it classified
`<select>` (and `[contenteditable]`-styled roles) as fillable. The action then called `handle.fill()`, which
Playwright rejects for a non-text input. The user saw the Playwright error after the 5 s action bound — no
reason Forge owned, and no way to recover. The guard and the action disagreed about the same element, and the
guard was the optimistic one.

**Fix.** One decision, computed once, carried in the snapshot instead of re-derived:

- `browserInspect.ts` now exports `inputModeFor()` returning `'fill' | 'select' | 'none'`; `IndexTarget.mode`
  replaces `IndexTarget.editable`. The inspection verdict and the action can no longer disagree, because the
  action reads the mode the inspection stored.
- New module `src/tools/browser/browserTextInput.ts` owns the routing: `'fill'` → `handle.fill()`;
  `'select'` → read the option list page-side, match **exact label then exact value**, `selectOption({index})`,
  then read the selection back and report what is selected now; `'none'` → named refusal that lists the
  available options for a dropdown.
- The selector (non-index) path in `BrowserSessionManager.type()` routes through `typeIntoLocator()` and
  bounds its tag-read `evaluate` at 5 s, so it cannot reintroduce the 30 s default this plan removed.

**Verification.** `npx vitest run` on the eight browser files: 78 passed. Full `npm test`: exit 0 — 431 files
passed / 7 skipped, **4444 tests passed / 41 skipped**. `npx eslint src/tools/browser/...` exit 0; line counts
under the 500 gate. `npm run ci` result recorded in the row added to the table above.

**Not verified live.** The dropdown path is covered against real headless Chrome in
`test/integration/BrowserSelectInput.test.ts`, but the original report's own scenario — VS Code's Settings
page, which is a webview Forge does not control — was not re-run. `browser_inspect` on a VS Code Settings
page still returns nothing usable, because Playwright cannot see that webview; that is a pre-existing scope
limit of the browser tools, unchanged by this fix, and it is why "the browser properties" are still not
readable through these tools.

## Limitations and unverified live cases

These were **not** run. They are recorded as unverified, not as passing.

1. **The env-gated live GUI harness refused on this host.** `FORGE_LIVE_DESKTOP_GUI=1 npx vitest run
   test/live/DesktopGuiInput.live.test.ts` exits 1 with 3 tests skipped: its own clipboard preflight found
   `Bitmap, DeviceIndependentBitmap, Format17` — formats it cannot restore — so it refused before touching
   anything. That is the guard working as designed. I did **not** clear the user's clipboard to force it.
   `npm run ci` reports those 3 tests as skipped. The same payload was verified live by window screenshot
   instead, which observes the same effect but is not the harness's assertion and is not a CI pass. That
   harness did pass 3/3 live on 2026-10-05 (Phase 2 record above) — the 2026-10-06 refusal is a host-state
   condition, not a regression. Separately, my own Tier 3 `Ctrl+C` **did** overwrite that clipboard content
   with no snapshot or restore — see "Clipboard: the Tier 3 round trip overwrote the user's clipboard" above.
2. **Mixed-DPI multi-monitor capture is unverified on this host.** It reports exactly one display
   (`monitor 0 of 1`, `\\.\DISPLAY9`, 3840×1600, `dpi_scale=1`). So the second-monitor ordering, the
   out-of-range refusal, and a non-1.0 DPI scale in the monitor path have unit/driver coverage only. The
   report's single-DPI observation is still the only live DPI evidence.
3. **The `allow_vscode: true` opt-in was never exercised live.** Exercising it means editing the user's live
   `.forge/config.yaml`, which this plan forbids. The live config has `desktop.enabled: true` and **no**
   `allow_vscode` key, so the default-off path is what ran. Approving a real Code window and the six
   per-call confirmations rest on the 43 unit/driver tests plus the live default-off refusal.
4. **The optional manual disposable-VS Code-window smoke (item 5) was not run**, for the same reason, and
   because a wrong keystroke there lands in the editor Forge itself runs in.
5. **`show_window` was verified for a GUI app only.** Console helpers staying hidden is covered by
   `test/unit/execShowWindow.test.ts`, not by a live A/B this session.
6. **DevTools/browser-chrome keys remain unsupported by design** (report §7): no fix, and the docs now say
   `browser_press` does not drive browser chrome.
