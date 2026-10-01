# Forge codebase audit — 2026-09-26

**Baseline:** `main` @ `4bcbcb5` ("Ship 0.16.56 agent messaging and Codex thread
release"), version `0.16.56`, working tree clean. Audit performed on Windows;
GitHub CI additionally covers ubuntu + macOS (not re-run here).

---

## 1. Quality gates

| Gate | Result |
| --- | --- |
| `npm run type-check` | **PASS** (exit 0) |
| `npm run lint` | **PASS** (exit 0) |
| `npm test` (full, run 1) | 2 failures — `NoControlCharacters` (5 s timeout), `RemoteHardening` "abandons a notification…" |
| `npm run ci` (full, run 2) | 2 failures — `RemoteCore` "delivers an enqueued host notification…", `ToolHarness` "all 79 registered native tools" (5 s timeout) |
| Each failed test re-run in isolation | **All 4 PASS** |
| `npm run build` | **PASS** |
| `npm run check:bundle` | **PASS** |

**Finding F1 (test reliability, medium):** four *different* tests failed across
two full-suite runs, and every one passes in isolation. These are load-sensitive
flakes, not product defects — this box runs the suite alongside a loaded
llama-server. Root causes, all the same shape (fixed 5 s vitest default timeout
on I/O- or child-process-bound work, or a timer-driven loop under a 1 s
`vi.waitFor`):

- `test/unit/NoControlCharacters.test.ts` — `git ls-files` + read of every
  tracked file under the default 5 s.
- `test/unit/ToolHarness.test.ts` — spawns `scripts/test-local-tools.mjs` as a
  child node process under the default 5 s.
- `test/unit/RemoteHardening.test.ts` "abandons…" — needs 10 delivery attempts
  (`MAX_ATTEMPTS = 10`) at retry delay 0 (the test passes `retryDelayMs = 0`;
  each attempt still does store I/O), while `vi.waitFor` defaults to 1 s.
- `test/unit/RemoteCore.test.ts` "delivers an enqueued host notification…" —
  polling loop racing the outbox loop.

**Fix (small):** give the two timeout-flaked tests an explicit timeout (e.g.
`{ timeout: 20_000 }` or `testTimeout` in `vitest.config.mts`) — and for the
two remote tests raise the **`vi.waitFor` bound itself** (pass an explicit
`timeout` option), since under load it is the 1 s / ~500 ms polling bound that
expires, not the test timeout. Until then `npm run ci` is unreliable on a
loaded machine and a red run carries no signal.

## 2. Release state — shipped versions are not tagged or pushed (high, process)

- `package.json` is at **0.16.56**; the newest tag is **`v0.16.52`**. Releases
  0.16.53–0.16.56 were built as local VSIXes (`forge-llm-0.16.54.vsix`,
  `forge-llm-0.16.56.vsix`) but never tagged.
- **`main` has 3 unpushed commits** (`866cc1b`, `d68a7a3`, `4bcbcb5`) — CI never
  ran on them, and per `docs/PUBLISH_METHOD.md` the tag path (which publishes
  Marketplace **and** Open VSX) requires a green pushed `main`.
- **Open VSX latest is 0.16.52** (verified via `open-vsx.org/api/Efsoo/forge-llm`
  at audit time — hours past the few-minute alias lag). 0.16.53–0.16.56 are not
  published there.
- Marketplace version could not be verified by fetch (JS-rendered page).

**Fix:** push `main`, wait for CI green on the three commits, then decide
whether 0.16.53–0.16.56 ship via the `v0.16.56` tag (publishes both registries)
or stay local. Do not tag a red/unpushed `main`.

## 3. Residual accepted risks (re-confirmed in current code)

These were adjudicated in `risk_report_2026-09-25-verification.md`; the code
still matches that verdict — they are design-posture risks, not bugs:

1. **`pwsh -File` runs model-selected scripts** (`src/tools/execHelpers.ts` bans
   only `-Command`/`-EncodedCommand`/`-enc`). Codex's review adds: the ban
   matches exact spellings only — `PS_DANGEROUS_FLAGS.includes(arg)` is
   case-sensitive (unlike the `SCRIPT_FLAGS` check, which lowercases), and it
   omits `-c`, which PowerShell accepts as an abbreviation of `-Command`. So
   `pwsh -command …` / `pwsh -c …` walk past the ban; the exposure is wider
   than first stated. Still mitigated by the `exec_command` approval gate
   (`src/sidebar/ToolDispatch.ts`) — but closing the case/alias gap is a
   one-line fix (`arg.toLowerCase()` + add `-c`, and arguably `-e`/`-w`).
2. **A broad `extra_file_roots` entry widens read/delete reach**
   (`src/util/WorkspacePaths.ts` containment is only as tight as the roots the
   user configures). Root selection is the control.
3. **Background jobs have no default timeout** — capped at
   `MAX_BACKGROUND_EXECUTIONS = 32` with a 10-min finished-TTL
   (`src/tools/BackgroundExecutionManager.ts:7-9`); disposal kills them. Bounded
   accumulation, as documented.
4. **`--n-gpu-layers` defaults to 999 with no VRAM preflight**
   (`src/backend/LlamaServerArgs.ts:41`); a bad load can OOM.
   `serverDiagnostics` surfaces OOM with remediation, and per-model overrides
   exist. Still the one place where a config typo costs a crash rather than a
   refusal.

## 4. Plan-doc discipline

- The "State × lifecycle ledger" rule is **enforced by a test**
  (`test/unit/PlanLedgerContract.test.ts`, green in both full runs) — not just
  prose. All tracked plans satisfy it at HEAD.
- `ROADMAP.md` was spot-checked and is current: e.g. its claim that
  `selectDelegationTimeout` (`src/delegation/LocalDelegationService.ts:100-102`)
  gives the 300 s cloud timeout only to `provider === 'cloud'` is still true.
  The four "Now" gaps (CLI-delegation checkpoint, Ollama `:cloud` timeout,
  npm-only `run_tests`/`run_build`, `htmlToText` garbling) all remain open and
  are accurately described.

## 5. Fresh-code review (0.16.56 changes)

Reviewed the newest surfaces (`ControlServer` port fallback, `agentRoutes`
focus-gated endpoint claim + `reply_in_chat`, `CodexIdleRelease`):

- **`ControlServer.listenOn` fallback** — on `EADDRINUSE` with the agent bus
  enabled, the window retries on an ephemeral port and deliberately does *not*
  publish the shared discovery record (only the fixed-port owner does);
  reachability then rides `endpoint.json`, which `refresh()` publishes only for
  the focused window (`isFocused` gate) and `claim()` reclaims on focus.
  Error/listen handlers guard against a superseded server (`this.server !==
  server`). Disposal is safe for a never-published fallback. No defect found.
- **`CodexIdleRelease`** — release is guarded by identity
  (`owned.get(alias) !== session`), so a pending dispose can't be double-armed
  for the same session; `wait('codex')` before a new adapter awaits the latest
  release. A theoretical overlap of two app-server processes during a rapid
  release→respawn→release is possible but harmless (each dispose targets its
  own session). Note only.

## 6. Recommendations (priority order)

1. Push `main` and reconcile tags/registries for 0.16.53–0.16.56 (§2).
2. Give the four load-sensitive tests explicit timeouts so `npm run ci` is a
   trustworthy gate on a loaded machine (§1).
3. Optionally: a VRAM-fit preflight (or refusal with a message) before spawning
   a 999-layer load (§3.4) — the cheapest of the residual risks to close.
4. ROADMAP "Now" items are correctly scoped; no plan-doc gaps found.

## 8. Fixes applied (2026-09-26, post-review, per Codex GO-with-conditions)

Codex gave NO-GO on the first proposal with five corrections; all five were
verified against the code and adopted. What shipped:

**FIX A — test reliability (§1):**
- `NoControlCharacters.test.ts` and both child-process tests in
  `ToolHarness.test.ts`: explicit 20 s per-test timeouts.
- `RemoteHardening.test.ts` "abandons…": `vi.waitFor` given an explicit
  15 s budget, per-test timeout 20 s (above the waitFor budget, per Codex
  correction #2).
- `RemoteCore.test.ts` "delivers an enqueued host notification…": the manual
  50×10 ms poll replaced with `vi.waitFor(…, { timeout: 15_000 })` (Codex
  correction #1 — it was not a `vi.waitFor`), per-test timeout 20 s.

**FIX B — pwsh ban gap (§3.1), in `src/tools/execHelpers.ts`:**
- `PS_DANGEROUS_FLAGS` now lowercase constants — `-command`,
  `-encodedcommand`, `-enc`, `-ec`, `-e`, `-c` — compared against
  `arg.toLowerCase()`. Codex correction #3 verified: lowercasing only the arg
  would have broken the existing mixed-case `-Command` matches; both sides are
  normalized. Correction #5 adopted: `-w` (WindowStyle) deliberately **not**
  banned; `-ec` added alongside `-enc`.
- New unit tests in `execHelpers.test.ts`: `-command`, `-COMMAND`, `-c`, `-e`,
  `-ec` all throw; `-w Hidden -File` and the sanctioned `-NoProfile -File`
  route still pass.

**Verification:** type-check PASS; the 7 directly affected test files pass
(94/94, including the new pwsh cases); full `npm test` re-run after the fixes:
**exit 0, every file green** — including all four formerly flaky tests
(`NoControlCharacters` 219 ms, `ToolHarness` 1.9 s, `RemoteHardening`
"abandons…" 822 ms, `RemoteCore` notification test). Not committed yet;
release push/tag untouched and remains the user's call (§2).

**Codex confirmation (2026-09-26, second exchange):** **CONFIRM all six items**
— lowercase case-insensitive flag ban with `-w` allowed and
`SCRIPT_LAUNCHERS` untouched (`execHelpers.ts:138-170`); new test coverage
including the sanctioned `-File` route (`execHelpers.test.ts:189-200`);
20 s timeouts at `NoControlCharacters.test.ts:55-57`,
`ToolHarness.test.ts:95`/`:117`; 15 s `vi.waitFor` + 20 s per-test at
`RemoteHardening.test.ts:555-558` and `RemoteCore.test.ts:1039-1049`. "The
execHelpers diff contains no unrelated behavioral changes." Review protocol
complete: report confirmed → fixes GO'd (with conditions, all adopted) →
fixes implemented → fixes confirmed.

---

## 7. External review — Codex (2026-09-26, via agent bus)

Codex independently re-verified this report against `4bcbcb5`. Verdicts:
**§1 CONFIRM** (with the retry-delay/wait-bound corrections now folded into §1),
**§2 CONFIRM** (HEAD, version, newest tag, `origin/main...main` = `0 3`; caveat:
this audit file itself is untracked, so the tree is no longer literally clean),
**§3 CONFIRM all four + the case-sensitivity/`-c` addition** (now folded into
§3.1 — both claims re-verified against `execHelpers.ts` by the primary agent
before inclusion), **§5 CONFIRM no production defect**, with the precision that
the identity guard lives in `sessionProvider.ts:99-103` (`owned.get(alias) !==
session` before `release()`), not inside `CodexIdleRelease.release()` itself —
`release()` is safe by construction, and the provider prevents double-arming.
No refutations; no new defects found.
