# Handoff — Scheduled Wake + Agent Jobs: decisions session

> **Outcome (2026-09-14, decisions session):** D1–D7 and both open questions
> are answered and recorded in the plan's "Decisions" and "Open questions"
> sections. Changes from the recommendations below: D2 gained a coalesced file
> outbox (the remote sink was verified to drop conversation-less
> notifications), `summarize` waits for idle, `manage_jobs` is available in
> every chat, and the `llamacpp_update` approval gate is **dropped**. Next:
> Phase A1 validation. The tables below are kept as the pre-decision record.

**From session:** 2026-09-14
**Purpose of the next chat:** go through decisions D1–D7 with the user, record
each answer in the plan, then either run the Phase A1 validation or start
Phase A2. **No implementation happened in the previous session.**

**Read first:**
1. `docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md`: the implementation plan. This
   handoff only summarizes it.
2. `src/system/PowerControl.ts`, `src/remote/RemotePowerCommands.ts`: the
   current wake code.

---

## Repo state

- `main` = `origin/main` at **`5659099`** ("docs: reconcile README, delegation,
  commands and roadmap with 0.16 code"), pushed, CI green.
- **Uncommitted:**
  - `docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md` (new)
  - `docs/plans/PERSISTENT_AGENT_JOBS_HANDOFF.md` (this file)
  - `ROADMAP.md` (the "Persistent agent jobs" bullet now links to the plan)

  Commit these once the decisions are recorded. Stage by name; do not use
  `git add -A`.
- `generated-images/` is untracked, predates both sessions, and is not ours.
  Leave it alone.

## How the user works (relevant here)

- Solo repo: commit straight to `main`, never branch without asking, run
  `npm run ci` before every commit.
- Plan before code, grounded in the source. This feature is large, so **pause
  for sign-off** before implementing (per the `feedback_md_plan_before_impl`
  memory).
- The user writes short messages, often in Greek-inflected English. Ask one
  focused question at a time.

---

## Decisions to take (recommendation first)

| # | Question | Recommendation | Main alternative | Why the recommendation |
| --- | --- | --- | --- | --- |
| **D1** | Where are jobs stored? | `~/.forge/jobs/`: machine-level JSON, one file per job, plus `state/` and `runs/*.jsonl` | Per workspace in `<ws>/.forge/jobs/` | llama.cpp and disk checks are about the machine, not a repo. A job can still name a workspace later. |
| **D2** | Which VS Code window runs the scheduler? | Whoever holds a `jobs-scheduler` file lease (move `RemoteTransportLease` → `src/util/FileLease.ts`) | Only the window holding the Telegram lease | Keeps jobs independent of Telegram being configured. ~24 Code processes run on this PC, so exactly-once needs a lease. |
| **D3** | Does every run post into the job's chat? | **No.** Runs go to the run log. The job's chat opens on demand ("discuss"), seeded with the definition and last 10 runs, and is reused every time. | Every run appends to the job chat | `ForgeHostFacade` has `send` (a model turn) but no append-message API. A turn per "nothing new" run wastes tokens and VRAM and collides with a chat that is already streaming. **This reverses what the user was told earlier in the session; confirm explicitly.** |
| **D4** | Agent control surface | One tool, `manage_jobs`, with `action` enum list/get/create/update/pause/resume/delete/run_now/discuss | Five separate tools | One schema's worth of prompt cost, one round per call. Ambiguous names return candidates; `delete` always asks for approval, even under /clanker. |
| **D5** | Outbound network | GitHub only when listed in `jobs.allowed_hosts` (default empty); unauthenticated, with ETag caching | Built-in allow for `api.github.com` | CLAUDE.md hard stop: no outbound traffic except user-configured endpoints. |
| **D6** | After a scheduled wake | Default `stay_awake`; per-job `sleep_if_idle` (sleeps only if the resume matched the trigger, there was no input since, and nothing is busy) | Always go back to sleep | A surprise suspend is worse than a PC left on. On mains this PC never idle-sleeps (`STANDBYIDLE` AC=0). |
| **D7** | Shutdown or closed VS Code | Unsupported: jobs need **sleep, not shutdown**, with VS Code left open | A logon-time launcher | A launcher depends on the undecided ownership of the Windows Host Controller (HalluScribe starts one at logon today). Keep that out of scope. |

### Also still open (from the user)

- **What exactly should the "llama.cpp thread" watch?** New releases
  (`github_release`), a specific issue/PR (`github_issue`, needs the number),
  or both? Asked, not answered. If it is an issue, get the URL or number.
- **Who installs:** the plan's B5 `llamacpp_update` stops at "staged + smoke
  test passed, reply `/job <n> approve`". Automatic switching (`apply`) unlocks
  only after 3 approved runs. Confirm the user wants that gate.

---

## Verified facts the decisions rest on (2026-09-14)

**Wake today:**
- `armWakeTimer` registers `ForgeWakeTimer`: a **one-shot**
  `TimeTrigger`, `WakeToRun`, `DeleteExpiredTaskAfter=PT1M`, principal SYSTEM.
  It deletes itself after firing.
- Entry points: `schedule_wake` tool, Telegram `/wake [8h|07:00|YYYY-MM-DD HH:MM|off]`,
  `/sleep [time] confirm`.
- **There is no recurring wake anywhere in Forge.** The user believed a 6:00
  daily wake existed. Nothing is armed now, and no wake-to-run tasks are
  visible. If a daily wake really happens, it comes from outside Forge; the
  LiteBeam dish has `crond` and sends WoL. Ask the user where it comes from.

**Power settings on this PC:**
- `RTCWAKE` AC = 1.
- `STANDBYIDLE` / `HIBERNATEIDLE` AC = 0.
- `UNATTENDSLEEP` is hidden (default 120 s).

**llama.cpp:**
- Builds live in `%LOCALAPPDATA%\Forge\llama.cpp-bNNNN\`, which the user can
  write to, so no UAC is needed.
- The global binary is `llama_server.binary` → `llama.cpp-b10894` in
  `.forge/config.yaml`.
- The per-group pin `llama_server_binary` → `llama.cpp-glm5next` must never be
  touched.
- Config writes go through `updateConfigFile()` (preserves comments).

**Constraints the implementation will hit:**
- `src/extension.ts` is **499 lines** (500 hard stop), so wiring goes in a new
  `src/vscode/jobsSetup.ts`.
- Adding a tool changes hardcoded counts: `RegisterAllTools.test.ts:151,181`,
  `ToolHarness.test.ts:69,80,105` (74 → 75, including one in a test *name*),
  plus `scripts/tool-audit-catalog.mjs`.
- New Telegram commands must go in `TELEGRAM_BOT_COMMANDS` and the drift
  guard's `SOURCES` list, or they ship invisible (happened 2026-09-08).
- `UserNotificationService.notify({text})` works without a conversationId.
  **Unverified:** whether the remote sink delivers that to the owner chat or
  drops it. Check before relying on it in B1.

**Why this isn't the auto-wake that was rejected:** the 2026-08-24 rejection
was of *background exec re-invoking a chat tab* (no conversation id, collides
with streaming, steals focus). Separate job sessions avoid all three.

---

## Phase A1 checklist (after decisions, needs the user at the PC)

1. ~~From normal (non-elevated) VS Code: Telegram `/wake 5m`, then
   `schtasks /query /tn ForgeWakeTimer`. Is it registered? (SYSTEM principal
   question.)~~ **DONE 2026-09-15: NOT registered — `schtasks` returns
   "Access is denied" and the task is absent. Confirmed non-elevated session
   (`Medium Mandatory Level`). A2 switches the principal to the interactive
   user. See plan §A.7.**
2. ~~A throwaway wake 3 min out → sleep → touch nothing. Does it wake itself?~~
   **DONE 2026-09-15: YES — the PC woke itself at the armed time, unattended,
   confirmed twice by watching the screen.** The scheduled RTC `WakeToRun`
   mechanism works. (Note: the Kernel-Power 42/107 event log does NOT line up
   with the actual wake on this box — do not use it to time the wake; trust the
   armed boundary + direct observation. A clean no-input re-sleep timing is
   still open but not blocking.)
3. The same daily task wakes the PC two mornings in a row. — **pending**
   (`a1-arm-test-wake.ps1 -Daily -At HH:MM`).
4. Measure resume → Telegram `/status` answers → `llama-server` ready. This sets
   `WAKE_LEAD_MS`. — **pending** (armed boundary + wall clock, not the event log).

Record the results as §A.7 in the plan. (Checks 1–2 recorded 2026-09-15.)

---

## Unrelated finding from the same session (not part of this work)

`ask_local_agent` **CLI delegation takes no rollback checkpoint.** Only direct
CLI chat calls `snapshotWorkspaceBefore`. Delegates run unrestricted, so
Keep/Undo cannot reverse their edits. Also, Ollama `:cloud` delegates get the
120 s timeout rather than 300 s. Both are item 1–2 under "Now" in `ROADMAP.md`
and documented in `docs/DELEGATION.md`. Don't mix them into the jobs work
unless the user asks.

---

## Suggested opening prompt for the new chat

> Read `docs/plans/PERSISTENT_AGENT_JOBS_HANDOFF.md` and
> `docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md`. Walk me through decisions D1–D7
> one at a time with your recommendation, then the two open questions. Record
> my answers in the plan, then commit the plan, the handoff and ROADMAP.md.
