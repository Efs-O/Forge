# Phase 1 before-commit report — desktop/browser tool repair

Date: 2026-10-05. Owner: Strata (implementing), Codex (supervising).
Plan: `docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md` § "Phase 1 — restore truthful read and input results".
Status: implementation and gates complete; Codex review round 1 findings resolved. **NOT COMMITTED.** 20 phase files staged by name.

## Codex review round 1 — findings and resolution

1. **Monitor index silently coerced.** Schema now declares `monitor` as
   `{ type: 'integer', minimum: 0 }` (the repo's existing convention), and the
   value is validated at BOTH boundaries by one shared `assertMonitorIndex(index:
   unknown)` in `DesktopDriver.ts`: the tool handler reads the RAW arg (no `num()`
   default) and validates it once `kind` is resolved (nothing is sent in between), and
   `PowerShellDesktopDriver.capture` validates again so a direct driver call cannot skip
   it. A fractional, negative, or
   non-finite index therefore never reaches PowerShell's `[int]` cast. New tests assert
   the throw **and** that no `capture` request was sent (`transport.sent` / recorded
   handler targets stay empty) for `0.5, -1, -0.5, NaN, Infinity, '0', true`.
2. **Monitor capture accepted absent/mismatched metadata.** `DesktopCapture` is now a
   discriminated union (`DesktopWindowCapture` / `DesktopMonitorCapture`): the fields that
   make a capture truthful about what it captured are REQUIRED on the branch that has
   them. `readMonitorMetadata` refuses a response whose `monitor_index` is missing or not
   a whole number, whose `monitor_count` is missing/zero, whose index is not the requested
   display, whose index falls outside the reported count, or whose `monitor_device` is
   empty — each named. `desktopTools.ts` renders `monitor N of M (device)` from required
   fields, so `?` is unreachable. The "old driver shape is okay" test was **replaced** by
   four refusal tests (missing metadata, mismatched index, count-not-containing-index,
   empty device).
3. **`desktop_windows` malformed rect.** Kept deliberately per-row (one unreadable row
   must not cost the model every other window), but the result now names it a
   `desktop_windows protocol error for N window(s): … (HWND …)` instead of a generic NOTE,
   and the plan (Phase 1 item 4 + a new "Window listing rows" ledger row) records that
   choice explicitly. A missing/renamed `windows` array remains a thrown whole-list
   protocol error.
4. **Untracked report.** This report is now staged as part of the phase commit —
   `.gitignore` re-admits `docs/reports/**` by rule and 26 earlier reports are tracked, so
   it belongs in the tree rather than in `.forge/tmp` (which is gitignored and would
   discard the review evidence).

Structural note: the protocol readers (`readCaptureFrame`, `readWindowRect`,
`readMonitorMetadata`, `num`/`str`/`optNum`) moved to `src/tools/desktop/driverProtocol.ts`
(126 lines) — the seam is "a required driver field is validated, never defaulted", and
keeping it in one module makes the rule auditable. `PowerShellDesktopDriver.ts` is now 405
lines, under the 500-line gate.

**Known non-validated field (deliberate, recorded for Phase 2):** `dpiScale:
num(r['dpi_scale'])` still defaults to 0. It is the one driver number that is
informational only — the coordinate transform uses the capture frame (capture/image sizes +
origin), never `dpiScale` (B6) — and it appears in exactly one place, the capture result
text (`desktopTools.ts`). A defaulted 0 therefore cannot misplace input; it would only
print `dpi_scale=0`. If any later phase makes it a term in a calculation, it must move to a
validating reader in `driverProtocol.ts` first. Source comments at both call sites say so.

## Scope

`git diff --cached --stat`: 20 files, 2828 insertions / 271 deletions.

Modified:

- `src/tools/browser/BrowserSessionManager.ts`
- `src/tools/browser/browserActionTools.ts`
- `src/tools/desktop/DesktopDriver.ts`
- `src/tools/desktop/PowerShellDesktopDriver.ts`
- `src/tools/desktop/desktopApprovals.ts`
- `src/tools/desktop/desktopDriver.ps1`
- `src/tools/desktop/desktopTools.ts`
- `test/integration/BrowserTools.test.ts`
- `test/integration/DesktopTransport.test.ts`
- `test/unit/desktopDriver.test.ts`

New:

- `src/tools/browser/browserInspect.ts` (449 lines) — page callbacks + pure rules + types
- `src/tools/browser/browserInspectionStore.ts` (199) — per-Page snapshot ownership
- `src/tools/browser/browserPrimitives.ts` (69) — shared lazy-require / origin / PNG reader
- `src/tools/desktop/driverProtocol.ts` (126) — validating protocol readers (review round 1)
- `test/unit/BrowserInspectRules.test.ts`
- `test/unit/BrowserInspectionStore.test.ts`
- `test/unit/BrowserInspectReaderSync.test.ts`
- `test/unit/desktopCaptureToolBoundary.test.ts` (7) — tool-boundary monitor-index refusal + skip reporting
- `docs/reports/PHASE1_DESKTOP_BROWSER_BEFORE_COMMIT_2026-10-05.md` — this report

Line-count gate (measured with `git grep -c ""`): every file under the 500-line `max-lines`
stop — manager 457, `browserInspect` 449, `desktopTools` 452, PS driver 405,
`driverProtocol` 126.
`BrowserSessionManager` remains the sole owner of sessions and snapshots; `InspectionStore`
is its data structure, not a second state owner. `browserPrimitives.ts` holds only
stateless shared helpers and is re-exported from the manager, so every existing import
site and the `vi.mock` seam the render tests use keep working.

## Design decisions

1. **§3.2 — the real defect.** `page.evaluate` evaluates a *string* as an expression, so the
   old stringified callback resolved to an unserializable function object, returned
   `undefined`, and the DOM code never ran. Fixed with a real callback plus one
   serializable `{selector, limit, nodeKey}` argument. `max` is clamped (default 50, hard
   ceiling). An empty page returns `[]`. An unexpected non-array result raises a named
   `browser_inspect` error rather than a silent empty list.
2. **Stable identity.** The per-Page snapshot retains a Playwright `ElementHandle` per entry.
   `uniquePath` builds the full `tag:nth-of-type(n)` chain from `html` down, using `#id`
   only when `querySelectorAll('#'+css.escape(id))` proves it unique. An index action
   rechecks *that handle* (attached, visible, enabled where applicable, expected role/text,
   plus a centre hit-test against overlays) and then acts on the same node. A unique
   selector plus a role/text comparison is explicitly rejected as insufficient — an
   identical sibling inserted before the target shifts an `nth-of-type` path onto the new
   node while both halves still match.
3. **Lifecycle** (plan's State × lifecycle ledger): `framenavigated` on the main frame → drop;
   page close → drop; browser close → `dropAll`; inspect → replace with disposal of the
   previous handles. Stale-URL resolution also drops.
4. **§3.1 — rects.** `readWindowRect` maps the nested `w.rect` the driver actually emits and
   requires finite `x`/`y` and positive finite `width`/`height`; `focusWindow` and window
   `capture` reuse it. Valid negative origins are preserved. `listWindows` now returns
   `{ windows, skipped }`: a malformed row is **named in the tool result**, not merely
   logged — the model never sees the log channel, and a list that quietly lost a window is
   a quieter version of the `0×0` row it replaces.
5. **§3.7 — capture.** `BitBlt` imported from `gdi32.dll` with `SetLastError`, its boolean
   checked, throwing with the Win32 error code. GDI bitmap/DC objects released in `finally`
   on both success and failure. `Capture-Region` is shared by the monitor and virtual-desktop
   paths. Monitors enumerated with `EnumDisplayMonitors`/`GetMonitorInfo`; primary first, then
   physical left, top, device name. `monitor: 0` is the primary display — never the virtual
   desktop — and an out-of-range index names the available range. Capture size is reported
   separately from the downscaled PNG size; `monitor_index`/`count`/`device` travel in the
   response and the `DesktopCapture` contract.
6. **§3.8 — coordinate bounds.** `requireViewportPoint` runs before dispatch for
   `browser_click`, `browser_hover`, `browser_scroll`, and `browser_drag`, naming the point
   and the viewport in the refusal.
7. **Bug found while testing (pre-existing, both old and new code).** `textContent` on
   `<input>`/`<select>`/`<img>` is `''`, not `null`, so the documented placeholder/value
   label fallbacks were dead code behind a strict `??` chain. `textFromFacts` now takes the
   first candidate with actual content.

## Failing-before / passing-after evidence

- **§3.2:** pre-fix `inspect` returned `undefined` and the handler threw
  `Cannot read properties of undefined (reading 'length')`; the new integration test asserts
  a populated list with real selectors.
- **§3.1:** HEAD's reader was temporarily restored and the 5 new rect tests run against it —
  **all 5 failed**: every window reported `x:0 y:0 w:0 h:0`; `focusWindow` *resolved* with a
  `0×0` rect; a renamed window-list field resolved to `[]` instead of erroring. With the fix,
  all 5 pass.
- **Self-correction recorded:** a `0×0` gate rect is not a silent pass. `inRect` is
  `x >= 0 && x < 0`, so it refuses *every* point — pre-fix users saw a misleading
  "point is outside the approved window's rect" for a window the driver had never described.
  The test comment and source comment now say that.

## Gates

- `npm run ci` → **exit 0** (type-check, lint, vitest, build, check:bundle), run after the
  last edit. **4271 passed | 41 skipped (4312)**; 413 test files passed | 6 skipped.
- `git diff --check --cached` → exit 0 (clean).
- ESLint: no `max-lines` error, no `no-console` warning (the skip reason moved into the
  model-facing result instead of a log call).

Test inventory (new / extended):

| File | Tests | Nature |
| --- | --- | --- |
| `test/unit/BrowserInspectRules.test.ts` | 16 | pure rules |
| `test/unit/BrowserInspectionStore.test.ts` | 11 | fake-page lifecycle + handle disposal |
| `test/unit/BrowserInspectReaderSync.test.ts` | 3 | the two in-page readers stay byte-identical |
| `test/integration/BrowserTools.test.ts` | 8 | real headless Chrome |
| `test/unit/desktopDriver.test.ts` | 34 | fake transport (14 new) |
| `test/unit/desktopCaptureToolBoundary.test.ts` | 7 | tool handler boundary (new) |
| `test/integration/DesktopTransport.test.ts` | 7 | real PowerShell child (4 new, read-only) |

## Skipped, not counted as live passes

- Second-monitor capture: a real `t.skip` — this host reports **1 display**. Mixed-DPI and
  multi-monitor combinations therefore remain **unverified**, per the plan's instruction not
  to mark them verified.
- Pre-existing skips: `test/live/*`, `videoExtractLive`, `AppSessionReplay.dom`,
  `ProcessGroupKill`.

## Live read-only verification

The scratch probes were converted into committed integration tests, not left as scratch:
11 windows with real nested rects including negative origins; monitor 0 captured at
3840×1600 physical → PNG 1344×560, origin `(0,0)`, device `\\.\DISPLAY9`; index 99 refused
with the available range; index −1 refused as out of range. All read-only — no mouse move,
no focus, no typing; the user's windows were untouched.

## Clean-worktree state

- **Blockers, not mine (do not stage, do not remove):** untracked
  `docs/reports/SESSION_AUDIT_TELEGRAM_UPGRADE_2026-10-05.md` and
  `docs/plans/SESSION_AUDIT_FIXES_PLAN.md` — another agent's files; the second appeared
  during this run. They are the only non-phase entries in `git status`.
- Mine and deleted: `scratch/ps1-parse-check.ps1`, `scratch/driver-readonly-probe.ps1`,
  `scratch/inspect-convention-probe.ts`.
- Flakiness noted: three unrelated tests (`RemoteDirectFileSend`, `agentTask`,
  `DeleteRestoreGitAwareness`) each failed once in earlier full-suite runs under parallel
  load and pass in isolation; none touches Phase 1 code. My live desktop tests were cut from
  4 PowerShell children to 1 to reduce the load this change adds. The final run is green.
- One intermediate CI run failed on a typo I had already corrected (`request` vs `requested`
  in `desktopApprovals.ts`); the reported green run started after that fix and after every
  other edit, and its vitest output shows `desktopApprovals.test.ts (6 tests)` passing.

## Proposed commit (single, Phase 1)

Subject: `fix(browser,desktop): truthful inspect identity, real monitor rects, gdi32 capture cleanup`

Body names §3.1, §3.2, §3.7, §3.8, the dead label-fallback fix, and the surfacing of skipped
window rows. No push. Staged files only, by name.
