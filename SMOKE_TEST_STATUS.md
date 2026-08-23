# 0.13.1 smoke-test status (historical pre-publication record)

Result of the manual two-window validation. The checklist itself is
`TWO_WINDOW_SMOKE_TEST.md`. Last updated 2026-08-23.

Release update: PR #2 was subsequently merged to `origin/main` as
`3ed257bb2be221c9ef495b2b32e977b757bb468a`, and Marketplace version 0.13.1 was
published on 2026-08-23. The statements below about an open PR and an
unpublished release describe the moment the smoke test finished, not the
current release state.

---

## Where things stand

**All eight tests passed.** At the time of the test, branch
`reliability-hardening` had a clean worktree, PR #2 was open, and `main` was
untouched. See the release update above for what happened afterward.

VSIX: `forge-llm-0.13.1.vsix` at repo root. The version was bumped from 0.13.0
because 0.13.0 was never published and the smoke test found six further bugs;
`CHANGES.md` folds them into one 0.13.1 entry.

CI at the time: 952 tests passing. The 2026-08-23 Open VSX release audit ran
the expanded suite with 957 tests passing and 8 explicitly skipped.

---

## Test results

| # | Scenario | Result |
|---|---|---|
| 1 | Two windows share one server | **PASS** |
| 2 | Borrower releases without killing the owner | **PASS** |
| 3 | Crashed borrower's lease reclaimed | **PASS** |
| 4 | Owner dies under a live borrower | **PASS** |
| 5 | Kill llama-server directly | **PASS** |
| 6 | Structural config reload warning | **PASS** |
| 7 | Old config with `cloud_workers` still boots | **PASS** (automated in CI) |
| 8 | Re-borrow after the owner's server restarts | **PASS** |

Evidence was taken from the filesystem and process table directly, not from the
UI, which hides backend failures:

- **Test 1** — one `llama-server` (pid 47084), owner record `ownerPid: 13360`,
  one lease `pid: 44196`, VRAM 15209/16311 MiB. The model is 15.2 GB on a
  16.3 GB card, so two copies are physically impossible: the single-process
  observation is self-proving.
- **Test 2** — after release in B: lease gone, owner record intact, server
  still listening. After unload in A: process gone, port free, VRAM
  15209 → 784 MiB.
- **Test 3** — B's extension host force-killed, its lease left on disk naming a
  dead pid. A unloaded successfully, lease reclaimed, VRAM → 825 MiB.
- **Test 8** — exactly one lease file after the re-borrow (two was the bug), B
  detached cleanly, A unloaded without being blocked, no processes left. Only
  an empty `<hash>.leases\` directory remains, which is the known cosmetic nit
  below.

---

## Six bugs found, all fixed

None of them was the bug the release was written for, and none was caught by
the 952 automated tests. All six came from running the checklist by hand.

**1. Stop killed the llama-server** (`dab1d19`). **The worst of them.**

`TurnLifecycle.cancel()` passed `stopBackend: true`, so the Stop button aborted
the request and then SIGTERM'd the server — a full model reload to cancel one
generation. Under a shared runtime the owning window's Stop tore down the
server its borrower was using, with no warning and nothing in the borrower's
log. The borrower's own Stop was safe only because `stop()` throws on an
adopted backend into a swallowed `catch`.

The correct behaviour already existed four lines below as `interrupt()`, used
for steering. Stop was wired to the wrong one. `stopStreaming`'s `stopBackend`
default flips too, because closing a tab took the identical path.

Found by pressing Stop mid-generation by accident. Mutation-checked: restoring
either `true` fails the new tests in `test/unit/TurnLifecycle.test.ts`.

**2. Re-borrowing leaked the previous lease** (`8358e4d`).

`borrowSharedRuntime` acquired a lease unconditionally, and the `onBorrowed`
callback overwrote the slot record — so the old `leaseId` became unrecoverable
while its file stayed on disk. Reached whenever a shared slot exists but is not
ready, which is what the owner's llama-server dying and being respawned leaves
behind.

Consequence: `releaseKey` only knows the *current* `leaseId`, so a clean
release leaves an orphan naming a **live** process. `hasBorrowers` answers true
indefinitely and **the owner can never unload while the borrowing window stays
open** — the immortal-lease failure this release exists to fix, reached by a
different route.

Observed live: two lease files, both `{"pid":46932}`, five minutes apart.
`BackendPool` now takes an injectable `SharedRuntimeRegistry` so the
bookkeeping is testable against a temp root. Mutation-checked: removing the fix
fails both tests in `test/integration/SharedRuntimeReborrow.test.ts`, the first
with `expected 1, got 2` — the same state seen on disk.

**3. `stopAllSlots` called `stop()` on borrowed backends** (`3becdd7`). Window
close relied entirely on `stop()` throwing into `.catch(() => {})`, and skipped
`resetAttachmentState`. One refactor making `stop()` tolerant would have turned
window-close into killing another window's server. The borrower path now calls
`detach()` explicitly.

**4. `forge.logLevel` was a dead setting** (`1c4e6f3`). Contributed in
package.json, visible in the settings UI, set to `debug` on this machine — and
nothing in `src/` read it. Only `config.yaml`'s `log_level` had any effect.
Symptom: the `reclaimed stale runtime lease` debug line never appeared, which
briefly made a passing test look like a failure. Three tests in
`test/unit/LoggerLevel.test.ts`.

**5. One output channel leaked per backend** (`4fd227c`). Each `DirectBackend`
created its own `Forge - llama-server` channel and nothing disposed them,
contrary to the disposal rule in `CLAUDE.md`. With four slots the *live*
channels were already indistinguishable. Now one shared channel, disposed in
`deactivate()`, with each server announcing itself in a banner.

**6. `FORGE.md` named removed tools** (`3becdd7`). The repository instructions
injected into the system prompt still told the model to call
`dispatch_workers`, which this release deleted. Observed in a live transcript: the
model reasoned *"the project instructions say to use `dispatch_workers`... I
don't see a `dispatch_workers` tool"* — a wasted turn on every delegation.

---

## Known, not fixed

- An empty `<hash>.leases\` directory survives unload; `removeOwner` deletes
  the `.json` only. Cosmetic.
- `reconcileDeadSlot` frees a dead slot without calling `removeOwner`, so a
  genuine crash orphans the owner record. Low severity — `borrowSharedRuntime`
  health-probes before adopting, and the next successful start republishes over
  it. Not reproduced during this run; the SIGTERM observed was an intentional
  Forge teardown, not a crash.

---

## Publication follow-up

The original Marketplace steps are complete: PR #2 was merged and 0.13.1 was
published under publisher `Efsoo`. Open VSX is a separate registry release and
requires its own Eclipse/Open VSX account agreement, namespace, and token.

The Open VSX audit produced dependency, documentation, and package-hygiene
changes after Marketplace 0.13.1 was published. Those bytes should ship under
a new patch version in both registries rather than publishing two different
0.13.1 artifacts.

Deferred, not blocking: MED-4 (legacy permissions migration), MED-5 (denylist →
structured policy), LOW-2 (doc archive), and the seven onboarding findings in
`docs/FIRST_RUN_EXPERIENCE_REPORT.md` — of which F1 (the starter config writes
the known-wrong `n_gpu_layers: -1`) is the highest value and a one-line change.

---

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
(`-1` is auto-fit, not "all"). None of it blocks 0.13.1.
