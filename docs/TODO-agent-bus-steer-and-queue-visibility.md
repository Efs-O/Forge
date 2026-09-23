# TODO — Agent bus: `/steer` support and queue visibility

Raised 2026-09-18 while Claude Code supervised HalluScribe work through the agent bus.

## 1. `/steer` over the agent bus
`/steer` exists only on the remote path (`src/remote/RemotePromptAdmission.ts`: `/steer <n>` promotes a queued
prompt, `/steer <text>` jumps to the front and interrupts). The agent bus (`src/backend/agentRoutes.ts`) has only
`POST /agent/message` (FIFO, `src/agentBus/agentInbox.ts`) and `POST /agent/reply`. A `/steer ...` sent with
`forge.sh say` is queued as plain text.

Wanted:
- A priority form on the bus, e.g. `POST /agent/message?from=<name>&priority=steer`, or recognise a leading
  `/steer` via the existing `parseSteerCommand` (it is the single owner of what `/steer` means, so reuse it and don't copy it).
- `forge.sh steer <your-name> [file]` verb + README/busContent docs.
- Decide whether a bus steer may interrupt a running turn (remote steer does) or only jump the queue.

## 2. Bus queue not visible from Telegram
`AgentInbox` keeps its own in-memory queue, separate from the remote prompt queue, so the Telegram
queue view says "no messages in queue" while bus messages wait. `forge.sh say` returns `{"queued":N}` but
nothing else shows it.

Wanted:
- The remote/Telegram queue view lists pending bus messages too (sender + first line), labelled as agent-bus items.
- `/steer <n>` numbering covers them, or the view says clearly that they're a separate queue.

## 3. Non-blocking progress from Forge to a supervising agent
Forge's only way to reach a Claude/Codex session is `ask_live_session`, which BLOCKS until an answer arrives. So a "started" or
"50% done" note costs the supervisor a reply (credits) and stalls Forge. The heartbeats that exist are internal only
(`OpenAIClient` stream-stall watchdog, `FileLease` for jobs); none is visible to a supervisor.

Wanted:
- A `tell_live_session` tool (or `ask_live_session` with `wait: false`): deliver a one-way note and return at once.
- Optionally, an automatic turn heartbeat: while a bus-started turn runs, write `~/.forge/agent-bus/status/<turn>.json`
  (`{started_at, last_activity_at, tool_calls, state}`), so a supervisor can tell "working" from "stalled" without messaging.
- Clarify the `{"queued":N}` return of `forge.sh say`: `0` currently means started at once, not queue position; say so in forge.sh/README.

Interim workaround (HalluScribe BM phases): the worker appends milestones to `docs/internal/briefs/BM-<n>.progress.md`.

## 4. Supervisor identity lost after compaction (observed 2026-09-18)
BM-1/BM-2 were dispatched with `forge.sh say claude-supervisor`. `from=` is free text, not a live session name, so Forge
could not reply to it. It picked between the two open sessions (`halluscribe-7c`, `halluscribe-2c`) by trial, and after
compaction it no longer remembered which one was right.

Wanted:
- `forge.sh say` / `POST /agent/message` should validate `from=` against the open Claude sessions (or accept a session id),
  so the reply target is exact and not guessed.
- Keep the sender identity outside the conversation (in the turn metadata), so compaction cannot drop it.
- Interim fix (HalluScribe): BM-COMMON names the supervisor explicitly and says "never guess another session".

## 5. Codex reported as "not installed" (investigate)
Qwen told the user "Codex isn't installed". It IS installed (`codex-cli 0.153.2`, npm global, on PATH). Forge's real
message is `NO_CODEX_THREAD` (`tools/liveSessionTool.ts`): `agent_bus.codex_thread` isn't set in config.yaml.

To investigate:
- The model paraphrased "not configured" as "not installed". Make the tool result harder to misread
  (e.g. start with `CODEX_NOT_CONFIGURED:` and say explicitly "the Codex CLI may be installed").
- Decide whether `codex_thread` should be auto-discovered (latest `codex` session for this workspace) or stay explicit.
- Check `spawnCliProcess` runs `codex` on Windows (npm installs `codex.cmd`; a spawn without a shell can ENOENT) once a thread is set.

## 6. Reuse existing Forge features for the Claude/Codex bus (cheap, high value)
Most of what a supervising agent needs already exists on the Telegram path. Expose it on the bus instead of
building new tools, with one owner per command (reuse `RemoteCommandHandler`, don't copy it):
- **`forge.sh cmd <slash-command>`** → `POST /agent/command`: allowlist `/status`, `/queue`, `/context`, `/stop`, `/steer`,
  `/view` (tail of the transcript), `/compact`. Plain-text reply, capped (reuse `resultCap`). One small curl per check costs a
  supervisor ~100 tokens, versus a full message round trip. Codex uses the same verb. Destructive ones (`/stop`, `/compact`) are
  logged in `RemoteAuditLog`.
  → DONE as `forge.sh status / view` (`docs/plans/AGENT_BUS_STATUS_VIEW_PLAN.md`); `/stop` and `/compact` deliberately not exposed.
- **Automatic progress from `update_plan`:** Forge's plan tool already tracks steps. Mirror the plan state and
  `RemoteAgentProgress` narration into `~/.forge/agent-bus/status/<turn>.json` (steps done/total, current step, elapsed, last
  tool call, context %). Zero model tokens, always accurate, and it replaces the manual `BM-<n>.progress.md` workaround.
- **Automatic "turn finished" notice:** when a bus-started turn ends (done, error, /stop, crash), Forge itself sends the
  sender one line (`finished · 23 min · last message: ...`). The model doesn't need to remember, so no silent stalls.
- **Stall detection:** the `OpenAIClient` stream watchdog already knows when generation stalls. Surface it in status.json
  (`state: stalled`) and in the finished notice.
- **`run_workspace_task` for gates:** workers could run one declared task (e.g. HalluScribe's `bm-check.sh`) whose output is
  already summarised, instead of four raw commands flooding the context with cargo output. This saves Qwen context and time.

Priority: `cmd /status` + the finished notice first (they remove the biggest blind spot), then status.json from `update_plan`,
then `/steer` (item 1).

## 7. `/status` shows "2 crash unknown" everywhere (reported by the user 2026-09-18, not investigated)
In Telegram, `/status` shows "2 crash unknown" for many sessions, including different chats and different workspaces.
The same count showing up everywhere suggests stale, global state that never refreshes or is never scoped per
session/workspace (e.g. a crash counter that is never reset, or crash records whose outcome is never resolved).
To investigate: where `/status` gets the crash count, whether it is keyed per session/workspace, and what clears or
resolves an "unknown" crash entry.

## 8. Codex as supervisor burns tokens while "waiting" (observed 2026-09-19)
When Claude handed supervision to Codex (VS Code extension, thread `01a0b345…`), Codex built its own "heartbeat": a
PowerShell session it polled with `write_stdin(yield_time_ms: 30000)`. **Every 30 s poll is a full model turn that re-sends the
whole context (~127K input tokens, mostly cached)**: ~850K input tokens in a few minutes, with nothing happening. The
queued `codex queue` messages (the handover ACK request) also could NOT be delivered, because the turn never ended, so Codex was
deaf while polling. The user had to stop it by hand.

Lessons / wanted:
- A supervisor must wait in ONE blocking shell call (a bash loop that sleeps and returns only when `inbox/*.pending` appears,
  capped at ~25 min), never by polling through the model. The HalluScribe handoff doc now has that loop; tell Codex explicitly
  "never poll via write_stdin/yield".
- A push beats any wait: when Forge files a question for a supervisor that isn't a Claude session, deliver it with
  `codex queue --thread <id>` (item 3's `tell_live_session` / `codex_thread` config), so the supervisor can be fully idle.
- `codex queue` delivers only between turns. A long-running poll turn blocks every incoming message, so keep supervisor turns short.
- Consider a cost guard: a wait loop that has done > N empty model turns should stop and tell the user.
