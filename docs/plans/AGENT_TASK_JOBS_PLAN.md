# Agent-task jobs — a job that runs an agent turn, unattended (impl plan)

Status: plan, not started. Owner of the final call: Claude. Implementer: Forge,
phase by phase; Codex reviews and fixes each phase.

**Phase 1 is a trial of Qwopus** (`qwopus38-27b-flash-mtp-q5km-no-vision`,
thinking off, first real coding run). Claude scores it against this card, then
decides who writes phase 3:

| Check | Pass |
|---|---|
| `npm run ci` green on its own commit | without Codex fixing a failure |
| Codex review | no high-severity findings; at most 2 small fixes |
| Scope | only the phase 1 files; nothing invented |
| Tests | `check.none`, `agent_task`, the 4000-char cap, a rejected bad task, the new state fields' defaults |
| Commit message | says what the commit does |
| `ask_user` calls | 0 |
| Tool loop | no repeated read/search after it already had the answer; did not stop at a description instead of editing |

Claude audits the session log (`~/.forge/sessions`, deduped, by `forge_version`)
for rounds, tool failures and repeats, and writes the verdict here.

## Why

The shipped jobs feature (`docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md`) never
loads an agent. A job is `check` → `on_change` → `action`, and the one action
there is, `llamacpp_update`, is a fixed pipeline. It runs download → digest →
extract → smoke → stage → switch → restart → post-check. When llama.cpp renames
an asset, moves a CDN host or changes `--version` output, a stage fails and
nothing adapts. The first live run showed this: two missing
`jobs.allowed_hosts` entries, then an empty `--version` in the smoke stage.

The user wants the job to carry a **task in plain language**. When it fires,
an agent reads the task, thinks, runs commands and finishes. When the agent
cannot finish, **the owner hears about it on Telegram**. Once the agent path
works, the fixed pipeline is retired (user decision, 2026-09-21).

The scheduling half is already built and tested, and none of it changes:

- schedules;
- the scheduler lease;
- machine wake;
- backoff;
- the run log;
- the coalescing outbox, and `JobOutboxWatcher` → Telegram;
- `manage_jobs`;
- `/job` on Telegram.

This plan adds one action kind, plus the rules an agent turn needs when nobody
is watching it.

## Design

### The job shape

```jsonc
{
  "id": "llamacpp-latest",
  "name": "Keep llama.cpp current",
  "schedule": { "kind": "daily", "at": "03:00" },
  "wake": true,
  // The cheap typed check still gates the expensive agent: no new release, no turn.
  "check": { "kind": "github_release", "repo": "ggml-org/llama.cpp", "channel": "prerelease" },
  "on_change": { "kind": "notify" },
  "action": {
    "kind": "agent_task",
    "task": "A new llama.cpp release is out (see the observation). Install the CUDA Windows build next to the current one under %LOCALAPPDATA%\\Forge, point llama_server.binary in config.yaml at it, and say RESTART: yes. Read docs/LLAMACPP_UPDATE.md for how.",
    "model": "qwen-flash",       // optional; default: the default chat model
    "max_minutes": 240,           // optional wall-clock cap; omitted = no clock cap, only the model's own caps
    "report": "failures_and_changes" // or "always"
  }
}
```

- **`check: { kind: "none" }` is added** for a task that runs on every
  schedule tick. `none` always reports `changed: true` with an empty
  observation.
- **`github_release` is the recommended gate for the llama job.** A job that
  loads a model and burns 30 minutes of tokens should not do it just to find
  that nothing changed. The check costs one HTTP call. The agent does the part
  that breaks when upstream changes.
- **`task` is capped at 4000 characters.** It is natural-language content, like
  `ask_user`'s question or `ask_live_session`'s message, not a structured blob,
  so the "no free-form string blob args" hard stop does not apply. `manage_jobs`
  gets a `task` field with the same cap.
- **The check's observation is appended to the prompt**, for example the
  release tag and asset names. The agent starts from facts, not from a fresh
  API call.

### Unattended conversations (the safety core)

A job turn runs in its own conversation, and that conversation is registered as
**unattended**. The registry is one new owner file,
`src/sidebar/unattendedConversations.ts`: an in-memory `Set<string>` with
`mark(id)` → disposable and `has(id)`. It is **per conversation**. It never
touches the global clanker flag, because a user chatting in another tab must
keep their approval gate.

Three services consult it:

| Service | Attended (today) | Unattended |
|---|---|---|
| `ToolApprovalService.request` | Prompts the sidebar or remote chat | Non-dangerous: approved. **Dangerous: denied at once, never prompted.** The denial tells the agent to stop and report `RESULT: failed` naming the action it needed. |
| `ask_user` (`uxTools.ts`) | Blocks until answered | Returns immediately: "Nobody is attending this job run, so no answer will come. Make the safest assumption and continue, or stop and report RESULT: failed with the question." It must never block. A question nobody sees is the 3 a.m. hang. |
| `notify_user` | Toast, plus the remote chat if the turn was driven remotely | Toast, **plus an outbox item** → Telegram owner chat. A job turn has no remote origin, so today its `notify_user` would reach nobody. |

These return strings are guidance for a failed tool, and they follow the
CLAUDE.md rule: the guidance belongs in the string, not in a prompt rule. They
must be true. A denial must say it was a policy denial, not an error.

### The runner: `src/jobs/agentTask.ts` (new, ~200 LOC)

`JobScheduler.ts` is at the 500-line hard stop. The runner is a dependency
called from the action path, like `llamacpp`. If the call site does not fit,
first move `runCheck` (lines 396–456) into `src/jobs/checks/runCheck.ts`. That
is a real seam: the scheduler decides when a job runs, and the checks decide
what it observes.

One run:

1. **Start now if a slot is free, otherwise wait.** A llama-server with
   `n_parallel: 2` serves two conversations at once on one model load, each
   with `perSlotContext()` = `num_ctx / n_parallel`. The job therefore does not
   wait for full idle. It starts now when all three hold:
   - its model is the resident one, nothing is loaded, or the resident model
     is a different one with **nothing streaming** (step 3 unloads it; an idle
     model is not a reason to wait);
   - fewer conversations are streaming on that model than its `n_parallel`
     (`status().streamingConversationIds`);
   - its own conversation is not streaming.

   Otherwise it records `task_pending` and the next tick retries. There are two
   hard waits:
   - **Its own chat is busy.** Two turns in one conversation would interleave.
   - **It needs a different model while one is streaming.** A second
     llama-server spills VRAM on this PC, and unloading would kill the live turn.

   Running beside a live chat splits generation speed between the two slots.
   That is accepted: at 3 a.m. there is no live chat, and during the day a
   slower answer beats a job silently skipped.
2. **Persist the marker** before anything else:
   `state.task_run = { started_at, conversation_id: null }`.
3. **Model.** If `action.model` differs from the resident model and nothing is
   streaming, call `unloadModels()` first. Two llama-servers on this PC spill
   VRAM. Then open **the job's own conversation**, not activated:
   `state.conversation_id`, the same chat `/job <n> chat` and
   `manage_jobs discuss` already open (B.6). It is created on the first run if
   missing, with the same restore-or-create fallback `openDiscussChat` uses.
   Extract that fallback into a helper both call. The runner must **not** send
   the discuss seed: its own prompt (step 5) is the only message.
   `openDiscussChat` refuses while `task_run` is set ("the job is running; its
   chat shows the turn live"): a seed sent mid-run would be a second turn in the
   same conversation.
   Then call `setConversationModel`. Record the id in
   `task_run.conversation_id`.
   - **One chat per job, for its whole life.** A run can see what earlier runs
     found and reported, so a watch job does not notify about the same comment
     twice. The owner can reply in that chat ("stop reporting X") and the next
     run sees it. Auto-compaction bounds what the model reads, so the chat never
     needs to be split to stay small.
   - The session log keeps every turn verbatim. HalluScribe reads it as
     summaries and raw transcripts, so **nothing is ever deleted**.
   - When a job is created from a chat (`manage_jobs create`), its first message
     is a short summary of why: the task, plus the lines of the originating chat
     that explain it. The job then starts with the context the owner had.
4. **Mark it unattended**, take `power.holdAwake`, and snapshot `config.yaml`'s
   bytes to `~/.forge/jobs/state/<id>.config.bak` (the rollback for step 7).
5. **Send the prompt**, made of:
   - the task;
   - the observation;
   - the last 3 run rows;
   - "The facts in this message are current; where they disagree with anything
     earlier in this chat or its compaction summary, these win." Compaction
     summaries have been misread as new news before
     (`project_forge_compaction_resume_misread`), and an old "already installed
     b1234" must not beat today's observation;
   - this block:
     > You are running unattended as scheduled job "<name>". Nobody will answer
     > questions or approvals. Dangerous actions will be denied. End your final
     > message with exactly one line:
     > `RESULT: ok | no_change | failed — <one sentence>`
     > If you changed llama_server.binary, add a line `RESTART: yes`. Do not
     > restart the backend yourself: you are running on it.
   Config hot-reload does **not** restart the backend (`src/vscode/configReload.ts`
   only reloads and says "restart backend if you changed spawn settings").
   So the agent editing `llama_server.binary` mid-turn is safe. The switch
   happens only in step 7.
6. **Caps: reuse the model's own.** The round and budget caps are the model's
   existing `max_tool_rounds` and budget settings. They were tuned after an
   18-hour Qwen run and are not duplicated per job. The one job-level knob is
   the optional `max_minutes`. Once it elapses, the runner calls
   `cancel(conversationId)`, **awaits the `send` promise settling** (so
   `finally` never runs while the turn is still unwinding), and the outcome is
   `timeout`. It exists so an
   overnight run always has an answer on Telegram by morning, instead of still
   running. There is no default: omitted means no clock cap (CLAUDE.md: no
   hardcoded fallbacks for user-configurable params).
7. **Restart after the turn.** This happens only if `RESTART: yes` and
   `RESULT: ok`. It is deterministic runner code, not the model, because the
   model runs on the backend being replaced:
   - call `restartModel(model)`;
   - wait up to 5 min for ready;
   - if the model does not become ready, restore `config.yaml` from the `.bak`,
     restart again, and set the outcome to `failed — new binary did not load,
     rolled back to <old>`.
8. **Report.** Parse the `RESULT` line from `finalText`, then map it:

   | Situation | Outcome |
   |---|---|
   | No `RESULT` line | `failed — agent ended without a RESULT line` (never silently ok) |
   | `failed` / `cancelled` / `interrupted` request, or timeout, or failed restart | `failed` |

   Deliver through `JobDelivery.deliver` (outbox → Telegram):
   - **Every failure is reported immediately.** This overrides the B.3
     "report once after 3 failures" rule for this action kind. That rule was
     written for a flapping GitHub check. Each agent failure is a distinct,
     expensive event that the owner wants to hear about.
   - `ok` is reported when `report` allows it. `no_change` only goes to the run
     log.
   - The message is the `RESULT` sentence, the outcome, the duration, and the
     last 800 characters of `finalText`, with the conversation id so the owner
     can open it.
9. **Clean up in `finally`:**
   - unmark the conversation;
   - dispose the awake hold;
   - delete the `.bak` on success (keep it on failure, for the owner);
   - clear `task_run`;
   - append the run row.

### How it fits the scheduler (three existing behaviours that would break)

- **The tick awaits every job** (`tick()` → `await Promise.all(workers)` →
  `runJob`, with `this.running = true` for the whole tick). A 4-hour agent turn
  would freeze every other job and tick for 4 hours. The agent task is
  therefore **started from `runJob` and not awaited by the tick**. `runJob`
  records it in `runningJobs` (the existing guard, which already stops a second
  run of the same job) and returns. The runner writes its own run row and state
  when it ends.
- **`maybeSleepIfIdle`** (D6) must treat a running agent task as busy. Checking
  `busy()` alone is not enough: a turn waiting on a 10-minute download is
  executing a tool, and the machine must not suspend under it. Check
  `runningJobs` too.
- **`on_change` and backoff double-report.** For an `agent_task` job:
  - `on_change` is **not delivered**; the agent's report replaces it. Otherwise
    the owner gets "new release b1300" and then the agent's result: two
    messages for one run.
  - `applyBackoff` keeps its delay, but **skips its own "failing:" message**,
    because the runner already reported every failure.
  - The "recovered after N failures" message stays; it is the one extra line
    worth having.

### Crash / reload recovery

If Forge dies mid-run (window reload, extension-host crash, power loss), the
turn is gone. On `JobScheduler.start()`, any job whose state still holds a
`task_run` gets these steps:

- an outbox item: `interrupted — Forge restarted during the run (started
  HH:MM); config.yaml backup kept at <path>`;
- a `failed` run row;
- `task_run` cleared.

It is **not retried automatically**. The next scheduled tick runs it. This row
is the CI-enforced one (see ledger).

### What "retire `llamacpp_update`" means (phase 5)

This happens only after two green unattended runs. Then:

- remove the action, its `actions/` files, its `allowed_hosts` download path
  and the schema variant;
- a job file still naming `llamacpp_update` must load as **invalid with a
  message naming the replacement**, not vanish. Verify what `JobStore.loadAll`
  does today with a job that fails Zod before choosing the migration;
- update `docs/OWNERS.md` and `CHANGES.md`.

## Phases

Each phase is one commit to main with `npm run ci` green. Each ends with a
Codex review over `ask_live_session`. Codex applies findings of about 20 lines
or fewer itself (MESH_RUN_1 F2). Claude signs off before the next phase starts.

| # | Scope | Files | Suggested writer |
|---|---|---|---|
| 1 | Schema: `check.none`, `action.agent_task`; the state fields `task_run` and `task_pending` (nullable, default null/false, so existing state files still parse); `manage_jobs` `task` field; `jobDescribe` renders it. No runtime behaviour yet | `jobSchema.ts`, `checks/`, `tools/jobTools.ts`, `jobDescribe.ts` | Forge (**Qwopus trial**, see the scorecard) |
| 2 | Unattended registry, plus the approval, `ask_user` and `notify_user` branches | new `sidebar/unattendedConversations.ts`, `ToolApprovalService.ts`, `tools/uxTools.ts` | **Codex**: this is the approval gate, and a subtle bug is an agent with auto-approval |
| 3 | Runner steps 1–6, 8, 9 and crash recovery; wire into the scheduler, including the three scheduler behaviours above | new `jobs/agentTask.ts`, `JobScheduler.ts` (+ `runCheck` extraction if needed), `extension.ts` wiring | Forge (Qwopus if phase 1 passes, else Qwen Flash) |
| 4 | Step 7: restart after turn, config backup and rollback | `agentTask.ts` | **Codex**: touches the live binary |
| 5 | The llama job plus `docs/LLAMACPP_UPDATE.md` (the "how", for the agent); live overnight test; then retire `llamacpp_update` | config/job file, docs, removal | Forge writes the doc; the owner runs the test |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| `jobs/<id>.json` with `agent_task` | `manage_jobs create` | `manage_jobs delete`; must also delete `state/<id>.config.bak` | `enabled:false`; a running task finishes, and no new run starts | Existing atomic write (JobStore) | n/a, on disk | none |
| `state.task_run` marker | Runner step 2, before anything else | Runner `finally` | Disable does not clear it; the run in flight still owns it | `patchState` is synchronous; worst case a stale marker → recovery reports it | **Recovery on `start()`: report + failed row + clear** (CI-enforced) | none; recovery is the expiry |
| `state.task_pending` | Step 1 when no slot is free | Next idle tick that runs it | Disable clears it | patchState | Survives; the next start's idle tick runs it | Dropped if older than one schedule period, with a run row "skipped: busy" |
| The job's conversation (`state.conversation_id`, shared with discuss) | First run or first discuss, whichever comes first | **Never deleted by Forge**: the session log feeds HalluScribe. `manage_jobs delete` leaves it in place, and the owner may archive it | Stays; the owner can still chat in it | Created before `conversation_id` is patched: worst case one orphan chat, and the next run creates another. Visible, harmless | Survives in state.vscdb and the session log | none. Growth is bounded by auto-compaction for the model and is append-only on disk |
| Unattended registry entry | Step 4 | `finally` (disposable) | n/a | In-memory | Vanishes with the process. **Correct**: a restored conversation is attended again | per run |
| `holdAwake` | Step 4 | `finally` | n/a | In-memory | OS releases it with the process | per run |
| `state/<id>.config.bak` | Step 4 | `finally` on success; kept on failure; `manage_jobs delete` | kept | Written whole before send; a partial file means step 4 failed → the run fails before the turn | Kept; recovery names its path in the report | none; the owner deletes it after reading |
| Outbox items | `JobDelivery.deliver` | `JobOutboxWatcher` after Telegram accepts | Unchanged by disable | Existing | Existing: the next lease holder drains | Existing coalescing |
| Files the agent writes (downloads, extracted builds) | The agent, under `%LOCALAPPDATA%\Forge` | **Nobody**; the doc tells the agent to delete older builds except the previous one | n/a | The agent's problem; reported via `RESULT` | Left on disk; the report says so | none. Accepted: the owner prunes |

**CI-enforced row:** `task_run` recovery. A unit test seeds a store with a
leftover `task_run`, starts the scheduler, and asserts:

- one outbox item containing `interrupted`;
- one `failed` run row;
- `task_run === null`.

Any later phase that adds a durable artifact to the run must add its cleanup to
that recovery path, or this test's sibling assertion
(`every state field written by agentTask.ts is cleared by recovery`, checked by
listing the keys `agentTask.ts` patches) fails.

## Acceptance criteria

1. A job with `check.none` + `agent_task` runs on schedule in the job's own
   conversation (created on first run, reused afterwards, never activated) and
   appends one run row. Two runs land in the same conversation; the second
   run's prompt sees the first's final message, or its compaction summary.
2. In an unattended conversation, a dangerous tool call is denied without any
   prompt appearing in the sidebar or on Telegram. A non-dangerous call runs
   without a prompt. The global clanker flag is unchanged throughout.
3. `ask_user` in an unattended conversation returns in under 1 s with the
   unattended string. Tested.
4. `notify_user` in an unattended conversation produces an outbox item.
5. A turn with no `RESULT` line, a `failed` request, and a timeout each produce
   a Telegram-bound outbox item on **that** run, not after 3.
6. `RESTART: yes` with a binary that does not start → `config.yaml` restored,
   the model restarted on the old binary, and the report names both binaries.
7. Leftover `task_run` on start → the interrupted report (CI test above).
8. With `n_parallel: 2` and one other chat streaming on the same model, the job
   starts at once. With both slots streaming, with its own chat streaming, or
   when it needs a different model while one streams, it waits. Tested with a
   status stub for each case.
9. **Live:** the owner leaves the PC asleep with a daily 03:00
   `llamacpp-latest` job (`wake: true`, the model chosen after phase 3). By morning, Telegram
   holds exactly one message: installed `bNNNN` or `failed — <reason>`. The
   run's conversation shows the full turn.
10. An `agent_task` run delivers exactly one outbox item, whatever
    `on_change` says, and a failure past the backoff threshold still delivers
    one, not two.
11. While an agent task runs, the tick keeps running other due jobs, and
    `maybeSleepIfIdle` does not suspend. Both tested with a never-resolving
    `send` stub.
12. `openDiscussChat` on a job with `task_run` set refuses and sends nothing.
13. `npm run ci` and `npm run package` green; `docs/OWNERS.md` has rows for
    `unattendedConversations.ts` and `agentTask.ts`.

## Before phase 1 starts

The live `~/.forge/jobs/llama-updates.json` (every 15 min, `llamacpp_update`
in `prepare` mode) is still enabled. It keeps firing during implementation and
will ask for approvals mid-run. Set `enabled: false` until phase 5 replaces it.

## Out of scope

- Retrying a failed task automatically. The next schedule is the retry.
- Pruning a job's chat. Compaction bounds the model's view and HalluScribe
  needs the full log; revisit only if the sidebar itself gets slow.
- Streaming the whole job turn to Telegram (the remote-origin mirror). Only
  `notify_user` and the final report go there, so an overnight run does not
  send dozens of messages.
- Multi-window: the task runs in the scheduler-lease window. The stale-config
  switch hazard in `docs/AUDIT_TOP10_RISKS_2026-09-21.md` §6 applies equally
  to step 7. It is accepted here for the single-window setup the live test
  uses, and it is fixed there, not here.
- Anything needing elevation. A UAC prompt at 3 a.m. is a hang. The doc directs
  installs to `%LOCALAPPDATA%`, and an elevation attempt counts as a failure.
