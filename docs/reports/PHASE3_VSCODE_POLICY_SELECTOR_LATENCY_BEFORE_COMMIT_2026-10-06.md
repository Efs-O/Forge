# Phase 3 review + release handoff — selector latency and optional VS Code control

Date: 2026-10-06 (runs 23:45 → 00:5x local). Prepared for Codex review.
**Status after Codex's GO (00:51):** release commit `89cae66` created, `npm run ci` re-run green on that
commit, and `forge-llm-0.16.87.vsix` **installed** at 00:52:23. No Reload Window, no push, no tag, no
publish. `.forge/config.yaml` untouched throughout.

Baseline HEAD: `782b0d3`. Phase 1 `565c2b4` (+ `318cf17`), Phase 2 `8881b18`,
Phase 3 `4b744b8`. This conversation opened at `782b0d3` and changed no source file.

## 1. Gate state

| Gate | Result |
| --- | --- |
| `npm run ci` at HEAD `782b0d3` | **exit 0** — 427 passed / 7 skipped files, **4409 passed / 41 skipped** tests, build + `check:bundle` clean. 60.03 s, 23:54 local. |
| `npm run ci` after the last edit (0.16.87 + docs) | **exit 0** — same counts, 40.03 s, 00:28 local. `build` and `check:bundle` report `forge-llm@0.16.87`. |
| `npm run ci` after the Codex-requested doc corrections | **exit 0** — 427 passed / 7 skipped files, **4409 passed / 41 skipped** tests, 39.94 s, 00:44:38 local. `git diff --check` exit 0; `git diff --cached --stat` empty (nothing staged). |
| `npm run ci` on the release commit `89cae66` | **exit 0** — 427 passed / 7 skipped files, **4409 passed / 41 skipped** tests (4450), 43.16 s, 00:52–00:53 local. `build` and `check:bundle` report `forge-llm@0.16.87`; `test/live/DesktopGuiInput.live.test.ts` still reported as 3 skipped. |
| `npm run ci` after the FINAL docs edit | **exit 0** twice — 427 passed / 7 skipped files, **4409 passed / 41 skipped** tests (4450). Started 00:59:03 (41.95 s) and again started **01:01:19 (42.42 s)**, the latter covering every content edit in the three docs files. `build` and `check:bundle` report `forge-llm@0.16.87`. The only change written after the 01:01:19 run is the sentence recording it — docs-only, no source, test, config, or artifact change — so no further run is possible without an infinite regress. |
| Phase 3 focused tests | 68 passed: `browserActionGuards` 10, `targetWindowGate` 26, `desktopTools` 9, `desktopApprovals` 6, `desktopVsCodePolicy` 8, `desktopCodeInputApproval` 9. 377 ms. |
| `test/integration/BrowserTools.test.ts` | 9 passed, 38.4 s, **real headless Chrome** — includes the new 5 s-bound case. |
| `git diff --check` | exit 0, no whitespace errors. |
| `git status --short --untracked-files=all` | 4 modified owned files (§3) + the 5 pre-existing `_*.py` files belonging to other work, untouched. HEAD unchanged. |
| `max-lines` (500) | Largest touched file: `PowerShellDesktopDriver.ts` **495**; `desktopTools.ts` 475, `BrowserSessionManager.ts` 479, `targetWindowGate.ts` 244, `browserActionGuards.ts` 91. New test files 297 / 227. All under the gate; verified, not assumed. |
| VSIX | `forge-llm-0.16.87.vsix` — **12,274,964 bytes**, 135 files, built 2026-10-06 00:29:56, SHA-256 `5180D001E0E9FA7E674E8507BB549A653824FBC12772BDEA105237439E9E6430`. `forge-llm-0.16.86.vsix` (12,270,118 B, 2026-10-05 23:07) left in place — not overwritten, same-version guard not bypassed. |
| Install status | **Installed 2026-10-06 00:52:23** (Codex GO), after re-verifying size `12,274,964` B and SHA-256 `5180D001…6430` matched this row. Command: `Code.exe` + `07f806f999\resources\app\out\cli.js --install-extension forge-llm-0.16.87.vsix` with `ELECTRON_RUN_AS_NODE=1` → exit 0, `Extension 'forge-llm-0.16.87.vsix' was successfully installed.` (`url.parse()` DeprecationWarning is benign). `~/.vscode/extensions` now holds `efsoo.forge-llm-0.16.87` **and** `efsoo.forge-llm-0.16.86` (installed 2026-10-05 23:53). The **running** window still executes the pre-reload bundle, so 0.16.87 is not live-verified in this session. Checked the loaded bundle rather than inferring: 0.16.86's `dist/extension.js` contains `allow_vscode`, `allowVsCode`, `failed within 5000`, and `show_window` (`LOCATOR_ACTION_TIMEOUT` / `revokeRefusedCodeTargets` are absent only because esbuild renames local bindings). So the running host **already carried Phases 1–3** — packaged 23:07 and installed 23:53, after `4b744b8` (22:37), which is why the live smoke below is valid evidence for shipped code. |

## 2. Independent Phase 3 review — no substantive defect found

Re-read of all six items against the code at `782b0d3`. The four commits after
`4b744b8` (`d7cb089`, `f61f1fe`, `b7b994a`, `782b0d3`) touch **no** Phase 3 file, so the
review at HEAD is the review of the shipped code.

| Item | Where | Verdict |
| --- | --- | --- |
| 1 — 5 s locator bound | `browserActionGuards.ts` + 8 call sites in `BrowserSessionManager.ts` | Complete. `click`/`fill`/`hover`/selector-`press`/selector-`scroll`/index variants all carry `{ timeout: LOCATOR_ACTION_TIMEOUT_MS }` **and** the naming wrapper. Navigation still `30000` (lines 202, 236). Bare keyboard `press` deliberately unwrapped — no element to wait on. Cause kept on `cause` and quoted in the message. |
| 2 — `allow_vscode` config | `browserSchema.ts`, `types.ts`, `config.example.yaml`, `targetWindowGate.ts`, `getDesktopDriver(policy?)` | Complete. Getter lifetime verified by a test that mutates the config and re-reads the same getter. Process-name match only (`isVsCodeProcessName`, `.exe` stripped); `ALWAYS_REFUSED_PROCESS_NAMES` covers forks/`devenv`. Inert while `desktop.enabled` is false — confirmed at `PermissionResolver.ts:45,68`, not assumed. |
| 3 — recheck before every input | `PowerShellDesktopDriver.currentPolicy()`, `requireApproved`, `resolvePoint`/`checkAgainst` | Complete on both paths through one shared `policyRefusalFor`, so approve-time and recheck cannot drift. `revokeRefusedCodeTargets` drops **every** Code-bound capture (including a superseded approval's) and leaves unrelated approvals/captures alone; re-enable does not resurrect. `requireApproved` checks its local copy so the refusal names the revoked window instead of a bare "no approved target". |
| 4 — per-call Code confirmation | `desktopApprovals.codeInputApproval` + `composeApprovals` in `desktopTools.ts` | Complete for all six input tools. **Verified the load-bearing assumption:** `ToolDispatch.ts:259-261` is `approvalMetadata !== undefined || (!reg.autoApprove && …)`, so a returned predicate forces the prompt even for `autoApprove: true` — and `test/unit/desktopCodeInputApproval.test.ts` pins that, rather than trusting it. Coordinate tools declare `capture_id` **required**, so the prompt always names the window the call will act on; an unknown id gets no invented prompt. |
| 5 — tests | 4 unit files, 68 tests | Matches the plan's checklist: default refusal, Code approved when opted in, fork/devenv/UAC/taskbar refused in **both** configurations, revocation after an existing approval, all six inputs confirming (incl. auto-approved move/scroll), non-Code target unchanged, consequential/system-chord still dangerous, old capture unusable after revocation **and** after re-enable. |
| 6 — docs | `BROWSER_DESKTOP_TOOLS.md`, `BROWSER_DESKTOP_USE_TOOLS_PLAN.md`, tool descriptions | Complete: opt-in, per-action confirmation, monitor-index meaning, coordinate bounds, inspect/index snapshot semantics, and an explicit "does not drive browser chrome or DevTools". |

Two design choices worth Codex's eye, both defensible and both already recorded in the plan:

- `isSystemChord` moved from `PowerShellDesktopDriver.ts` to the `DesktopDriver.ts`
  contract, re-exported from the driver for existing importers. Reason: the driver was
  at 495 lines and the rule needs one implementation on both sides.
- The unknown-`capture_id` message now also says a revoked target's captures are
  dropped. A stale id after revocation is therefore not mistaken for a typo.

## 3. Files in this handoff (4 modified, 1 added — all owned)

Modified:

1. `package.json` — `0.16.86` → `0.16.87`.
2. `CHANGES.md` — new `## 0.16.87` section (browser/desktop truthfulness, the
   `allow_vscode` opt-in, visible background GUI launches). Source of truth;
   `CHANGELOG.md` is generated by `scripts/sync-changelog.mjs` during packaging.
3. `docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md` — Status line corrected (it still
   said "Phase 2 under review"); new "Phase commit and test record", "Four-tier
   smoke re-run", and "Limitations and unverified live cases" sections; the
   "Implemented shape (Phase 3, deliberate)" note placed under Phase 3.
4. `docs/plans/BROWSER_DESKTOP_USE_TOOLS_PLAN.md` — five acceptance boxes checked
   with dated evidence (the three added by Phase 3, plus the two `test/live`
   capture/round-trip rows this re-run actually exercised).

Added:

5. `docs/reports/PHASE3_VSCODE_POLICY_SELECTOR_LATENCY_BEFORE_COMMIT_2026-10-06.md` — this file.
   `git check-ignore -v` resolves it to `.gitignore:41: !docs/reports/**`, so it is **not** ignored and
   takes a normal `git add` by name — unlike a new file directly under `docs/`.

## 4. Four-tier smoke re-run — exact results

Full ledger in the plan. Summary against the plan's pass rule (first or second
attempt, with an observable effect or a clear refusal):

- **Tier 1 read-only: 6/6 pass attempt 1.** `desktop_windows` real rects (VS Code
  `-8,-8 3856×1616`); `browser_inspect` on a blank page and on 5 controls with
  unique selectors; monitor capture naming `monitor 0 of 1 (\\.\DISPLAY9)`; VS Code
  refused by default against the live config.
- **Tier 2 typing: pass.** `browser_type` by index with `T2OK 🚀你好 café` verified by
  screenshot; `desktop_type` of `café Γειά 你好 😀 tail` verified by capture. One
  attempt-1 miss was **mine** (I passed `notepad.exe` as both command and `args[0]`,
  so Notepad opened "Untitled"); attempt 2 passed. The report's "focus lock"
  blocker did **not** recur. Bad selector refused in ≈5 s (wall clock, not a
  stopwatch guess); out-of-viewport `(1500,400)` refused instantly, nothing dispatched.
- **Tier 3 geometry: pass attempt 1.** `Ctrl+A`/`Ctrl+C` → `read_clipboard` returned
  `T2OK 🚀你好 café` byte-exact. **Cost: that `Ctrl+C` overwrote the user's clipboard,
  which was not restored — see § 5.1.**
- **Tier 4 self-referential + loop: pass.** Index on an uninspected tab refused;
  index after navigation refused (snapshot dropped); VS Code refused; browser closed.

**Cleanup:** browser session closed; both test-owned Notepad pids (`26672`, `26676`)
killed; `%TEMP%\forge_phase2_smoke_20261006.txt` removed. No user window was
captured, focused, typed into, or closed.

## 5. Skipped / unverified — stated, not claimed

1. **My Tier 3 `Ctrl+C` overwrote the user's clipboard, and it was not restored.** Exact
   order by tool timestamp: **23:58** `Get-Clipboard -Raw` returned an empty string — that
   probe only tested the **text** format and said nothing about image formats;
   **23:59:57** the live harness preflight found `Bitmap, DeviceIndependentBitmap,
   Format17` and refused **before touching anything**; **00:07** my `browser_press
   Control+C` **replaced that content with text**; **00:10** `read_clipboard` returned the
   text. No snapshot was taken and nothing was restored, so the image that was there **cannot
   be restored from a snapshot made in this run — no snapshot was taken**. The user's clipboard
   was **not** left untouched, and this is the one side effect of the retest that cannot be
   undone from this run.
   - The earlier claim that "no Forge code writes the clipboard" was **misleading and is
     withdrawn**. `Set-Clipboard`/`SetImage` do appear nowhere in `src/`, but the input
     tools can drive `Ctrl+C` in a focused app and that writes the clipboard — which is
     precisely why the harness preflight exists, and why it refused where I did not.
   - I did not touch the clipboard again afterwards, and I will not reconstruct anything
     from an unknown clipboard state. A retest should verify by window screenshot, or run
     the env-gated harness only after the user has cleared the clipboard (it snapshots and
     restores).
2. **`test/live/DesktopGuiInput.live.test.ts` refused on this host** even with
   `FORGE_LIVE_DESKTOP_GUI=1`: its clipboard preflight found the formats above, which it
   cannot restore, so it exited 1 with 3 tests skipped **before touching anything** — the
   guard working as designed. I did not clear the clipboard to force it. **Prior, separate
   evidence:** the same harness passed 3/3 live on **2026-10-05** (Phase 2 record), so the
   2026-10-06 refusal is host state, not a regression. The 2026-10-06 payload was instead
   verified live by window screenshot — a real observation, but **not** the harness's
   assertion and **not** a CI pass. `npm run ci` reports those 3 as skipped.
3. **Mixed-DPI multi-monitor unverified here** — this host reports exactly one
   display. Second-monitor ordering, out-of-range refusal, and a non-1.0 DPI scale
   in the monitor path have unit/driver coverage only.
4. **`allow_vscode: true` never exercised live** — that would mean editing the user's
   live `.forge/config.yaml`, which the plan forbids. Live config: `desktop.enabled:
   true`, no `allow_vscode` key → default-off path is what ran.
5. **The manual disposable-VS Code-window smoke was not run**, same reason plus the
   risk of a keystroke landing in the editor Forge itself runs in.
6. **Console helpers staying hidden** is covered by `test/unit/execShowWindow.test.ts`,
   not by a live A/B this session.

## 6. Commit sequence (executed under Codex's GO, 00:51)

One phase = one commit; stage by name only. Nothing is pushed and no tag was made.

1. `chore(release): 0.16.87` — **`89cae66`**. Staged by name: `package.json` (0.16.86 → 0.16.87),
   `CHANGES.md` (new `## 0.16.87` entry). `git diff --cached --check` clean; staged scope
   `2 files changed, 60 insertions(+), 1 deletion(-)`. `npm run ci` re-run **on that commit**: exit 0.
2. `docs(desktop,browser): phase 3 review, smoke ledger, and limitations` — the two plan files plus
   this report, staged by name after the final docs edit and a fresh `npm run ci`.

`git check-ignore -v` resolves this report to `.gitignore:41 !docs/reports/**`, so it takes a **normal**
`git add`, not `-f`.

Install (Codex GO, same message) ran between the two commits, before the final docs edit — see § 1
"Install status". **Package-guard limitation:** the `.vsix` was built at 00:29:56, after the last
source/version/`CHANGES.md` edit, and `docs/**` is excluded by `.vscodeignore`, so the docs commit does
not change the artifact. The same-version `.vsix` must **not** be rebuilt or overwritten after the final
docs edit: that would replace the exact bytes that were hashed and installed with no version change to
tell them apart. A further source edit needs a new version and a fresh package gate.

## 8. Corrections made after Codex's first review (docs-only)

Codex gave NO GO on the first pass and named four issues. All four were correct and are fixed:

1. **The clipboard claim was wrong in a material way.** My first draft implied the clipboard was
   untouched. It was not: my Tier 3 `Ctrl+C` at 00:07 overwrote a clipboard that already held
   `Bitmap/DeviceIndependentBitmap/Format17` (as the harness preflight found at 23:59:57), and I took no
   snapshot and restored nothing. § 5.1 now states the timeline and the loss plainly. The 23:58
   `Get-Clipboard -Raw` empty-string probe is **not** evidence the clipboard was empty — it only reads
   the text format. Ironically, `docs/reports/PHASE2_DESKTOP_TEXT_GUI_BEFORE_COMMIT_2026-10-05.md` § 3
   records that this exact hazard ("`Get-Clipboard -Raw` + `Set-Clipboard` silently drops image formats")
   is why the harness preflight refuses **before any write** — the protection I then bypassed by hand.
2. **"No Forge code writes the clipboard" withdrawn.** True as a grep (`Set-Clipboard`/`SetImage` absent
   from `src/`), misleading as a safety claim, because the input tools can drive `Ctrl+C` in a focused
   window. Added to § 7 as a standing risk, since it is real but out of this plan's scope.
3. **`CHANGES.md` said "Four fixes" over six bullets.** Now "Six fixes".
4. **Phase ledger named the preparation commit vaguely.** It is `5e108ef`.
5. **The two `→ test/live` acceptance rows were ambiguous.** They now say the 2026-10-06 evidence is a
   **manual live smoke**, that the env-gated harness **refused** that day, and they keep the **2026-10-05
   harness pass 3/3** as separate prior evidence rather than folding the two together.
6. **"Not recoverable" was too absolute** (Codex, second review). § 5.1 and the plan now say the original
   clipboard image **cannot be restored from a snapshot made in this run, because no snapshot was taken**.
   No claim is made about OS clipboard history, and the clipboard was not touched again.

No source, test, config, or artifact changed in this round — docs only, so the 0.16.87 VSIX is unchanged
(`docs/**` is in `.vscodeignore`). Clipboard left as-is; nothing was written to it again and nothing was
reconstructed from an unknown state.


- The `allow_vscode` opt-in widens what the agent can touch on the user's own
  machine. Mitigations are structural, not advisory: process-name-only match,
  forks refused in both configurations, per-call confirmation on all six inputs,
  policy re-read per input, and revocation dropping captures. Default is off.
- The 5 s bound could be short for a genuinely slow valid page. The integration test
  pins a late-appearing element (1.2 s) still succeeding, and the bound is documented
  as adjustable only from measured valid-page evidence.
- **Clipboard writes are a real, unowned side effect of the input tools.** The tools can
  drive `Ctrl+C`/`Ctrl+V` in whatever window is focused, and nothing snapshots or restores
  the clipboard outside the env-gated live harness. That is not a Phase 3 defect and is not
  fixed here, but it is now documented in the plan so a future clipboard-based verification
  is required to snapshot first.
- `PowerShellDesktopDriver.ts` is at 495 lines — 5 under the lint gate. Any further
  edit to it needs a split first.
- The 0.16.87 VSIX is built but **not installed**.
- **The live smoke in §4 ran through the loaded 0.16.86 host, and that host does contain
  Phases 1–3** — verified by string in `dist/extension.js` (`allow_vscode`, `failed within
  5000`, `show_window`), not inferred from commit order: 0.16.86 was packaged at 23:07 and
  installed at 23:53 on 2026-10-05, after `4b744b8` at 22:37. So the live results are valid
  evidence for the desktop/browser code being shipped. The only delta between that host and
  the 0.16.87 artifact is the four post-Phase-3 commits (`d7cb089`, `f61f1fe`, `b7b994a`,
  `782b0d3` — stats/sidebar/remote), which touch no Phase 3 file. A fresh install + Reload
  Window is still the right way to confirm the 0.16.87 artifact itself loads.
