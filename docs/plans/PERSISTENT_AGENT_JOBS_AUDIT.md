# Persistent Agent Jobs — Audit Report

**Date:** 2026-09-16 · **Scope:** commits `a0d7b82`, `ee85ade`, `111e887`,
`25f6047`, `af32ec5` against `docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md`
(acceptance criteria 1–10, phases B1–B5). Read-only audit; no source changed.

## Verdict

**ship-with-fixes** — the feature is well-built and unusually well-tested for its
size, but two defects can mutate the machine or silently stop the scheduler
(F1, F4), and three acceptance criteria are only partially covered by the tests
their own text names (4, 5, 10).

## Findings

### [SEVERITY: high] A deleted job's staged build still switches `llama_server.binary`

**File:** `src/jobs/JobStore.ts:210-221` (`delete`), with
`src/jobs/actions/llamacppUpdate.ts:241-261` (`processPendingSwitches`)

`JobStore.delete()` removes four paths: `<id>.json`, `state/<id>.json`,
`runs/<id>.jsonl`, `run_requests/<id>`. It does **not** remove
`staged/<id>.json` (written by `writeStaged`, `src/jobs/actions/stagedBuild.ts:210`)
or `outbox/<id>.json` (`src/jobs/JobOutbox.ts:306`).

`processPendingSwitches` enumerates `staged/` directly — it never consults the
job store — so a job deleted while it has a `switch_pending: true` staged build
(the normal state of an `apply` job whose switch was deferred because a turn was
streaming, or a `prepare` job the user approved) will still, on the next idle
tick, write `llama_server.binary` in `config.yaml` and restart the backend for a
job that no longer exists. `performSwitch` then calls `env.deliver(jobId, …)` →
`JobScheduler.deliverForJob` → `store.load()` returns `undefined` → the message
is downgraded to a bare local toast (`JobScheduler.ts:452-457`), so the user is
not even told which job did it.

**Why it matters:** the whole point of `delete` is "stop this job from touching
my machine". This is the one action in the feature that mutates config and
restarts the GPU backend, and it survives its own job's deletion. The stale
outbox file is the milder half of the same bug: a Telegram message arrives for a
job the user just removed.

**Fix:** add `path.join(this.jobsRoot, 'staged', `${id}.json`)` and the outbox
item to the loop in `JobStore.delete`. Because the outbox dir is owned by
`JobOutbox` and the staged dir by `stagedBuild`, prefer calling
`clearStaged(this.jobsDir, id)` and `deleteOutboxItem(defaultOutboxDir(), id)`
rather than re-deriving the paths (single point of truth). Extend
`JobStore.test.ts` "removes the definition, state, and run log" to assert both.

### [SEVERITY: high] A lost lease permanently kills the scheduler in that window

**File:** `src/jobs/JobScheduler.ts:132` (`onLost: () => this.stop()`) and
`:148-155` (`stop`), with `src/vscode/jobsSetup.ts:109-127`

`stop()` sets `this.disposed = true` and never clears it; `tick()` returns early
forever on `this.disposed` (`:189`). `stop()` is wired as the lease's `onLost`
callback, so a transient lease loss (a clock skew, a stale-lease steal by
another window, an NTFS hiccup on the network drive this repo lives on) disposes
the scheduler permanently. `jobsSetup` cannot recover either: `started` stays
`true`, so `startIfEnabled()` short-circuits, and only a window reload or a
config *disable-then-enable* cycle rebuilds one.

**Why it matters:** the failure is completely silent — no toast, no run row, no
outbox item. Jobs simply stop running, and the wake task stays armed so the PC
keeps waking for jobs nobody runs. There is no test for lease loss at all.

**Fix:** separate "stop this run" from "dispose forever". Give `JobScheduler` a
`disposed` flag set only by `dispose()`/`stop({final:true})`, and have `onLost`
clear `lease`, stop the timer, and leave the object able to re-acquire; add a
re-acquire attempt on the tick interval (a cheap `FileLease.acquire` retry) or
have `jobsSetup` reset `started = false` and re-run `startIfEnabled()` from the
`onLost` path. Test: an `onLost` callback followed by a successful re-acquire
runs the next due job.

### [SEVERITY: med] A failed extraction bricks that tag permanently

**File:** `src/jobs/actions/llamacppUpdate.ts:143-164`

Stage 4 creates `llama.cpp-<tag>\` and extracts into it. If `extractZip` throws
half-way (disk full, a corrupt zip, the process dying), the `catch` at `:159`
clears only the staged *metadata* — the partially-populated build directory
stays. Every subsequent attempt at that tag then hits the guard at `:145`
(`build folder … already exists; not overwriting`) and fails, forever. The
downloaded zips in `%LOCALAPPDATA%\Forge\staging\` are likewise never deleted on
either the success or the failure path, so each release leaks ~1 GB.

The plan's stated invariant for this path is "on any failure before the switch,
the config is untouched and the staged metadata is cleared" — the config *is*
untouched, but "prior state restored" is not true of the filesystem.

**Why it matters:** the recovery the code intends ("the job re-stages on the
next release") does not apply — the user is stuck on that tag with no error that
explains why, and the only fix is deleting a directory by hand.

**Fix:** track whether this run created `buildDir`; in the `catch`, `rm -rf` it
only if this run created it (never an unrelated pre-existing build). Delete the
staged zips after a successful verify+extract, and on the failure path too.
Test: an `extractZip` that throws leaves no build dir and a retry succeeds.

### [SEVERITY: med] The outbox loses a change written during delivery

**File:** `src/remote/JobOutboxWatcher.ts:101-111`

`drain()` reads an item, awaits `deliver(text)`, then deletes the file **by job
id**. The scheduler may write a newer item for that same job in the interval
(`writeOutboxItem` replaces the file, `JobOutbox.ts:306`). The delete then
removes the *new* item, which was never delivered. The coalescing design makes
this more likely, not less: one file per job means every new change for a job in
flight lands exactly on the file about to be unlinked.

**Why it matters:** AC 8's invariant is "newest wins, carries a count of earlier
undelivered changes". A change dropped this way is not counted anywhere — it
is simply gone, and there is no run-log or state signal that it happened.

**Fix:** make the delete a compare-and-delete: re-read the item before
unlinking and skip the delete when `changed_at` differs from the delivered one
(the next drain sends the newer text). `OutboxItem.changed_at` is currently
written and never read — this is what it is for. Test: a write between
`deliver` resolving and the delete keeps the file pending.

### [SEVERITY: med] Rollback can restore a binary the user has since replaced

**File:** `src/jobs/actions/llamacppUpdate.ts:172` (`old_binary` captured at
stage time), `:219` (restore at switch time)

`staged.old_binary` is snapshotted when the build is staged. In `prepare` mode
the switch happens whenever the owner approves — up to 24 h later
(`STAGE_TTL_MS`) — and in `apply` mode whenever the box next goes idle. If the
user edits `llama_server.binary` in that window (or another job switches it),
a post-check failure restores the *stale* value, not the one that was actually
in the config a moment before the switch. In the worst case that path no longer
exists on disk and the restore-restart at `:220` also fails — and its failure is
swallowed by `.catch(() => undefined)`, so the config is left pointing at a
build that does not exist with no error raised.

**Why it matters:** this is the "rollback that restores a build that never
existed" shape. The swallowed restore-restart makes it undetectable until the
next model load fails.

**Fix:** read `env.getConfig().currentBinary` inside `performSwitch`, immediately
before `setBinary(staged.new_binary)`, and use *that* as the restore value;
keep `staged.old_binary` only as a display fact. Verify the restore target
exists before writing it, and report (deliver, not swallow) a failed
restore-restart. Test: a config changed between stage and switch rolls back to
the value present at switch time.

### [SEVERITY: med] `jobsFetch` does not re-check the host gate across redirects, and has no byte cap

**File:** `src/jobs/jobsFetch.ts:72`

`jobsDownloadBinary` is correct — `redirect: 'manual'`, the gate re-checked at
every hop, capped hops, a byte cap, streamed to disk (`:168-198`). `jobsFetch`
is not: it calls `fetch(url, { headers })` with the default `redirect: 'follow'`,
so the gate at `:60` applies only to the first URL and `undici` will silently
follow a 301/302 to any host. `response.text()` at `:82` is also unbounded — the
plan says "It reuses the `web_fetch` byte cap"; no cap is implemented.

**Why it matters:** D5 and the CLAUDE.md network rule are both stated as
"only hosts in `jobs.allowed_hosts`". Today that holds for downloads and not
for API reads. `api.github.com` does not redirect off-host in practice, so this
is a latent hole rather than a live one — but the invariant as written is not
enforced, and the download path proves the team knew it had to be.

**Fix:** give `jobsFetch` the same manual-redirect loop as `jobsDownloadBinary`
(they should share one helper — the gate is one concern implemented twice
today), and cap the body read at the `web_fetch` limit. Test: mirror
`JobFetch.test.ts` "re-gates at every redirect hop" for `jobsFetch`.

### [SEVERITY: med] Every failed run notifies; the plan says report once

**File:** `src/jobs/JobScheduler.ts:299`

`runJob`'s catch calls `deliver(job, 'failing: …')` on **every** failure. B.3's
invariant is "After 3 consecutive failures, report once and double the
interval"; `applyBackoff` implements the doubling but writes only a run row —
the reporting decision lives in the wrong place. The outbox coalesces the
Telegram side to one pending message per job, so this is not a phone flood, but
`notifyLocal` fires a VS Code toast on every failed run, and each delivery bumps
`earlier_count`, so the eventual message reads "+N earlier changes coalesced"
for what was one continuous outage.

The one test here (`JobScheduler.test.ts` "a failed check is backed off after 3
consecutive failures") asserts `consecutive_failures` and `next_due_at` only —
it says nothing about how many times the failure was reported.

**Fix:** move the failure delivery into `applyBackoff` and gate it on
`count === BACKOFF_THRESHOLD`. Assert the delivery count in the existing test.

### [SEVERITY: med] A 304 on a job with no baseline records `''` as the observation

**File:** `src/jobs/checks/github.ts:90` and `:118` (same shape at `:142`)

`etagCache` is a single `Map` on the scheduler, keyed by URL and shared by all
jobs (`JobScheduler.ts:88`, `:411`). Two jobs watching the same repo — or one
job whose `state/<id>.json` was corrupted and fell back to `defaultState()`
(`JobStore.readState:197-205`, an explicitly supported path) — can therefore get
a 304 on a run where `lastObservation === null`. The check then returns
`observation: lastObservation ?? ''`, and the scheduler persists `''` as
`last_observation`. On the next 200, `changed = lastObservation !== null && …`
is `true` because `''` is not `null`, so a "change" is reported for a release the
user has already seen. For a `llamacpp_update` job that means a spurious stage
attempt, which then dies at the `build folder already exists` guard and consumes
a backoff cycle.

**Why it matters:** B.2's stated invariant is "The first run only records a
baseline. It never reports 'changed'." The `''` sentinel breaks the null check
that enforces it.

**Fix:** key the ETag cache per job id (`${jobId}|${url}`), and make the 304
branch return `changed: false` *and* leave the observation untouched by
returning `observation: lastObservation` (null-preserving) rather than `''` —
the `CheckResult.observation` type needs to allow `null` for that, or the
scheduler must skip the `last_observation` patch when the check was
not-modified.

### [SEVERITY: low] A job that fell due while VS Code was closed is not marked `late`

**File:** `src/jobs/JobScheduler.ts:193`

`lastTickAt` is `undefined` on the first tick of a process, so `gap` is `0` and
`isResume` is `false`. D7 says "Jobs that fell due while VS Code was closed run
once on reopen, marked `late`". They do run (`isDue` is true), but the run row
records `late: false`, and `maybeSleepIfIdle` is skipped. The existing test
("a late tick after a long gap runs the overdue job once, marked late") passes
because it drives a second tick after a first — it does not cover the
cold-start case D7 actually describes.

**Fix:** seed `lastTickAt` from the newest `last_run_at` across loaded jobs on
the first tick, or treat the first tick of a process as a resume when any job's
`next_due_at` is more than `RESUME_GAP_MS` in the past.

### [SEVERITY: low] `ClockTimeSchema` accepts impossible times

**File:** `src/jobs/jobSchema.ts:146`

`/^\d{1,2}:\d{2}$/` accepts `99:99`. `parseClock` → `setHours(99, 99)` rolls
silently into a later day, so a typo'd `at` produces a job that runs at an
unrelated time, and `wakeTimesFor` arms a wake to match.

**Fix:** `/^([01]?\d|2[0-3]):[0-5]\d$/`.

### [SEVERITY: low] The documented `asset_pattern` example can never match

**File:** `src/jobs/jobSchema.ts:234`

The doc comment gives `llama-b{tag}-bin-win-cuda-*-x64.zip` as the example. No
code anywhere substitutes `{tag}` (grep confirms: the only `{tag}` in `src/` are
template literals). `assetMatches` escapes `{` and `}` as literals
(`checks/github.ts:19`), so a job following the documented example fails at
`pickAssets` with "asset_pattern matches neither …" on every run.

**Fix:** either substitute `{tag}` in `pickAssets`/`assetMatches`, or change the
example to a glob that works (`llama-*-bin-win-cuda-*-x64.zip`).

### [SEVERITY: low] Dead fields and an unused parameter

- `StageResult.staged` and `StageResult.switchPending`
  (`src/jobs/actions/llamacppUpdate.ts:88-95`) are produced and never read —
  the only consumer (`JobScheduler.runCheck:438`) uses `.summary` alone.
- `OutboxItem.changed_at` (`src/jobs/JobOutbox.ts:262`) is written and never
  read; `renderOutboxMessage` uses `first_undelivered_at`. (It is exactly the
  field the F4 fix needs — keep it, and use it.)
- `JobScheduler.deliverForChange(_state)` (`:314`) takes a parameter it ignores.
- `LlamacppUpdateEnv.getConfig().embeddings.port` (`:51`) is declared and never
  used; `embeddingsRoundTrip` always calls `findFreePort`.

### [SEVERITY: low] Plan deliverables not shipped: `docs/OWNERS.md` rows and `docs/JOBS.md`

**File:** `docs/OWNERS.md` (no row matches `job`, case-insensitive),
`docs/JOBS.md` (does not exist)

Plan §B.9 lists both as per-phase deliverables, and CLAUDE.md's Single Point of
Truth section makes the OWNERS row mandatory for every new module. Fourteen new
`src/jobs/**` files landed with no ownership row, which is exactly how the next
duplicate-implementation gets written.

## Acceptance-criteria coverage

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Jobs live outside `~/.forge/sessions/` | **met** | `JobStore.test.ts` "saves and loads a job…", "persists state in a separate file from the definition", "appends run rows only"; paths fixed at `JobStore.ts:51-55` |
| 2 | A malformed job file is reported, not skipped | **met** | `JobStore.test.ts` "a malformed job file is reported, not skipped silently" + "a corrupt state file falls back to the default state" + "patchState treats malformed state as the default" |
| 3 | `loadAll` deterministic (creation, then id) | **met** | `JobStore.test.ts` "loadAll returns jobs in a deterministic order (creation, then id)" |
| 4 | At most once per due window, honours `maxConcurrent`, no double-run | **partial** | Due math: `JobSchedule.test.ts` (11 tests incl. midnight rollover, lead shift). No double-run: `JobScheduler.test.ts` "a job never runs twice at once". **`maxConcurrent` has no test** — the pool at `JobScheduler.ts:218-228` is only ever exercised at the default 2 with ≤1 due job. Also: if `appendRun` *and* `applyBackoff` both throw (both `.catch(()=>undefined)` at `:298-300`), `next_due_at` is never advanced and the job re-runs every tick |
| 5 | `run_now` cross-window and idempotent | **partial** | Producer side covered: `JobTools.test.ts` "writes a run_requests marker…", "round-trips a job id that contains a dot", "also removes any pending run request"; `RemoteJobCommands.test.ts` "writes a run_requests marker…". **The consumer-side test the AC names (`JobScheduler.test.ts` marker consumption) does not exist** — grep for `marker`/`run_request` in that file returns nothing. The consume-before-run ordering (`JobScheduler.ts:205`) is correct but unproven, as is the "a paused job still runs on an explicit marker" behaviour |
| 6 | `manage_jobs` shape, permissions, resolution | **met** | `JobTools.test.ts` (32 tests): advertise gate, read/write/delete derivation, `dangerous` only for delete, partial update, unknown-key and id rejection, exact/substring/ambiguous resolution |
| 7 | Telegram `/jobs` + `/job <n\|name> …` | **met** | `RemoteJobCommands.test.ts` (24 tests) incl. "resolves a multi-word name (the action is the final token)", "refuses a stale confirmation when the job changed in the window" (the `updated_at` re-check at `RemoteJobCommands.ts:280`), "refuses a confirmation for a different job"; drift guard: `RemoteRichText.test.ts:83` lists `src/remote/RemoteJobCommands.ts` in `SOURCES`. Note `approve` is implemented (B5) but absent from the usage/unknown-action strings at `:151` and `:183` |
| 8 | Outbox coalesces to one pending message per job | **partial** | `JobOutbox.test.ts` (8) + `JobOutboxWatcher.test.ts` (4) cover newest-wins, `earlier_count`, the 24 h count-only render, delete-only-after-accepted, oldest-first. **Not covered: the delete-by-id race (F4)** — a change written during delivery is silently dropped, which defeats "carries a count of earlier undelivered changes" |
| 9 | Discuss chat: on demand, reuses, seeds, persists `conversation_id` | **met** | `JobTools.test.ts` "seeds a new conversation and persists its id", "reuses an existing conversation when it still exists", "persists a newly created conversation even when its seed turn fails"; `RemoteJobCommands.test.ts` "opens a new discuss chat and seeds it…", "reuses an existing conversation…". One shared path confirmed: `src/jobs/jobDiscuss.ts:32` is the sole implementation, called from both surfaces |
| 10 | `llamacpp_update` safety stages + `prepare`/`approve` | **partial** | Unit coverage is good: `LlamacppUpdate.test.ts` (21 tests) covers digest mismatch, missing digest, partial build, pattern mismatch, existing folder, smoke-test failure, `prepare` vs `apply` staging, post-check rollback with and without a prior binary, expiry, `approveStaged`, and the pending-switch pass. **Missing:** (a) no test that the switch *defers while a turn streams* — the `busy()` guard at `llamacppAction.ts:113` is the stage-7 deferral and is never exercised; (b) no named manual step recorded anywhere (no `docs/JOBS.md`, nothing in the plan's results sections) for the "a real release" validation the AC requires; (c) the stage-order invariant "every failure path restores prior state" is violated by F3 (build dir) and F5 (stale rollback target) |

**Concurrency answers, for the record.** `maxConcurrent` is honoured by the
worker pool at `JobScheduler.ts:218-228` (untested). At-most-once-per-due-window
holds through `next_due_at` being advanced in both the success and the backoff
path, with the caveat in row 4. `run_now` idempotency holds twice over: the
marker is written with `flag: 'wx'` (`JobStore.ts:267`, a second request before
consumption is a no-op) and the tick's `seen` set stops a marker and a due job
queuing the same job twice (`:207-216`). Re-entrancy is prevented by
`this.running` (`:189`), which makes the `runningJobs` set at `:224` redundant
but harmless. The documented idle-snapshot race (B.7) is implemented exactly as
documented — one `busy()` check at `llamacppAction.ts:113`, no lock — and the
post-check does catch a broken backend, so that limitation is honoured, not a
defect.

## Recommended fixes

Ordered by risk.

1. **`src/jobs/JobStore.ts:210`** — extend `delete()` to clear
   `staged/<id>.json` and the job's outbox item (call `clearStaged` and
   `deleteOutboxItem` rather than re-deriving the paths). Extend the existing
   `JobStore.test.ts` delete test to assert a staged build and a pending outbox
   item are both gone. *(F1)*
2. **`src/jobs/JobScheduler.ts:132,148`** — split lease loss from disposal.
   `onLost` should clear the timer and the lease but leave the scheduler
   re-startable; add a lease re-acquire attempt on the tick interval, or have
   `jobsSetup.ts:109` reset `started` and re-run `startIfEnabled()`. Add a test
   that a lost-then-regained lease resumes running jobs. *(F2)*
3. **`src/jobs/actions/llamacppUpdate.ts:143-164`** — record whether this run
   created `buildDir`; delete it in the `catch` when it did. Delete the staged
   zips on both the success and the failure path. Test a throwing `extractZip`
   followed by a successful retry. *(F3)*
4. **`src/remote/JobOutboxWatcher.ts:107`** — re-read the item before unlinking
   and skip the delete when `changed_at` differs from the delivered copy. Test a
   write landing between `deliver` and the delete. *(F4)*
5. **`src/jobs/actions/llamacppUpdate.ts:201,219`** — read the restore target
   from `env.getConfig().currentBinary` inside `performSwitch`, not from
   `staged.old_binary`; verify it exists before writing it; deliver (do not
   swallow) a failed restore-restart. *(F5)*
6. **`src/jobs/jobsFetch.ts:72`** — extract the manual-redirect + host-gate loop
   from `jobsDownloadBinary` into one helper and use it in `jobsFetch` too; cap
   the body read at the `web_fetch` byte limit. Mirror the existing
   "re-gates at every redirect hop" test onto `jobsFetch`. *(F6)*
7. **`src/jobs/JobScheduler.ts:299`** — move the failure delivery into
   `applyBackoff` and fire it only when `count === BACKOFF_THRESHOLD`. Assert
   the delivery count in the existing backoff test. *(F7)*
8. **`src/jobs/checks/github.ts:90,142`** — key `etagCache` per job
   (`${jobId}|${url}`) and stop writing `''` as an observation on a 304 with no
   baseline. Add a check test: a 304 on a job with `last_observation === null`
   reports no change and leaves the baseline unset. *(F8)*
9. **Tests named by the acceptance criteria but absent** — add to
   `JobScheduler.test.ts`: marker consumption (AC 5, including a paused job run
   by an explicit marker, and a marker consumed before the run so a crash cannot
   re-fire it) and a `maxConcurrent: 1` test with three due jobs (AC 4). Add to
   `LlamacppUpdate.test.ts` (or a scheduler test): a `busy()` scheduler defers
   the switch and the next idle tick performs it (AC 10).
10. **`src/jobs/JobScheduler.ts:193`** — mark cold-start overdue jobs `late`
    (D7), by seeding `lastTickAt` or by treating a far-past `next_due_at` on the
    first tick as a resume. *(F9)*
11. **`src/jobs/jobSchema.ts:146,234`** — tighten `ClockTimeSchema` to
    `/^([01]?\d|2[0-3]):[0-5]\d$/`, and fix the `asset_pattern` doc example so
    it does not contain an unsubstituted `{tag}`. *(F10, F11)*
12. **Dead code** — drop `StageResult.staged`/`switchPending` (or consume
    them), the unused `_state` parameter at `JobScheduler.ts:314`, and the
    unused `embeddings.port` in `LlamacppUpdateEnv`. Keep
    `OutboxItem.changed_at` — fix 4 needs it. *(F12)*
13. **Docs** — add `docs/OWNERS.md` rows for every `src/jobs/**` module,
    `src/vscode/jobsSetup.ts`, `src/remote/JobOutboxWatcher.ts`, and
    `src/remote/RemoteJobCommands.ts`; write `docs/JOBS.md` and record in it the
    named manual validation step for AC 10 (a real llama.cpp release, `prepare`
    then `/job <n> approve`, then one `apply`). *(F13)*
