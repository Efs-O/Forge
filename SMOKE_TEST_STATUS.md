# 0.13.0 smoke-test status

Live state of the manual two-window validation. The checklist itself is
`TWO_WINDOW_SMOKE_TEST.md`; this file records what has actually been run and
what is left. Last updated 2026-08-23, mid-session.

---

## Where things stand

Branch `reliability-hardening`, 21 commits ahead of `main`, working tree clean,
PR #2 open. Nothing merged, nothing published. `main` untouched.

VSIX: `forge-llm-0.13.0.vsix` at repo root, **rebuilt 12:38** — this build
includes both bugs found today. Version deliberately unchanged.

---

## Test results

| # | Scenario | Result |
|---|---|---|
| 1 | Two windows share one server | **PASS** |
| 2 | Borrower releases without killing the owner | **PASS** |
| 3 | Crashed borrower's lease reclaimed | **PASS** |
| 4 | Owner dies under a live borrower | not run |
| 5 | Kill llama-server directly | not run (happened by accident, uncontrolled) |
| 6 | Structural config reload warning | not run |
| 7 | Old config with `cloud_workers` still boots | automated, passes in CI |
| 8 | Re-borrow after the owner's server restarts | **not run on the fixed build** |

Tests 1–3 were the merge gate and all passed. Evidence was taken from the
filesystem and process table directly, not from the UI:

- **Test 1** — one `llama-server` (pid 47084), owner record `ownerPid: 13360`,
  one lease `pid: 44196`, VRAM 15209/16311 MiB. The model is 15.2 GB on a
  16.3 GB card, so two copies are physically impossible: the single-process
  observation is self-proving.
- **Test 2** — after release in B: lease gone, owner record intact, server
  still listening. After unload in A: process gone, port free, VRAM
  15209 → 784 MiB.
- **Test 3** — B's extension host force-killed, its lease left on disk naming a
  dead pid. A unloaded successfully, lease reclaimed, VRAM → 825 MiB.

---

## Two bugs found, both fixed

Neither was the bug the release was written for. Both were found by running
the checklist.

**1. `forge.logLevel` was a dead setting** (`1c4e6f3`). Contributed in
package.json, visible in the settings UI, set to `debug` on this machine — and
nothing in `src/` read it. The logger's level was only ever raised by
`config.yaml`'s `log_level`. Symptom: the `reclaimed stale runtime lease` debug
line never appeared, which briefly made a passing test look like a failure.
`initLogger` now applies the setting; `config.yaml` still wins where it sets
`log_level`. Three tests in `test/unit/LoggerLevel.test.ts`.

**2. Re-borrowing leaked the previous lease** (`8358e4d`). **This one matters.**

`borrowSharedRuntime` acquired a lease unconditionally, and the `onBorrowed`
callback overwrote the slot record — so the old `leaseId` became unrecoverable
while its file stayed on disk. Reached whenever a shared slot exists but is not
ready, which is exactly what the owner's llama-server dying and being respawned
leaves behind (`BackendPool.acquire`, the fall-through at the `isReady()`
check).

Consequence: `releaseKey` only knows the *current* `leaseId`, so a clean
release leaves the orphan behind naming a **live** process. `hasBorrowers`
answers true indefinitely and **the owner can never unload while the borrowing
window stays open** — the immortal-lease failure this release exists to fix,
reached by a different route.

Observed live: two lease files, both `{"pid":46932}`, created five minutes
apart. Fixed by releasing the previous lease at the point the record is
replaced. `BackendPool` now takes an injectable `SharedRuntimeRegistry` so the
bookkeeping is testable against a temp root.

Mutation-checked: removing the fix fails both tests in
`test/integration/SharedRuntimeReborrow.test.ts`, the first with
`expected 1, got 2` — the same state seen on disk.

---

## Resume here

1. **Install the rebuilt VSIX** (it is newer than what is running):

   ```powershell
   code --install-extension .\forge-llm-0.13.0.vsix --force
   ```

   Then fully quit and reopen **both** windows. Not Reload Window — the
   extension-host restart reloads the old build.

2. **Clear the leaked lease.** The old build wrote it; the new build does not
   retroactively remove it:

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\forge-llm\shared-runtimes" -ErrorAction SilentlyContinue
   ```

3. **Run test 8** — the one that found bug 2, now against the fixed build.
   Borrow → kill `llama-server` → reload the model in A → prompt in B →
   release in B → unload in A. Expect exactly one lease file throughout, and a
   successful unload.

4. **Optionally run tests 4, 5, 6.** Crash-recovery polish; a failure there is
   a bug report, not a merge blocker.

5. **Then:** remote review of PR #2 (`/code-review ultra 2` — user-triggered,
   cannot be launched from the agent side), merge, publish 0.13.0.

### Verifying state without the UI

The rendered chat hides backend failures. Check the filesystem and the process
table instead:

```powershell
$r="$env:LOCALAPPDATA\forge-llm\shared-runtimes"
Get-ChildItem -Recurse -Filter *.json $r | ForEach-Object { $_.Name; Get-Content $_.FullName }
Get-Process -Name llama* | Format-Table Id,ProcessName
nvidia-smi --query-gpu=memory.used --format=csv,noheader
```

The owner record names `ownerPid`; each lease names a borrower pid. A llama-server's
parent pid identifies which window owns it.

---

## Environment notes that cost time

- **Both windows already resolve to the same config.** `forge.configFile` is
  set in **User** settings to `N:/vs code apps/Forge/.forge/config.yaml`, and
  that setting wins over workspace lookup. No per-window setup needed.
- `shared_runtime.enabled: true` is already in that config.
- Both VS Code windows share **one** main process, so there is no per-window
  process to kill. To simulate a window crash, kill the **extension host** —
  the pid the lease names. VS Code will restart it; that is fine, because a
  lease is taken on borrow, not on activation. Do not load a model afterwards.
- ~24 `Code.exe` processes is normal. The ones parented to the extension host
  are language servers (Pylance, JSON, Markdown, GitHub Actions).
- Do not run a semantic search while counting processes: embeddings spawn a
  second `llama-server` on port 8091.
- VRAM sits at ~15.2 of 16.3 GB with this model — right at the WDDM thrashing
  threshold.

---

## Separate from the smoke test

`docs/FIRST_RUN_EXPERIENCE_REPORT.md` (local only, `docs/*` is gitignored) —
seven findings on new-user onboarding. Highest value: the setup wizard writes
`n_gpu_layers: -1`, the value this project has already documented as wrong
(`-1` is auto-fit, not "all"). None of it blocks 0.13.0.
