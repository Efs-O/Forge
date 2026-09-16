# Scheduled Wake + Persistent Agent Jobs (impl plan)

**Status:** plan; decisions D1–D7 and both open questions signed off
2026-09-14. No code yet. Phase A1 (see §A.7): **check 1 (G5) FAIL** — A2
switches the wake principal to the interactive user; **check 2 (scheduled
RTC wake) PASS** — the PC wakes itself at the armed time, unattended,
confirmed twice; **check 4 (lead time) measured** — resident server healthy
~112 s after RTC fire → `WAKE_LEAD_MS ≈ 120000`. Check 3 (daily recurrence)
deferred (same RTC mechanism, low-risk). **A1 done; next step: A2.**
**Date:** 2026-09-14
**Origin:** §1.11 of [DOCUMENTATION_AND_ROADMAP_AUDIT_0.16.md](../DOCUMENTATION_AND_ROADMAP_AUDIT_0.16.md); roadmap tier "Next"

**Goal:** Forge runs jobs on a schedule while nobody is at the PC. The first
jobs are "tell me when llama.cpp ships a new build", "tell me when this GitHub
issue changes", and "warn me when a drive is nearly full". Later, "install the
new llama.cpp build and switch the config". The user can list, pause, resume,
run, or delete a job from any chat ("stop watching the llama.cpp issue"), and
can open a chat about a job.

**Scope discipline:**
- Most runs involve **no model**. A job is a typed check that compares a new
  observation with the last one. The model is used only to summarize a change,
  and only if the job asks for it.
- No free-form shell and no model-authored actions. The only mutating action
  is one allow-listed, TypeScript-implemented `llamacpp_update`, and it ships
  last.
- One scheduler per machine, not per window. The existing lease pattern
  decides which window runs it.
- Wake (Part A) ships and is validated before any job code.

---

## Decisions (signed off 2026-09-14)

| # | Decision | Signed off |
| --- | --- | --- |
| D1 | Where jobs live | `~/.forge/jobs/` (machine-level, not workspace): `<id>.json` per job, `state/<id>.json`, `runs/<id>.jsonl`. **Deliberately outside `~/.forge/sessions/`**, which is what HalluScribe sweeps (its `index.json` records each `source_jsonl` there), so notification-only runs never get titled, never appear in chat history, and never enter the archive. Only a "discuss" chat (D3) is a normal session and gets swept like any other chat. The user wanted exactly this split. |
| D2 | Which window runs the scheduler | The one holding its own `jobs-scheduler` lease, independent of Telegram. Because the jobs window may not be the Telegram window, notifications go through a **file outbox** (`~/.forge/jobs/outbox/`) that the Telegram lease holder delivers to the owner chat on the **same main bot**. The outbox is coalesced: **one pending message per job**, the newest wins and carries a count of earlier undelivered changes, and items older than 24 h are only counted, never sent. No flood when Telegram comes back. A second, send-only bot was considered and rejected: replies and `/job` commands would not work in it, and adding a poller brings back the one-token/two-pollers 409 problem. See §B.4. |
| D3 | Chat per job | **Opened on demand**, not appended to by every run (see §B.6 for why). The user confirmed this explicitly, replacing the earlier "every run posts to the job chat" description. |
| D4 | Agent control | One tool, `manage_jobs`, with an `action` enum, instead of five tools (one round per call, one schema). Available in **every** chat when `jobs.enabled`, not only in job chats (see §B.5). |
| D5 | Outbound traffic | GitHub checks only reach hosts listed in `jobs.allowed_hosts` (config), default empty, as CLAUDE.md requires. Unauthenticated, with ETag caching. |
| D6 | After a scheduled wake | Default `stay_awake`; `sleep_if_idle` is opt-in per job |
| D7 | Shutdown | Unsupported in v1. Jobs need the PC to **sleep**, not shut down, with VS Code left open. Jobs that fell due while VS Code was closed run once on reopen, marked `late`. |

**Also decided in the same session:**
- **Summaries wait for idle.** `on_change: "summarize"` runs the model only
  when no turn is streaming, so it never competes for the GPU with a live
  chat. The "changed" fact is recorded at run time. The summary and the
  notification follow once the backend is idle.

## Open questions (answered 2026-09-14)

| Question | Answer |
| --- | --- |
| What should the llama.cpp job watch? | **New releases first** (`github_release` on `ggml-org/llama.cpp`). Issue/PR watches come later. **Requirement:** from any chat, whether a normal chat or a job's discuss chat, the agent must be able to add a watch, edit one (including its check target and its schedule/monitor time), pause or resume it, and remove it. `manage_jobs` `create`/`update`/`pause`/`resume`/`delete` covers this. `update` must accept a schedule-only change. |
| Gate on `llamacpp_update` switching? | **No gate.** `apply` mode (switch automatically after a passing smoke test) is allowed from day one; the "3 prior `prepare` runs" rule is dropped. `prepare` + `/job <n> approve` stays available as a per-job choice. Every safety stage still runs in `apply`: digest verify, smoke test, deferring while a turn streams, and post-check rollback. |

---

# Part A — Scheduled wake

## A.1 Today (verified 2026-09-14)

- `PowerControl.armWakeTimer(when)` (`src/system/PowerControl.ts:120`) registers
  the task `ForgeWakeTimer` from XML:
  - one `TimeTrigger`, `WakeToRun=true`, action `cmd /c exit`;
  - principal SYSTEM (`S-1-5-18`), `StartWhenAvailable=true`;
  - `EndBoundary` = start + 1 min and `DeleteExpiredTaskAfter=PT1M`, so
    **it deletes itself after firing.**
- It refuses when `RTCWAKE` is off (`WakeTimersDisabledError`). On this PC,
  AC = 1.
- Callers: the `schedule_wake` tool (`src/tools/powerTools.ts:120`) and Telegram
  `/wake [time|off]` and `/sleep [time] confirm`
  (`src/remote/RemotePowerCommands.ts`). Times are parsed by `parseWakeTime()`
  (`src/system/wakeInfo.ts:125`).
- `PowerControl` is created in three places (`registerAllTools.ts:141`,
  `RemoteCommandHandler.ts:72`, `RelaySleepServer.ts:24`). It is stateless, so
  that is harmless.
- This PC: `STANDBYIDLE` AC = 0 (never idle-sleeps on mains). `UNATTENDSLEEP`
  is hidden (default 120 s). No `ForgeWakeTimer` is armed. VS Code does not
  start at logon.

## A.2 Gaps

| Gap | Effect |
| --- | --- |
| G1 One-shot | A daily job gets one wake, then none |
| G2 Re-arm needs Forge alive | One crash or closed window breaks the chain |
| G3 Unattended wake | Windows may sleep again ~2 min after a wake with no input; Forge holds no power request |
| G4 One task name | A manual `/sleep 09:00` overwrites a job's 06:00 wake |
| G5 SYSTEM principal | Creating it may need elevation; unverified from normal VS Code |

## A.3 Phase A1 — validation on this PC (no code, ~30 min)

1. **G5:** from normal VS Code, Telegram `/wake 5m`, then
   `schtasks /query /tn ForgeWakeTimer`. If it is missing, A2 switches the
   principal to the interactive user (`InteractiveToken`); the wake does not
   care who runs a no-op.
2. **G3:** register a wake 3 min out with a throwaway `CalendarTrigger` task
   (PowerShell `Register-ScheduledTask`), `/sleep confirm`, touch nothing.
   Record resume time, then time back to sleep (System log, Kernel-Power 42/107).
   Repeat with a `SetThreadExecutionState` holder running. The result decides
   whether `holdAwake` is required or only a safeguard.
3. **Recurrence:** the same throwaway daily task wakes the PC on two
   consecutive mornings with nobody touching it.
4. **Lead time:** resume → Telegram `/status` answers → `llama-server` ready.
   This sets `WAKE_LEAD_MS`.

Results go in a new §A.7 of this file before A2 starts.

## A.4 Phase A2 — design

**Two tasks, two owners.** `ForgeWakeTimer` and the new task both use the
current interactive user's Task Scheduler `InteractiveToken` principal, not
SYSTEM. **CHANGED: A1 proved the existing SYSTEM principal cannot be created
from a normal VS Code session.** Add:

| Task | Written by | Triggers |
| --- | --- | --- |
| `ForgeScheduledWake` | job scheduler only | one `CalendarTrigger` per distinct wake time (`ScheduleByDay` or `ScheduleByWeek`), all in one task |

Windows repeats the wake without Forge (fixes G1 and G2). The separate name
fixes G4, and Windows simply wakes for whichever task fires first.

New `PowerControl` methods (it stays the only place that spawns `schtasks`):

```ts
interface RecurringWake { hour: number; minute: number; days: 'daily' | Weekday[] }
setScheduledWakes(wakes: readonly RecurringWake[]): Promise<void>   // [] ⇒ delete task
readScheduledWakes(): Promise<RecurringWake[] | null>               // null ⇒ no task
holdAwake(reason: string): { dispose(): void }
```

- `setScheduledWakes` uses the same XML → UTF-16 temp file → `schtasks /create /xml /f`
  path as `armWakeTimer`, with no `EndBoundary` and no `DeleteExpiredTaskAfter`.
  `wakeTaskXml` is split into a shared settings block plus a trigger renderer,
  so the two task kinds cannot drift apart. Both render the interactive-token
  principal; neither renders `S-1-5-18`.
- `holdAwake` spawns one PowerShell child that P/Invokes
  `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` and then blocks
  on stdin. `dispose()` closes stdin, and the child exits, which drops the
  request. If Forge dies, the child's stdin closes too, so the request can
  never outlive Forge. Reference-counted: two holders share one child.
- The child lifecycle sits behind a small injectable spawn seam, so the
  reference-count test does not launch PowerShell.
- `readScheduledWakes` exists so `/wake` (no args) and `get_power_info` can
  report the recurring schedule next to the one-shot. `WakeInfo` gains a
  `scheduledWakes` field, and `describeWake()` queries/parses
  `ForgeScheduledWake` into it before `formatWakeInfo` renders the new line.

**Sleep after the job (D6).** `sleep_if_idle` suspends only when all of these
hold:
- the resume happened within `WAKE_LEAD_MS + 5 min` of a scheduled trigger;
- `GetLastInputInfo` shows no input since the resume;
- the `busyReason` check (`RemotePowerCommands.ts:60`) is clear.

The input probe lives in `PowerControl`, and `busyReason` moves to an exported
helper so both call sites share it.

## A.5 Files (Part A)

| File | Change | LOC |
| --- | --- | --- |
| `src/system/PowerControl.ts` (263) | `setScheduledWakes`, `readScheduledWakes`, `holdAwake`, `idleSinceResume`; XML split | +150 → ~410. Over the 350 soft limit: extract `wakeTaskXml.ts` (pure XML rendering, a real seam, testable without Windows) |
| `src/system/wakeTaskXml.ts` | new, pure | ~110 |
| `src/system/wakeInfo.ts` | report recurring wakes | +15 |
| `src/remote/RemotePowerCommands.ts` | export `busyReason` | ~5 |
| `test/unit/WakeTaskXml.test.ts` | new | ~120 |

## A.6 Tests (Part A)

- XML: the one-shot task still has `EndBoundary` + `DeleteExpiredTaskAfter`;
  the recurring task has neither; daily and weekday triggers render correctly;
  local-time boundaries (no `Z`); both task kinds render `InteractiveToken`,
  not SYSTEM; an empty wake list means delete.
- `holdAwake` reference counting with a fake spawner: two holds make one
  child, and the second dispose closes its stdin so it exits.
- `sleep_if_idle` decision table (pure function): input since resume, busy, or
  outside the window each means stay awake.
- `WakeInfo.test.ts`: parsed wake data and `formatWakeInfo` show the recurring
  schedule when present and `none` when the scheduled task is absent.
- Manual: repeat A1 step 2 against the real `setScheduledWakes`; the two-day
  recurrence soak from A1 step 3 remains deferred, as recorded in §A.7.

## A.7 Phase A1 results (started 2026-09-15)

> **Re-run check 2 before relying on it. The hardware changed after these tests.**
> The test machine's motherboard was replaced later on 2026-09-15, after the
> checks below ran. That changed the NIC (so the Wake-on-LAN MAC changed), the
> machine's LAN address, and reset the BIOS wake settings to defaults.
> Check 1 (principal) does not depend on hardware. Check 2 (RTC wake) and
> check 4 (lead time) need one repeat on the new board. The site-specific
> addresses are recorded in the private network notes, not in this repo.

**Check 1 (G5) — can a non-elevated VS Code register the SYSTEM wake task? FAIL.**

- Session elevation: `whoami /groups` → `Mandatory Label\Medium Mandatory Level`,
  no elevation (a standard interactive admin session, not UAC-elevated).
- `schedule_wake 5m` (the real `PowerControl.armWakeTimer` → `schtasks /create`
  path) returned **"Access is denied."**
- Post-check `schtasks /query /tn ForgeWakeTimer` → task **absent**. The arm did
  not register anything.
- Precondition confirmed: `RTCWAKE` AC = 1 (wake timers allowed), so the refusal
  is the **principal**, not the power scheme.
- **Conclusion:** a SYSTEM-principal (`S-1-5-18`) task cannot be created from a
  normal VS Code session. This confirms the A.3 step 1 branch: **A2 must switch
  the principal to the interactive user (`InteractiveToken`)** — the no-op
  `cmd /c exit` action does not care who runs it. The recurring
  `ForgeScheduledWake` task (A.4) needs the same treatment: either an
  interactive-user principal, or document that its first arm requires an
  elevated VS Code.

**Check 2 (G3 scheduled wake) — PASS, by direct observation (2026-09-15).**

- Armed a throwaway `TimeTrigger` wake (interactive-user principal, no
  elevation) via `a1-arm-test-wake.ps1`, slept the PC, touched nothing.
- **The PC woke itself at the scheduled time, unattended — confirmed twice**
  (the user watched the screen both times; the wake came back at the armed
  interval, not earlier). This is the core of Part A and it works: an RTC
  `WakeToRun` task brings the machine back from sleep with nobody at the box.
- **Caveat — the Kernel-Power event log is NOT a reliable wake-timer here.**
  `a1-read-sleep-events.ps1` reported the resume (107) only ~16–19 s after the
  dirty-shutdown (42) event and *before* the armed time, which contradicted the
  observed wake. The 42/107 pairing on this machine does not line up with the
  actual RTC wake (likely the 42 is logged at suspend-complete and the 107 is
  not the RTC resume we care about, or events are being coalesced). **Do not
  use the event log to time the wake** — trust the armed boundary and direct
  observation. This also means the G3 "does it re-sleep ~2 min after waking"
  question is still **not** cleanly measured; the user found the PC at the
  logon screen (awake) after the wake, which is consistent with *not*
  re-sleeping, but a clean no-input re-sleep timing is still open.
- **Remaining for check 2:** optionally repeat with `a1-hold-awake.ps1` running
  to confirm `holdAwake` behaviour, and get one clean no-input re-sleep
  timing. Not blocking — the scheduled-wake mechanism itself is validated.

**Check 4 (lead time → `WAKE_LEAD_MS`) — measured 2026-09-15.**

- Server was **resident** (`llama-server` running, Qwen3.8-27B in VRAM) before
  sleep, so this is the fast case: the wake unfreezes an already-loaded server.
- Armed boundary **13:14:55**; first healthy probe (`a1-probe-health.ps1` →
  HTTP 200) at **13:16:47** → **~112 s** from RTC fire to a healthy endpoint.
- **Caveat:** 112 s is an **upper bound**. The gap is dominated by the human
  round-trip (the user had to return and report the wake before the probe ran);
  nothing can probe during sleep. The resident-server thaw is *faster* than
  112 s; the number just can't be pinned tighter without an in-extension probe
  that starts at resume.
- **Recommendation:** `WAKE_LEAD_MS ≈ 120000` (2 min) for the resident-server
  case — covers the OS thaw + network + process thaw with margin. A **cold**
  server (model not loaded, wake triggers a full 27B load) needs far more and is
  out of scope for this measurement; if a job can run against a cold server,
  `WAKE_LEAD_MS` must be raised (or the server kept warm) — flag for A2. A2
  defines `WAKE_LEAD_MS = 120_000` in the scheduler's scheduling helper; it is
  a named, injectable value in scheduler tests, not an untracked literal.

**Check 3 (daily recurrence) — deferred, not blocking.**

- The one-shot RTC wake was validated twice (check 2); the daily trigger is the
  same RTC `WakeToRun` mechanism, so the two-morning soak is low-risk. Deferred
  to avoid a two-day wait; can be run later with
  `a1-arm-test-wake.ps1 -Daily -At HH:MM` if desired.

---

# Part B — Jobs

## B.1 Job model (Zod, `src/jobs/jobSchema.ts`)

```jsonc
{
  "version": 1,
  "id": "llamacpp-releases",           // slug, file name
  "name": "llama.cpp releases",        // what the user says
  "enabled": true,
  "schedule": { "kind": "daily", "at": "06:00" },   // | {kind:"weekly",days:[...],at} | {kind:"interval",minutes>=15}
  "wake": true,                        // add to ForgeScheduledWake (daily/weekly only)
  "after": "stay_awake",               // | "sleep_if_idle"
  "check": {                           // discriminated union on kind
    "kind": "github_release",          // | github_issue | disk_space
    "repo": "ggml-org/llama.cpp",
    "asset_pattern": "win-cuda-13.3-x64"
  },
  "on_change": "notify",               // | "summarize"  (model call, no tools; waits until no turn is streaming)
  "action": null,                      // Phase B5: { "kind": "llamacpp_update", "mode": "prepare" | "apply" }
  "created_at": 0, "updated_at": 0
}
```

Run state lives separately in `~/.forge/jobs/state/<id>.json`, so a user edit
never races a run: `last_run_at`, `last_ok_at`, `last_observation` (typed per
check kind), `consecutive_failures`, `next_due_at`. Every run appends one
JSONL row to `~/.forge/jobs/runs/<id>.jsonl`: time, `late` flag, outcome,
changed yes/no, short summary, delivered count.

All writes use `writeFileAtomicSync` (`src/util/atomicWrite.ts`).

## B.2 Check kinds (no model)

| Kind | Observation | Changed when | Source |
| --- | --- | --- | --- |
| `github_release` | latest release tag, published_at, matching asset names + SHA-256 digests | tag differs | `GET https://api.github.com/repos/{repo}/releases/latest` |
| `github_issue` | state, updated_at, comment count, last comment id/author/200-char excerpt | any field differs | `GET /repos/{repo}/issues/{n}` (covers PRs too) + `/comments?since=` |
| `disk_space` | free bytes per drive | crosses `min_free_gb` in either direction | `fs.promises.statfs(root)`, no subprocess |

- GitHub calls go through one `jobsFetch()`. It refuses any host not in
  `jobs.allowed_hosts` (D5), sends no auth header, and handles `ETag` /
  `If-None-Match` so unchanged checks cost nothing against the 60/hour
  unauthenticated limit. It reuses the `web_fetch` byte cap.
- The first run only records a baseline. It never reports "changed".

## B.3 Scheduler (`src/jobs/JobScheduler.ts`)

- **Lease (D2).** `RemoteTransportLease` is already generic (it takes a `key`).
  Move it to `src/util/FileLease.ts` with no behavior change, keep the remote
  import working, and acquire it with key `jobs-scheduler` in
  `~/.forge/leases/`. Without the lease, a window stays passive, but its
  `manage_jobs` still edits files and the lease holder picks up the change.
  The jobs lease is independent of the Telegram lease; delivery between the
  two goes through the outbox (§B.4).
- **Tick** every 30 s. Due means `next_due_at <= now`. A job never runs twice
  at once, and at most two jobs run together.
- **Resume detection.** Node has no power event, so a tick that arrives more
  than 90 s late counts as a resume. On resume: run overdue jobs **once**, mark
  them `late`, and hold `holdAwake` for the duration.
- **Watch the job directory** (`fs.watch` + 1 s debounce). On change: reload,
  recompute `next_due_at`, and call `setScheduledWakes()` with the distinct
  local trigger times of enabled `wake: true` jobs, shifted earlier by
  `WAKE_LEAD_MS`. A shift across midnight also shifts a weekly wake to the
  preceding weekday. Reconcile this same complete set when the scheduler
  acquires its lease. At activation/config reload, `jobsSetup` invokes the
  scheduler's wake-reconcile entry point even when it will not start a tick;
  `jobs.enabled: false` or an absent block passes `[]` and deletes
  `ForgeScheduledWake`, so a stale task cannot wake the machine after its jobs
  are disabled.
- **Backoff.** After 3 consecutive failures, report once and double the
  interval up to 24 h. The first success resets it and reports recovery.
- **Disposal.** The tick stops, the lease is released, and holds are disposed.
  Everything is registered through `context.subscriptions`.

## B.4 Delivery

**Verified 2026-09-14, and the reason for the D2 outbox:**
- The remote sink **drops** a notification with no conversation:
  `src/remote/remoteHostSubscriptions.ts:40` returns 0 when
  `event.conversationId === undefined`.
- The remote outbox (`RemoteRequestStore`) is held in memory by the window that
  owns the Telegram transport. A different window's `notify()` never reaches
  it.

So jobs cannot simply call `UserNotificationService.notify` in the scheduler
window. Instead:

- **Outbox.** The scheduler writes `~/.forge/jobs/outbox/<job-id>.json`
  (atomic) with `{text, changed_at, earlier_count, first_undelivered_at}`.
  Writing a job's outbox file again **replaces** the text with the newest one
  and increments `earlier_count`. That makes coalescing automatic: at most one
  pending message per job. Items whose `first_undelivered_at` is older than
  24 h are cut down to a count ("N changes while offline, see `/job <n>`").
- **Delivery.** The window holding the Telegram lease watches the outbox
  directory (`fs.watch` + debounce, plus a scan when it acquires the lease),
  sends each item to the **owner chat** through a new explicit `ownerChat`
  route on the remote controller, and deletes the file only after
  `notifyOutbox` accepted it. This is a new route in the remote layer, not a
  workaround in jobs code; the `conversationId === undefined` branch stays as
  it is for other callers.
- **No Telegram configured.** The scheduler window also shows the VS Code toast
  through `UserNotificationService.notify({ text })` (no conversationId), and
  the outbox file stays until a Telegram window appears or the 24 h cutoff
  turns it into a count. Called directly, not through `notify_user`, so the
  per-turn burst cap does not apply.
- **Same bot.** The main bot delivers job messages, so replies and `/job`
  commands work in the same chat. Plain-text replies go to whatever
  conversation the chat is bound to, and that agent can act on them through
  `manage_jobs`. That is why every message names the `/job` command.
- Delivered: a change, a failure, or recovery after failure. A run with
  nothing new writes only the run log.
- **Summarize waits.** For `on_change: "summarize"`, the outbox write happens
  after the no-tools summary. The summary runs only when
  `getStreamingConversationIds()` is empty. Until then the run row is already
  written with `changed: true`, and the job is marked `summary_pending` in its
  state file.
- Text format: `Job "<name>": <summary>` plus one line saying how to act on it
  (`/jobs`, or "ask Forge to pause <name>").

## B.5 Agent + Telegram control (D4)

**Tool `manage_jobs`** (`src/tools/jobTools.ts`):
- Advertised only when `jobs.enabled`, and then in **every** conversation, both
  normal chats and job discuss chats (user requirement, 2026-09-14): add a
  watch, edit its target or schedule, pause, resume, or remove it from wherever
  the user happens to be talking.
- `update` takes a partial `definition` (for example only `schedule`), so
  "check llama.cpp at 08:00 instead" is one call.
- Permission `read` for `list`/`get`, `write` for everything else. `delete`
  always asks for approval, even under /clanker.

```jsonc
{ "action": "list" | "get" | "create" | "update" | "pause" | "resume" | "delete" | "run_now" | "discuss",
  "job": "string (id or name, fuzzy-matched; required except list/create)",
  "definition": { /* create/update only: the B.1 fields, strict schema, no free-form blobs */ } }
```

- An ambiguous `job` match returns the candidates instead of guessing, so
  "stop watching llama.cpp" with two llama.cpp jobs makes the agent ask.
- `run_now` runs in the lease holder, which may be another window. The tool
  writes a `run_requests/<id>` marker file that the scheduler consumes, and the
  result says so.
- `list` returns one line per job: name, enabled, schedule, last run and
  outcome, next due.

**Telegram** (`src/remote/RemoteJobCommands.ts`, split out like
`RemotePowerCommands`):
- `/jobs` lists the jobs, numbered.
- `/job <n|name> pause|resume|run|delete|approve`. `delete` needs `confirm`,
  like `/sleep`.
- Add both to `TELEGRAM_BOT_COMMANDS` and the remote help text, and extend the
  command drift guard's `SOURCES` array (the 2026-09-08 lesson).

## B.6 Chat per job (D3)

**Why on demand instead of appending to a chat on every run:** Forge has no way
to add a message to a conversation without running a model turn
(`ForgeHostFacade` exposes `send`, not append). A turn per run would cost
tokens and VRAM for "nothing new" results, and it would collide with a chat
already streaming. The run log already records every run.

`manage_jobs {action:"discuss"}`, `/job <n> chat`, or the sidebar's
**Discuss** command:
1. Reuses the job's conversation if `state.conversation_id` still exists
   (`restoreConversation`). Otherwise it calls `createConversation({activate})`
   and stores the id.
2. Sends a seed message through `host.send`: the job definition, the last 10
   run rows, and the last observation, capped at 4,000 chars, ending with
   "The user wants to discuss this job." From then on it is an ordinary chat
   with `manage_jobs` available.

Result: "discuss the llama.cpp watcher" always lands in the same chat, and
normal chats never get job output. That discuss chat is an ordinary session
under `~/.forge/sessions/`, so HalluScribe archives it. The runs themselves
stay in `~/.forge/jobs/` and do not (D1).

## B.7 Phase B5 — `llamacpp_update` action (last)

The only mutating action. Implemented in TypeScript as fixed stages; the model
never authors a step. Facts it relies on (verified 2026-09-14):
- Builds live side by side in `%LOCALAPPDATA%\Forge\llama.cpp-bNNNN\`. The user
  can write there, so no UAC is needed.
- The global binary is `llama_server.binary` in `.forge/config.yaml`
  (currently `llama.cpp-b10894`).
- Per-group `llama_server_binary` pins exist (`llamacpp-glm5` →
  `llama.cpp-glm5next`, a source build) and must **never** be touched.

Stages, one run-log row each:
1. **Detect:** comes from the `github_release` check.
2. **Download:** `llama-bNNNN-bin-win-cuda-13.3-x64.zip` +
   `cudart-llama-bin-win-cuda-13.3-x64.zip` into `%LOCALAPPDATA%\Forge\staging\`.
   The asset pattern comes from the job, never a hardcoded default (CLAUDE.md).
3. **Verify:** SHA-256 against the release API `digest` field. No digest means
   stop and report; never install unverified.
4. **Extract:** both zips into `llama.cpp-bNNNN\`. If the folder already
   exists, stop.
5. **Smoke test:**
   - `llama-server --version` must report `bNNNN`;
   - `--list-devices` must show the expected CUDA device;
   - start the configured `embeddings:` model on a free port, do one embedding
     round-trip, then stop it.
6. **In `prepare` mode:** stop here and deliver "b10910 staged and passed the
   smoke test. Reply `/job <n> approve` to switch." Approval expires after 24 h.
7. **Switch:** `updateConfigFile()` (`src/config/ConfigWriter.ts:38`, preserves
   comments) sets only `llama_server.binary`, then restarts the backend through
   `host.restartModel` only if **no turn is streaming**. Otherwise it defers to
   the next idle tick.
8. **Post-check:** the backend answers `/health`. On failure, restore the
   previous line, restart, and report.
- Old build folders are never deleted.
- **No approval gate (decided 2026-09-14).** `apply` mode skips step 6 and is
  allowed from day one; no count of earlier `prepare` runs is required.
  `prepare` stays available per job. Steps 3, 5, 7's streaming deferral, and 8
  run in both modes; `apply` removes only the human approval.
- **Known limitation (intentional): the idle check is a snapshot, not a lock.**
  Step 7 checks `busy()` once before the config write + restart, but a turn can
  start in that window. The window is tiny (a single tick, sub-second) and the
  restart is the same `restartModel` a turn would trigger, so the worst case is
  a brief GPU contention, not a corruption. A shared turn/restart exclusion
  lock is out of scope for v1; the post-check (step 8) still catches a broken
  backend and rolls back.

## B.8 Config (`src/config/jobsSchema.ts`, following `imageGenerationSchema.ts`)

```yaml
jobs:
  enabled: true
  allowed_hosts: [api.github.com]   # B5 adds the asset-download redirect host, measured then, not guessed now
  max_concurrent: 2
```

If the `jobs:` block is absent: no scheduler, no lease, no tool, no Telegram
commands. The KV prefix is unchanged for configs without it, the same as
`image_generation`.

## B.9 Files (Part B)

`src/extension.ts` is **499 lines** (hard stop 500), so all wiring goes in a
new `src/vscode/jobsSetup.ts`, and `extension.ts` gains one call.

| File | Phase | LOC |
| --- | --- | --- |
| `src/config/jobsSchema.ts` + `schema.ts`/`types.ts` hookup | B1 | ~60 + 10 |
| `src/jobs/jobSchema.ts` (Zod job + state + run row) | B1 | ~140 |
| `src/jobs/JobStore.ts` (load/save/watch, atomic, run log) | B1 | ~200 |
| `src/jobs/JobScheduler.ts` (tick, resume, lease, backoff, wakes) | B1 | ~280 |
| `src/jobs/checks/github.ts` + `jobsFetch.ts` | B1 | ~220 |
| `src/jobs/checks/diskSpace.ts` | B1 | ~60 |
| `src/jobs/JobOutbox.ts` (coalescing write, 24 h cutoff, scan/consume) | B1 | ~120 |
| `src/remote/` owner-chat route + outbox watcher in the Telegram lease holder | B1 | ~80 |
| `src/util/FileLease.ts` (moved from `RemoteTransportLease.ts`) | B1 | move, ~0 net |
| `src/vscode/jobsSetup.ts` | B1 | ~90 |
| `src/tools/jobTools.ts` (`manage_jobs`) + registration | B2 | ~260 |
| `src/remote/RemoteJobCommands.ts` + menu/help | B3 | ~180 |
| discuss seeding (in `jobTools.ts` / `jobsSetup.ts`) | B4 | ~80 |
| `src/jobs/actions/llamacppUpdate.ts` | B5 | ~320 |
| `docs/OWNERS.md` rows; `docs/JOBS.md` user doc; `CHANGES.md` | each | — |

Adding `manage_jobs` changes the hardcoded tool counts:
`RegisterAllTools.test.ts:151,181` and `ToolHarness.test.ts:69,80,105` (74 → 75,
including the one in the test *name*), plus `scripts/tool-audit-catalog.mjs`.

## B.10 Tests

- **JobStore:** a malformed job file is reported, not skipped silently; the
  atomic write survives a concurrent read; the run log appends only.
- **Scheduler** (fake clock + fake store): due computation for daily, weekly,
  and interval schedules across DST; a late tick triggers exactly one catch-up
  run; no double run; backoff and recovery reporting; no lease means no runs;
  wake times recomputed on lease acquisition and change; `WAKE_LEAD_MS =
  120_000` shifts a weekly 00:01 job to the preceding weekday; disabling jobs
  deletes scheduled wakes; summarize deferred while a turn streams.
- **Outbox:** a second change for the same job replaces the text and bumps
  `earlier_count`; an item past 24 h renders as a count only; the Telegram
  holder deletes a file only after the remote outbox accepted it; a
  conversation-less `notify` still returns 0 from the existing sink.
- **Checks** (recorded API fixtures): baseline run reports nothing; a tag
  change is reported; `ETag` 304 counts as unchanged; a host outside
  `allowed_hosts` is refused with a message naming the config key.
- **`manage_jobs`:** schema is strict; ambiguous name returns candidates;
  `delete` always asks for approval; not advertised without `jobs:`.
- **Remote:** `/jobs`, `/job n pause`, `delete confirm` window; drift guard
  covers the new file.
- **`llamacpp_update`** (fake fs/spawn/fetch): digest mismatch stops before
  extract; smoke-test failure leaves config untouched; switch touches only
  `llama_server.binary` and keeps comments (fixture includes a group pin and
  comments); post-check failure restores the line; `apply` switches without
  approval but still stops on a digest or smoke-test failure.
- **Gates:** `npm run ci`, `npm run package`.
- **Live smoke, B1:** a `github_issue` job on a real llama.cpp issue at the
  minimum valid 15-minute interval, plus one scheduled wake from sleep,
  delivered on Telegram. **CHANGED: B.1 rejects intervals below 15 minutes.**

## B.11 Rollout order

A1 validation → A2 wake → **B1** store + scheduler + checks + notify (usable
alone: jobs defined by hand in JSON) → **B2** `manage_jobs` → **B3** Telegram
→ **B4** discuss → **B5** `llamacpp_update` (prepare and apply; apply is
allowed from day one). **CHANGED: this now matches the signed-off no-gate
decision.** Each
phase ends green on CI and is committed separately with its `CHANGES.md` entry.

## Out of scope

- Running while VS Code is closed or after a shutdown. That needs a logon-time
  launcher, which is tied to the undecided ownership of the Windows Host
  Controller.
- Model-authored actions and tool-using model runs inside jobs. `summarize`
  uses the no-tools `runPromptToMarkdown` path.
- Authenticated GitHub API, webhooks, RSS, and generic HTTP checks.
- A jobs panel in the sidebar UI. Chat, the tool, and Telegram cover control
  for v1.
- Dish cron WoL as a second wake path. That is site-specific and belongs in
  the network repo.

## Acceptance criteria

Checklist of invariants and edge cases, each mapped to a test or a named
validation step. A green suite is necessary, not sufficient — each item below
is what the suite must prove.

1. **Jobs live outside `~/.forge/sessions/`** (D1). `JobStore` writes to
   `~/.forge/jobs/<id>.json`, `state/<id>.json`, `runs/<id>.jsonl`.
   Validation: `test/unit/JobStore.test.ts` (save/load, separate state file,
   run log) + the A1/A2 manual steps already recorded.
2. **A malformed job file is reported, not skipped silently.** Validation:
   `JobStore.test.ts` "a malformed job file is reported"; a corrupt state file
   falls back to the default state.
3. **`loadAll` is deterministic** (creation, then id) so `/jobs` numbering and
   `/job <n>` resolution agree. Validation: `JobStore.test.ts`
   "loadAll returns jobs in a deterministic order".
4. **The scheduler runs a job at most once per due window**, honours
   `maxConcurrent`, and does not double-run a job that is already running.
   Validation: `test/unit/JobScheduler.test.ts` + `JobSchedule.test.ts`
   (interval/daily/weekly due math, lead time, midnight rollover, dedup).
5. **`run_now` is cross-window and idempotent.** A `run_requests/<id>` marker
   runs the job on the next tick in whichever window holds the lease; the
   marker is deleted as consumed, so a crash mid-run does not re-fire it; a job
   id containing a dot round-trips. Validation: `JobTools.test.ts`
   (run_now marker, dotted-id round-trip) + `JobScheduler.test.ts`
   (marker consumption).
6. **`manage_jobs` (B2)**: one tool, `action` enum, advertised only when
   `jobs.enabled`; `read` for list/get, `write` for the mutating actions,
   `delete` for delete; `update` takes a partial definition and rejects unknown
   keys and the id; `delete` always asks for approval; resolution is exact
   id/name or unique substring, ambiguous returns the candidates. Validation:
   `test/unit/JobTools.test.ts` (32 tests).
7. **The Telegram commands (B3)**: `/jobs` lists numbered; `/job <n|name>
   pause|resume|run|delete` resolves by number/exact/substring, ambiguous
   returns candidates; a multi-word name resolves (the action is the final
   token); `delete` needs `confirm` within 90s and the confirmation re-checks
   `updated_at` so a job deleted and recreated with the same id is not deleted
   by a stale confirmation; `approve` answers "not available yet" (B5). Both
   are in `TELEGRAM_BOT_COMMANDS`, `/help`, and the drift guard. Validation:
   `test/unit/RemoteJobCommands.test.ts` + `test/unit/RemoteRichText.test.ts`
   (drift guard).
8. **The outbox coalesces to one pending message per job** (D2): newest wins,
   carries a count of earlier undelivered changes, and items older than 24 h
   are counted, never sent. Validation: `test/unit/JobOutbox.test.ts` +
   `JobOutboxWatcher.test.ts`.
9. **The discuss chat (B.6)** is opened on demand, reuses the job's
   conversation when it still exists, seeds it with the definition, the last 10
   run rows, and the last observation, and persists `state.conversation_id` so
   the next entry point reuses it. All three entry points share one seeding
   path: `manage_jobs {action:"discuss"}` (B2), `/job <n> chat` (B4), and the
   (out-of-scope) sidebar command. Validation: `JobTools.test.ts` (discuss)
   + `RemoteJobCommands.test.ts` (`/job <n> chat`).
10. **`llamacpp_update` (B5)** runs its safety stages in `apply` mode (digest
    verify, smoke test, defer while a turn streams, post-check rollback);
    `prepare` + `/job <n> approve` stays available as a per-job choice. No
    gate on `apply` from day one (signed-off). Validation: named manual step
    (a real release) + unit tests for the action's stage ordering and rollback.
