# Agent-task jobs — a job that runs an agent turn, unattended (impl plan)

Status: plan, not started. Owner of the final call: Claude. Implementer: Forge
(Qwen Flash), phase by phase; Codex reviews and fixes each phase.

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
    "max_rounds": 40,             // optional; default: that model's max_tool_rounds
    "max_minutes": 180,           // wall clock, including prefill; the slow model decides this
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

1. **Wait for idle.** If `busy()` reports a streaming turn, record
   `task_pending` and return. The next idle tick runs it, the way `summarize`
   already waits. An agent job never fights a live chat for the GPU.
2. **Persist the marker** before anything else:
   `state.task_run = { started_at, conversation_id: null }`.
3. **Model.** If `action.model` differs from the resident model and nothing is
   streaming, call `unloadModels()` first. Two llama-servers on this PC spill
   VRAM. Then create a **fresh conversation for this run** (not activated) and
   `setConversationModel`. Record its id in `task_run.conversation_id`. The
   conversation id also goes into the run row, so `/job <n> chat` can open the
   transcript later.
4. **Mark it unattended**, take `power.holdAwake`, and snapshot `config.yaml`'s
   bytes to `~/.forge/jobs/state/<id>.config.bak` (the rollback for step 7).
5. **Send the prompt**, made of:
   - the task;
   - the observation;
   - the last 3 run rows;
   - this block:
     > You are running unattended as scheduled job "<name>". Nobody will answer
     > questions or approvals. Dangerous actions will be denied. End your final
     > message with exactly one line:
     > `RESULT: ok | no_change | failed — <one sentence>`
     > If you changed llama_server.binary, add a line `RESTART: yes`. Do not
     > restart the backend yourself: you are running on it.
6. **Race the turn against `max_minutes`.** On timeout, call
   `cancel(conversationId)` and set the outcome to `timeout`. The round cap is
   the agent loop's own `max_tool_rounds`, so the per-job `max_rounds` is only a
   per-conversation override of it.
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
| 1 | Schema: `check.none`, `action.agent_task`; `manage_jobs` `task` field; `jobDescribe` renders it | `jobSchema.ts`, `checks/`, `tools/jobTools.ts`, `jobDescribe.ts` | Forge (Qwen Flash) |
| 2 | Unattended registry, plus the approval, `ask_user` and `notify_user` branches | new `sidebar/unattendedConversations.ts`, `ToolApprovalService.ts`, `tools/uxTools.ts` | **Codex**: this is the approval gate, and a subtle bug is an agent with auto-approval |
| 3 | Runner steps 1–6, 8, 9 and crash recovery; wire into the scheduler | new `jobs/agentTask.ts`, `JobScheduler.ts` (+ `runCheck` extraction if needed), `extension.ts` wiring | Forge (Qwen Flash) |
| 4 | Step 7: restart after turn, config backup and rollback | `agentTask.ts` | **Codex**: touches the live binary |
| 5 | The llama job plus `docs/LLAMACPP_UPDATE.md` (the "how", for the agent); live overnight test; then retire `llamacpp_update` | config/job file, docs, removal | Forge writes the doc; the owner runs the test |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| `jobs/<id>.json` with `agent_task` | `manage_jobs create` | `manage_jobs delete`; must also delete `state/<id>.config.bak` | `enabled:false`; a running task finishes, and no new run starts | Existing atomic write (JobStore) | n/a, on disk | none |
| `state.task_run` marker | Runner step 2, before anything else | Runner `finally` | Disable does not clear it; the run in flight still owns it | `patchState` is synchronous; worst case a stale marker → recovery reports it | **Recovery on `start()`: report + failed row + clear** (CI-enforced) | none; recovery is the expiry |
| `state.task_pending` | Step 1 when busy | Next idle tick that runs it | Disable clears it | patchState | Survives; the next start's idle tick runs it | Dropped if older than one schedule period, with a run row "skipped: busy" |
| Per-run conversation | Step 3 | **Never auto-deleted**: it is the forensic record. Archive it after the run | n/a | Created before the marker update: worst case an orphan conversation with no marker, visible in the list | Survives in state.vscdb | none; the owner archives |
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

1. A job with `check.none` + `agent_task` runs on schedule in a new,
   non-activated conversation and appends one run row.
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
8. A job never starts while a chat turn is streaming. Tested with a busy stub.
9. **Live:** the owner leaves the PC asleep with a daily 03:00
   `llamacpp-latest` job (`wake: true`, model Qwen Flash). By morning, Telegram
   holds exactly one message: installed `bNNNN` or `failed — <reason>`. The
   run's conversation shows the full turn.
10. `npm run ci` and `npm run package` green; `docs/OWNERS.md` has rows for
    `unattendedConversations.ts` and `agentTask.ts`.

## Out of scope

- Retrying a failed task automatically. The next schedule is the retry.
- Streaming the whole job turn to Telegram (the remote-origin mirror). Only
  `notify_user` and the final report go there, so an overnight run does not
  send dozens of messages.
- Multi-window: the task runs in the scheduler-lease window. The stale-config
  switch hazard in `docs/AUDIT_TOP10_RISKS_2026-09-21.md` §6 applies equally
  to step 7. It is accepted here for the single-window setup the live test
  uses, and it is fixed there, not here.
- Anything needing elevation. A UAC prompt at 3 a.m. is a hang. The doc directs
  installs to `%LOCALAPPDATA%`, and an elevation attempt counts as a failure.
