# Forge — Recent Changes

## 0.16.25

### Agent-task jobs: a successful change is reported again (2026-09-22)

- **An agent-task job now reports a successful change under the default
  `failures_and_changes` setting.** Before, `ok` was delivered only under
  `always`, so the default silently swallowed every successful run — the
  nightly llama.cpp install would have told you nothing. `always` now also
  reports `no_change` runs.
- **`docs/LLAMACPP_UPDATE.md`** is the procedure the `llama-updates` job's
  agent follows. The job itself is now an `agent_task`.

## 0.16.24

### Mesh: a reload no longer swaps in a stranger (2026-09-22)

- **A question to `claude` reaches the Claude session you joined, even after a
  reload.** The reload restarts that session under a new pid. Forge used to
  treat the join as gone and start its own Claude, which answered in your
  place without your context. The join now also matches Claude's conversation
  id. If the joined session is not open yet, the asker is told to open it.
- **Owned Codex and Claude resume their conversation after a reload.** Their
  saved id was always empty, so a reload silently started a new, empty
  thread. The id is now saved once the first turn confirms it.

## 0.16.23

### Agent-task jobs, phase 4 (2026-09-22)

- **A job that installs a new llama.cpp can restart onto it.** When the agent
  ends with `RESULT: ok` and `RESTART: yes`, the runner restarts the backend
  after the turn, capped at 5 minutes. If the new binary does not load, it
  restores `config.yaml` from the pre-turn snapshot and restarts again. The
  report names both binaries. A failed rollback is reported as needing a
  manual fix, never swallowed. With no model loaded, nothing restarts; the
  new binary is used on the next load.

### Mesh fix

- `forge.sh send <you> codex` no longer says "not delivered" for a message
  Codex received and answered. An idle recipient started before the relay
  recorded its own hop, and the exchange log refused the late write.

## 0.16.22

### Agent-task jobs, phase 3 (2026-09-22)

- **A scheduled job can now run an agent turn unattended.** The `agent_task`
  runner starts the turn in the job's own chat once a slot is free. It holds
  the machine awake for the run and snapshots `config.yaml` first. It reports
  the `RESULT:` line through the outbox, so it reaches Telegram. Nobody is
  asked anything during the run: dangerous tools are denied, and `ask_user`
  says so.
- **A run cut short by a reload or crash is reported as interrupted** when the
  scheduler next starts, and the config backup is kept.
- `notify_user` during a job run is filed under the job's name, not a
  conversation id.
- The job's discuss chat will not open while its run is in flight.

### Agent-loop and mesh fixes found during the run

- **Repeat warnings reach the model.** When a read-only call repeats with the
  same result, or the same tool fails three times in a row on one file, the
  result now starts with a warning. Before, the loop guard only killed the
  turn, with no warning first.
- `forge.sh say --model <name> --new` starts a message in a fresh chat on a
  chosen model. An unknown model name is refused and the valid names are
  listed.
- The owned Codex is reachable with `forge.sh send`/`steer` before its first
  thread starts.

## 0.16.21

### Weekly audit fixes (2026-09-21)

All eleven findings of `docs/reports/WEEKLY_IMPLEMENTATION_AUDIT_2026-09-21.md`
are fixed, each with a regression test:

- **Truncation recovery really turns thinking off** on models with
  `chat_template_thinking`. Before, the model's own `think` setting overrode it.
- **Jobs scheduler failover works.** A window that lost the first lease race
  now takes over when the owning window closes. Before, it stayed idle.
  Two overlapping ticks can no longer both run a due job.
- **Telegram contacts survive a reload.** A contact message is saved before
  "thinking…" is shown and is answered after the reload. A redelivered
  Telegram update is no longer answered twice.
- **Wake task:** it is re-registered only when the schedule changes, not on
  every lease heartbeat. A window with jobs disabled no longer deletes the
  task that another window's jobs rely on.
- **Job summaries:** paused jobs do no summary work. A failing summary backs
  off (from 1 minute up to 6 hours), is reported once, and says "recovered"
  when it succeeds.
- **Agent mesh lock:** a crash can no longer leave an empty lock that blocks
  the mesh until someone deletes it by hand. Waiting sleeps instead of
  spinning a CPU core.
- **Release workflow** publishes the VSIX built by `npm run package` to every
  registry, including its version check.
- Removed the unused `hostWait.ts`. The mesh plan no longer claims an
  empty-turn cost guard.

## 0.16.20

### Installing llama.cpp: one tool call instead of ~45 rounds

An audit of the agent session that installed llama.cpp b11077 found that the
tools, not the model, cost most of its rounds. Fixes:

- **`install_llamacpp` tool.** It downloads, checks digests, extracts,
  smoke-tests, deletes the zips and switches `llama_server.binary` in one
  approved call. It never restarts the backend, because the turn's own model
  is that backend. It uses the same pipeline as the `llamacpp_update` job,
  which now lives in `src/jobs/actions/llamacppInstall.ts`. The tool is
  advertised only when `llama_server.binary` is set. Procedure:
  `docs/LLAMACPP_INSTALL.md`.
- **The smoke test accepted no real build.** It looked for the tag in
  `--version` stdout, but real builds print `version: … (build 11077, …)` to
  stderr. It now reads both streams and accepts `build NNNN`.
- **`extra_file_roots` in config.yaml.** This lists absolute folders outside
  the workspace that `read_file`, `create_directory` and `delete_file` may
  reach. Approval still applies. Before this, the agent used `robocopy` to
  create a folder and left 550 MB of zips it had no tool to delete.
- **`query_powershell`'s outside-workspace refusal pointed to `read_file`**,
  which also refuses outside the workspace. It now points to `list_directory`,
  or to `certutil` for hashes.
- **Glob misses explain gitignore.** When `search_code` or `find_files` finds
  nothing, the message now says that globs skip gitignored files such as
  `.forge/config.yaml`, and to pass the exact path. The agent had searched its
  own config three times with no result.

## 0.16.19

### Agent mesh: fixes from the first mesh run

Findings and measurements: docs/plans/MESH_RUN_1_FINDINGS.md.

- **`forge.sh` is a real shell file now** (`src/agentBus/forge.sh`), bundled
  as text. It used to live in a TypeScript template string, where bash's
  `${1:-}` is an interpolation; that cost the local agent five failed
  type-check rounds. A test runs `bash -n` on it, and it is LF-only even when
  checked out with CRLF.
- **`forge.sh cancel <your-name> <id|all>` withdraws a queued message.**
  `forge.sh say` now prints the message id (`{"queued":n,"id":"m…"}`), and
  `POST /agent/cancel` removes the sender's own messages that Forge has not
  started. A stale note had cost the local agent a whole turn.
- **Small follow-ups go to Codex, not back to Forge.** The bus README and
  FORGE.md now say so: a one-line fix sent back to the local model took 45
  minutes. The stale "one-time consent" wording is gone from both.

## 0.16.18

### Agent mesh: `forge.sh who` (AGENT_MESH_PLAN §11)

This is the first feature built end to end by the mesh. Qwen planned and
implemented it, and Codex reviewed it.

- **`forge.sh who` shows every mesh participant.** Each row gives how this
  host reaches it (`hub`, `joined`, `owned`, `peer`) and what it is doing
  (`busy`, `idle`, `parked`, `unknown`, `dead`). A session this host cannot
  observe reports `unknown`, never `idle`. The data comes from the new
  `GET /agent/who` route.
- **`forge.sh` with no arguments shows the full usage block again.** Adding
  the `who` line had cut off the last lines of the usage text. The block now
  ends at the first line that is not a comment, instead of a fixed line range.

## 0.16.17

### Agent mesh: the run shows up on Telegram and in the session log

- **Codex's and Claude's answers are mirrored to Telegram.** Each
  `ask_live_session` result now goes out as its own message, headed
  `🔁 Forge ↔ <target> · <subject>`. A failure goes out too. Before, the
  phone showed the kickoff and nothing of the agents talking.
- **Mirroring starts even when the chat is paired mid-turn.** The
  "Forge: working…" opener used to latch on a turn that began with no paired
  chat, and it stayed silent for the rest of that turn. Only a refused send
  latches now.
- **Bus prompts are labelled by sender.** `/view` and the transcript used to
  show `You: **claude says:** …` plus the reply hint. They now show
  `claude: …`.
- **The session log is written after every tool round.** Before, it was only
  written at turn end, so an hour-long mesh turn left
  `~/.forge/sessions/<id>.jsonl` empty until it finished. An assistant row
  that is still streaming is held back until it settles.
- **No consent dialog before Forge starts its own Claude/Codex session.** The
  first `ask_live_session` just creates it.

## 0.16.16

### Agent mesh: Claude and Codex can steer Forge mid-turn (AGENT_MESH_PLAN §6)

- **`forge.sh steer <your-name> <to> [file]`.** Interrupts `<to>`'s running
  turn and runs the text next. `<to>` is `forge`, `claude` or `codex`.
- **A steer to Forge now interrupts Qwen.** Before, a bus steer reached only
  owned Claude/Codex sessions. A message to Forge waited behind the running
  turn, however wrong that turn was. Now it jumps the inbox queue, and Forge's
  active turn is interrupted exactly like a Telegram `/steer`.

## 0.16.15

### Agent mesh: zero-config participation (AGENT_MESH_PLAN §11)

Talking to Claude and Codex no longer needs renamed sessions, config pins or a
Codex window left open.

- **`forge.sh join claude`.** An open Claude Code session registers itself as
  the `claude` alias by its pid (`POST /agent/join`). If no session has joined,
  Forge uses the only Claude session open in the workspace, and otherwise
  starts its own (one-time consent). A stale `claude_session` pin is now
  skipped rather than refused.
- **Codex defaults to a Forge-owned session.** Previously the default was the
  `codex queue` pin, which reaches only a thread that is open in a terminal. A
  closed pinned thread made Qwen → Codex hang until the wait limit.
- **Every `ask_live_session` to an owned session goes through the alias
  queue.** Before, a direct send could collide with a queued message. A queued
  ask that is aborted is withdrawn. An idle queue follows the session when it
  changes.
- **`forge.sh send <me> <to>`** relays a message from one agent to another
  through Forge without a Forge model turn.
- An agent-bus message from `claude`/`codex` now tells the model to answer with
  `target:`. The old `session: "claude"` hint could not resolve.

## 0.16.14

### Fix: CLI delivery (codex queue, claude) breaks on spaced profile paths

- **`cmd /s /c` stripped the quotes off spaced executable paths.** Forge wraps
  npm `.cmd` shims in `cmd.exe /d /s /c <line>`; the `/s` switch strips the
  first and last quote of the whole line. When the shim path contains a space
  (`C:\Users\efso office\AppData\Roaming\npm\codex.cmd`), those outer quotes
  were the executable's own — so cmd ran `C:\Users\efso` as a command and
  `ask_live_session` / delegation to Codex failed with
  `'C:\Users\efso' is not recognized`. The command line is now wrapped in an
  outer quote pair (the documented `/s /c` contract), so the executable's
  quotes survive. Same fix covers every CLI spawn that goes through the shim
  (`claude`, `codex`, `npm` shims).
- **Jobs template: full GitHub asset host chain.** `config.example.yaml`
  `jobs.allowed_hosts` now lists `github.com` and
  `release-assets.githubusercontent.com` alongside the API and
  `objects.githubusercontent.com` hosts — a `llamacpp_update` download
  redirects through all of them and the gate checks every hop.

## 0.16.13

### Jobs: fix llamacpp_update asset picking + opt-in default

- **`llamacpp_update` now picks the right assets from current llama.cpp
  releases.** Upstream renamed the cudart zip (no longer carries the build
  tag, e.g. `cudart-llama-bin-win-cuda-13.4-x64.zip`) and the first
  `llama-<tag>-` asset in upload order is the `cpu-arm64` build — both broke
  the picker. Selection is now steered by the job's `asset_pattern`, the
  highest CUDA version wins, and the cudart zip is matched by
  `cudart-llama-` prefix.
- **Job scheduler is opt-in in the shipped template.**
  `config.example.yaml` now ships `jobs: enabled: false` — a fresh install
  does not start the scheduler until you turn it on.

## 0.16.12

### Agent mesh, phases 1–5 + full review remediation

The user-visible surface of the Forge ↔ Claude ↔ Codex mesh (plan:
`docs/plans/AGENT_MESH_PLAN.md`), on top of the 0.16.10 foundation, hardened
by a two-pass Codex review (14 findings, all remediated and re-reviewed).

- **`ask_live_session` / `tell_live_session` now work for both agents.** A
  Forge-owned persistent session is created on first use (one-time, user-visible
  consent — never a silent privileged spawn), is resumable across restarts
  (thread/session id kept), and is reaped only when its owner window is proven
  dead. A second window joins the live session instead of opening a second pipe.
- **Steering and standby.** A `priority=steer` message (or `/steer` from the
  phone) interrupts the recipient's active turn and runs next; `standby` parks a
  session warm (exempt from the idle TTL) and any send wakes it.
- **Truthful, durable delivery states.** Board events are on disk before a send
  is reported accepted; terminal states are final (a late verdict after a
  timeout can never flip it back to success); a non-observing session completes
  via an exchange-correlated verdict file, not a transport exit code.
- **Crash recovery.** A dead owner's session is reaped with a `crashed` board
  event, its queued exchanges terminalized as `timeout`, and its stale turn
  status file swept (only files whose owner is proven dead are cleared).
- **Telegram:** `/status` shows the scoped board + live sessions; `/queue` shows
  per-alias mesh FIFO depth; `/steer`, `/standby`, `/wake`, `/close` dispatch.
- **Multi-window safety:** ownership mutations (park/wake/close) are
  owner-authorized; the alias registry read-modify-write and the exchanges log
  share one interprocess lock; Codex config pins are used only when the thread
  is actually live.

## 0.16.11

### Quieter remote compaction notices + higher tool-round ceiling

- **Aggregated remote compaction messages.** A long unattended run auto-compacts
  several times; each one used to send a "compacting…" *and* a "compaction
  complete." pair to the phone — five compactions, ten messages. The started
  message is gone, and completed auto-compactions are now buffered per
  transport+conversation and flushed as ONE line ("Forge: 5 compactions
  complete."). The flush fires on a 3 s quiet timer or eagerly before the next
  conversation-scoped notification, so the summary always lands ahead of the
  answer it would otherwise overtake. A failed compaction is still reported
  immediately, after any pending successes. Manual `/compact` from the phone is
  unchanged (it has its own progress message).
- **Tool-round ceiling raised 500 → 1000.** `max_tool_rounds` in config could
  never exceed 500 (the clamp sat at the same value as the default), so a
  configured 1000 was silently ignored and long autonomous turns died at the
  wall. Both `MAX_TOOL_ROUNDS` and `MAX_CONFIGURABLE_TOOL_ROUNDS` are now 1000;
  the runaway guard is preserved.

## 0.16.10

### Agent mesh, phase 0 — identity, ownership, and truthful delivery states

The foundation for Forge ↔ Claude ↔ Codex communication visible to the user
(plan: `docs/plans/AGENT_MESH_PLAN.md`). This phase lays the durable, multi-window-safe
substrate the later phases build on; it ships no new user-facing surface yet.

- **`tell_live_session`** — a new tool that sends a **one-way** note ("started",
  "blocked", "turn finished") to a live Claude or Codex session and returns at
  once. It is a distinct typed primitive, not `ask_live_session` with `wait: false`:
  a notification has no expected answer and never blocks.
- **Truthful delivery states.** A message now moves `created → accepted → started
  → completed` (or `rejected` / `timeout` / `cancelled`), and a transport exit code
  can advance it **only** to `accepted`. A Forge-owned session reports `started` and
  `completed` directly; a user-opened session honestly stays `accepted` until a
  verdict appears. The old single "delivered" that pretended `codex queue` exit 0
  meant "processed" is gone.
- **Stable identity + ownership.** Each agent has a stable alias (`codex`, `claude`)
  in `~/.forge/agent-bus/aliases.json`; the config `codex_thread` / `claude_session`
  values become deprecated pins (an alias wins). Forge-owned sessions are recorded
  per alias in `ownership/<alias>.json` with the host that holds the pipe, and a
  creation lease prevents two windows double-spawning one session.
- **Multi-window safe.** Every VS Code window is its own host sharing the bus
  folder, so the exchange log (`exchanges.jsonl`) takes one interprocess lock, and
  a session is reaped on restart **only** when its owning host is proven dead — a
  peer window's live session is never touched. A dead owner's thread id is kept so
  the next message resumes it (warm survives a restart through the thread).
- **The exchange board's durable store.** An append-only event log with whole-terminal-exchange
  compaction (non-terminal exchanges are never dropped; a stalled one gets a `timeout`
  after a deadline). The board render lands in a later phase.

## 0.16.9

- **`ask_live_session` (Codex) works on Windows.** Resolving the `codex` CLI
  now prefers the `.cmd` shim over the extensionless npm shell script, which
  Node could not spawn (`ENOENT`). The live-session door to an open Codex
  session is usable again; the Claude peer-pipe door is unchanged.
- Local build for the agent-mesh work (plan + investigation in
  `docs/plans/AGENT_MESH_PLAN.md` and `docs/AGENT_COMMUNICATION_INVESTIGATION.md`).

## 0.16.7

- **`embeddings.device`** chooses where the embedding server runs (passed to
  llama.cpp as `--device`): `none` keeps it on the CPU, where a 300M embedder is
  fast and costs no VRAM; `CUDA2` pins it to one GPU. Without it the embedder
  still spreads over every visible GPU.
- **`config/config.example.yaml` is now a complete working config** (the
  author's own, with paths replaced by `xxxx/` placeholders): Gemma 4, Qwen3.8
  with MTP and DFlash 2 drafters, Flash-Next, Ollama, OpenRouter, xAI, Cerebras
  and CLI agents. Remote control, voice, embeddings and the wake relay are
  switched off until you fill in their paths. A warning above `permissions:`
  says plainly that the example turns every permission on.
- **CI now gates the tool-schema size** (`ToolSchemaBudget.test.ts`): the
  character count of the fully advertised `tools` array has a budget, so adding
  a tool forces a decision when it is added.

## 0.16.6

### Agent messaging: Forge, Claude Code and Codex talk directly

- **No more listener.** `ask_live_session` now writes a question straight into
  the running Claude Code session's own message pipe, where it appears in that
  session's chat at once. There is nothing to arm or re-arm: the watcher,
  heartbeat, arm prompt, "Copy Claude Bus Prompt" command and SessionStart hook
  are gone, and their leftover files are deleted.
- **Claude and Codex can message Forge first.** `~/.forge/agent-bus/forge.sh
  say <name>` (or `POST /agent/message` with the token from `endpoint.json`)
  shows up as **<name> says:** in the active chat, straight away when idle or
  when the running turn ends. Answers to Forge's questions go through
  `forge.sh reply <id>` (`POST /agent/reply`), falling back to the outbox file.
  Both routes need `control_server` and `agent_bus` enabled, and a bearer token
  that changes on every start.
- **Choosing a session never guesses.** With several Claude sessions open, the
  tool lists them and asks. Pin one with `agent_bus.claude_session`, or see
  them with **Forge: Show Live Claude Sessions**.
- **`agent_bus.claude_transport: relay`** sends through a one-shot
  `claude -p` instead (about $0.10 a message), for a Claude Code version whose
  pipe Forge does not speak.
- A Claude session running with bypass permissions holds Forge's messages for
  approval unless `~/.claude/settings.json` has
  `"crossSessionInbound": "accept"`. Forge never sets it.

### `/unload` frees only this chat's model; `/unloadall` frees everything

- **`/unload` no longer stops every model.** In the sidebar, the command
  palette (**Forge: Unload Active Chat's Model**) and Telegram, it now releases
  only the model the current chat uses; other loaded models keep running.
  Another chat on the same model loses it too, since they share one server.
  It refuses while a turn is running on that model.
- **`/unloadall`** (sidebar, Telegram) and **Forge: Unload All Models** keep the
  old stop-everything behaviour.

## 0.16.5

### Persistent agent jobs — delete-during-in-flight fix

- A job deleted **while its check is in flight** can no longer stage a
  `llamacpp_update` build, and a staged build whose job no longer exists is
  dropped before the idle tick — so a deleted job can never switch
  `llama_server.binary`. (Closes the gap the audit's F1 left open from the
  other direction; caught by the post-fix Codex review.)

## 0.16.4

### `ask_live_session` — ask the Claude Code session that is already running

- **A new tool, `ask_live_session`** (opt-in: `agent_bus: { enabled: true }`).
  The agent can now ask a Claude Code session that is already running and
  already knows the work, instead of `ask_local_agent`, which always starts a
  new, empty session. The exchange shows in the chat as **Asked Claude** /
  **Claude says**.
- **Knows when nobody is listening.** The listening session's watcher updates
  a heartbeat file; with no listener, the tool answers at once, without
  sending, and shows the prompt that starts one. A heartbeat 30 s–3 min old
  counts as "re-arming", and the wait is capped at 3 minutes.
- **Late answers are never lost.** An answer that arrives after the wait ends
  is shown once at the start of the next call.
- **Ships its own protocol.** Forge writes `~/.forge/agent-bus/README.md` and
  `watch.sh`, and the new command **Forge: Copy Claude Bus Prompt** copies a
  self-contained prompt that turns any open Claude Code session into a
  listener. No memory or instruction file is needed on either side.
- **Codex too.** With `target: "codex"`, the question goes into an open Codex
  session through `codex queue` and shows there as a normal message; the chat
  shows **Asked Codex** / **Codex says**. Set `agent_bus.codex_thread` to the
  thread id, and open the session in a terminal with
  `codex resume <thread> --sandbox workspace-write --add-dir <bus folder>`.
  Codex has no heartbeat, so a closed window shows up only as "no answer".
- Questions and answers are written through a `.tmp` file and a rename, ids
  cannot collide, finished exchanges leave no files behind, and anything
  older than 24 h is swept.

## 0.16.3

### Persistent agent jobs — audit fixes

- **Deleting a job now removes its staged build and pending outbox message**,
  so a deleted job can no longer switch the llama.cpp backend or deliver a
  stale notification.
- **The scheduler survives losing its lease** (window closed / another window
  took over) instead of disposing itself permanently.
- **The `llamacpp_update` action is leak- and retry-safe**: a failed stage
  removes only the build dir it created (a pre-existing build is never
  touched) and deletes the downloaded zips on both success and failure; the
  rollback target is the binary in `config.yaml` at switch time, and a failed
  restore restart is reported rather than swallowed.
- **Jobs network access is tighter**: the host gate is re-checked at every
  redirect hop and downloads are size-capped.
- **Failure reporting is quieter**: a job's failure is reported once at the
  backoff threshold, with a "recovered" note after a later success.
- **`docs/JOBS.md`**: a user guide and the manual test procedure for the
  whole feature, including the end-to-end `llamacpp_update` run.

## 0.16.2

### Persistent agent jobs (Phase B1)

- **A `jobs:` block and a background job scheduler** (opt-in; absent means no
  scheduler, no lease, no tool). Jobs are defined by hand as JSON under
  `~/.forge/jobs/` (one `<id>.json` definition, a separate `state/<id>.json`,
  and an append-only `runs/<id>.jsonl` log). The scheduler runs in whichever
  window wins a `jobs-scheduler` file lease, ticks every 30 s, and runs at most
  `max_concurrent` jobs at once.
- **Three checks**: `github_release` (new release / asset), `github_issue`
  (state, comment count, last comment), and `disk_space` (free-space threshold
  crossing). The first run only records a baseline and never reports "changed";
  a `github` fetch is gated to `jobs.allowed_hosts` and uses ETag `If-None-Match`
  so an unchanged check costs nothing against the API rate limit.
- **Delivery**: a change is toasted locally and written to a coalescing outbox
  file (one per job; a second change supersedes the text and bumps a count; an
  item older than 24 h is delivered as a count, not a flood). The window holding
  the Telegram lease drains the outbox to the owner chat, deleting a file only
  after delivery is accepted and keeping it pending when there is no owner yet.
- **Wakes and lifecycle**: `wake: true` daily/weekly jobs register a recurring
  `ForgeScheduledWake` task (shifted earlier by the wake lead time, including
  across midnight); disabling a job deletes its wake. A tick more than 90 s late
  counts as a resume and runs overdue jobs once, marked `late`. Backoff pushes a
  job out after 3 consecutive failures. `summarize` runs a no-tools model call
  only when no turn is streaming.

### Persistent agent jobs (Phase B2) — the `manage_jobs` tool

- **`manage_jobs`** (`src/tools/jobTools.ts`): one agent tool with an `action`
  enum (`list`, `get`, `create`, `update`, `pause`, `resume`, `delete`,
  `run_now`, `discuss`) instead of five tools — one round per call. Advertised
  in every conversation when `jobs.enabled`. `update` takes a partial
  `definition` (e.g. only `schedule`), so "check at 08:00 instead" is one call.
  `delete` always asks for approval, even under /clanker.
- **Permissions**: `read` for `list`/`get`, `write` for the mutating actions,
  `delete` for `delete` — derived from the validated `action` arg, never used
  for advertisement.
- **`run_now`** writes a `run_requests/<id>` marker the scheduler consumes on
  its next tick, so a request issued from a window that does not hold the jobs
  lease still runs the job in the lease holder. The marker is idempotent and is
  deleted as it is consumed, so a crash mid-run cannot re-fire it.
- **`discuss`** opens (or reuses) the job's discuss chat and seeds it with the
  job definition, the last 10 run rows, and the last observation (B.6).

### Persistent agent jobs (Phase B3) — Telegram `/jobs` and `/job`

- **`/jobs`** (`src/remote/RemoteJobCommands.ts`): lists the jobs, numbered,
  with each one's schedule, status, last run and outcome, and next due. Inert
  when `jobs.enabled` is false.
- **`/job <n|name> pause|resume|run|delete`**: acts on one job, resolved by
  list number, exact id, exact name, or unique substring (an ambiguous match
  returns the candidates). `run` writes a `run_requests/<id>` marker the
  scheduler consumes, so a run requested from the Telegram window still runs in
  whichever window holds the jobs lease. `delete` asks for
  `/job <n> delete confirm` first (90s window), like `/sleep`.
- **`/job <n> approve`** answers with a clear "not available yet" — it approves
  a `llamacpp_update` and is implemented in phase B5.
- Both commands are added to `TELEGRAM_BOT_COMMANDS`, the `/help` text (new
  `Jobs` section), and the command drift guard's `SOURCES` list. The shared
  `JobStore` is threaded from `extension.ts` through `RemoteRuntime` to the
  controller, so the phone edits the same files the scheduler and `manage_jobs`
  use.

### Persistent agent jobs (Phase B4) — the job discuss chat from the phone

- **`/job <n|name> chat`**: opens (or reuses) the job's discuss chat and seeds
  it with the job definition, the last 10 run rows, and the last observation
  (B.6). Not activated — a chat opened from the phone does not steal the
  foreground from whatever is in the window. The conversation id is persisted
  in `state.conversation_id`, so the next entry point reuses the same chat.
- **Shared seeding path**: the discuss logic is extracted from `jobTools.ts`
  into `src/jobs/jobDiscuss.ts` (`openDiscussChat` + `buildDiscussSeed`), now
  used by both `manage_jobs {action:"discuss"}` (B2) and `/job <n> chat`
  (B4), so the seed and the conversation-id persistence cannot diverge between
  the two surfaces.
- The `manage_jobs` `discuss` action now activates the chat (the user is
  present in the window); the Telegram entry point does not.

### Persistent agent jobs (Phase B5) — the `llamacpp_update` action

The only mutating job action, and the last phase of the jobs feature. A
`github_release` job with `action: { kind: "llamacpp_update", mode: "prepare" | "apply" }`
now installs a new llama.cpp build when a new release is detected, through
fixed TypeScript stages (the model never authors a step):

- **Download** the tag's `llama-b<tag>` + `cudart-llama-b<tag>` zips to
  `%LOCALAPPDATA%\Forge\staging\` (the asset pattern comes from the job, never
  a hardcoded default). The download is gated by `jobs.allowed_hosts` and
  follows redirects manually so the gate is re-checked at every hop (GitHub
  asset URLs 302 to a CDN).
- **Verify** each asset's SHA-256 against the release API `digest`. A missing
  digest or a mismatch stops before anything is written; a release missing the
  cudart zip is refused as a partial build.
- **Extract** both zips into `llama.cpp-<tag>\`; an existing folder stops the
  run. Old build folders are never deleted.
- **Smoke test**: `--version` reports the tag, `--list-devices` runs, and (when
  embeddings are configured) one embedding round-trip on a free port succeeds.
- **`prepare`** stops here and asks for approval (24 h expiry); **`apply`**
  skips the gate and requests the switch immediately (the no-gate decision,
  2026-09-14). Both modes run every safety stage.
- **Switch** writes only `llama_server.binary` (comments and per-group pins
  preserved), restarts the backend only when no turn is streaming, then
  **post-checks** the backend; on failure it restores the previous binary,
  restarts, and reports.

`/job <n> approve` now performs the real approval for a `prepare` staged build
(it sets `switch_pending`; the scheduler switches on its next idle tick).
`github_release` checks gain a `channel` field (`latest` default, or
`prerelease` for the llama.cpp nightly `bNNNN` builds, which `/releases/latest`
never returns). The action's orchestration lives in `src/jobs/actions/` so the
scheduler stays under its line limit.

## 0.16.1

### Project instructions

- **`FORGE.md` budget raised from 15,000 to 25,000 bytes**
  (`MAX_INSTRUCTION_BYTES`). A 20 KB `FORGE.md` was being cut off, so its
  last ~5 KB never reached the local agent. The budget still counts the whole
  rendered chain (FORGE.md + AGENTS.md fallbacks, delimiters included), and
  every byte of it is sent on every native turn.

### Tools

- **`image_search`: reverse image search with Google Lens, free.** Attach an
  image in the sidebar or on Telegram and ask where it comes from; the agent
  picks the newest attached image (or `attachment_index`, or a public
  `image_url`), uploads a local one to Litterbox for one hour, and queries
  SerpApi's Google Lens engine (free plan: 250 searches/month). `type` is
  `all` (what it shows + pages + similar images), `exact_matches` (find the
  original), `visual_matches` or `products`. The ~400 KB response is trimmed
  to at most 2,000 characters — title, site, link, date, size, price; never
  thumbnails. Off until config.yaml has an `image_search` block (and
  `net.search` is granted); key via "Forge: Set Cloud Provider Token".
  `confirm_upload: true` asks before an attachment leaves the machine (default
  off). Bytes are checked to be a real image before upload — Litterbox itself
  accepts anything. Timeout defaults to 90 s: `type: all` measured 52 s.
- **`image_search` shows the matches as pictures.** The top
  `image_search.thumbnails` (default 4, `0` = off) match thumbnails are saved
  under `.forge/image-search/<search>/`, shown as a clickable row of
  thumbnails under the tool call in the sidebar (they survive a reload — the
  paths live in the result text, like `generate_image`), and sent as photos
  with title and link to the Telegram chat watching the turn. Thumbnails are
  fetched only from SerpApi's and Google's thumbnail hosts, never from the
  matched sites; search folders older than 7 days are pruned.
- **`image_search` can use Yandex** (`engine: yandex`; `google_lens` stays the
  default). Same SerpApi key, quota and Litterbox upload. Measured on the same
  photo: 4.3 s against Lens's 18–52 s, and it lists the **largest copies** of
  the image (2900×5367 here) — the best lead to an original — plus pages and
  visually similar images; its page matches are noisier (mostly Pinterest).
- **Clicking a search thumbnail enlarges it, with an "Open original ↗" link.**
  No provider serves a thumbnail larger than ~170×320, and the first build
  picked Lens's 92×92 web-page thumbnails, so the lightbox showed them at the
  size they already had. Match thumbnails are now preferred, the preview is
  scaled up to fill the view, and the link opens the full-size image in your
  browser — Forge still never downloads from the matched site.

### Agent loop

- **A turn that ends mid-thought is retried instead of silently stopping.**
  Qwen3.8 would sometimes emit EOS right after llama-server injected
  `--reasoning-budget-message`, still inside the thinking block:
  `finish_reason=stop text_chars=0 tool_deltas=0`. The old guard only caught
  `finish_reason: length`, so the loop took the empty round as a finished
  answer and the turn just ended — 13 times across three days of session logs.
  The guard now keys on the shape (reasoning, but no answer and no tool call),
  not on the finish reason. Such a round is retried **once, with thinking off**;
  the partial reasoning stays in context and an `internal` nudge (sent to the
  model, logged, never rendered) asks for the next action directly. If the retry
  also produces nothing, the turn is marked incomplete and the chat says so —
  as a **warning**, so a Telegram chat gets a new message (a phone push) rather
  than a silent edit of the progress bubble, and you know to send "continue".

### Remote

- **Forge's reply to a Telegram /command is auto-deleted too**, after
  `remote.delete_command_replies_after` seconds (default **10**, `0` disables,
  max 3600) — alongside the existing 5 s cleanup of the command itself.
  Approval prompts, progress bubbles and paginated lists are never deleted (a
  deleted button message strands its action), and `/view` replies are kept
  because they are earlier answers, not acknowledgements. `RemoteChannel.send`
  now resolves to the sent message ids so the reply can be addressed.

## 0.16.0

### Semantic search

- **`search_codebase` can index any workspace without HTTP 500s.** Indexing
  died with `input (N tokens) is too large to process` whenever the embedding
  server's physical batch (`--ubatch-size`, pinned to `embeddings.n_ctx`,
  default 2048) was exceeded — by too many chunks in one request, by one large
  symbol, or by a single over-long line such as a minified-JSON fixture. No
  chars-per-token estimate can prevent this: SentencePiece byte fallback makes
  minified JS, base64 and CJK tokenize far denser than ordinary source. Chunks
  are now **measured** with the server's own tokenizer (llama-server
  `/tokenize`, same vocab as the embedding path), including the embedding
  prompt prefix. Oversized symbols split into line sub-chunks that keep the
  symbol name; single long lines split by characters. A byte upper bound skips
  the tokenize call for small chunks, and a bounded cache shares counts between
  chunking and request packing. Request batches are packed on exact counts, and
  if the server still rejects a multi-chunk request it is split and retried
  instead of aborting the build. **One-time index rebuild** on first use
  (`INDEX_VERSION` 5).

### Tools

- **New `generate_image` tool: any tool-using model can make images through a
  cloud image API.** Configure backends under a new `image_generation:` block
  (`xai`, `openai`, `openai-compatible`; OpenAI-style
  `/v1/images/generations`). Keys resolve exactly as for a chat model on the
  same provider, so `grok-imagine-image-2.0` works on the OpenCode OAuth login
  with no new setup. The image is saved into the workspace under a checkpoint
  (Undo removes it), opened beside the chat, shown as a clickable thumbnail
  under its tool row (it survives a window reload), and sent as a photo to the
  Telegram chat watching the turn, in order with the narration (falls back to
  a document when Telegram rejects the photo). Every call asks for approval;
  `confirm_each: true` (the default) keeps asking even under /clanker, since
  each image is billed. The image is not pushed into the model's context — it
  is told the workspace-relative path and can call `view_image`. No block, no
  tool: the tool list and KV prefix are unchanged for configs without it. Local
  ComfyUI backends are planned in `docs/plans/IMAGE_GENERATION_TOOL_PLAN.md`,
  not built.

- **`ask_user` can ask two decisions in one round.** It carried one prompt and
  one flat options list, so two related choices had to be crossed into their
  combinations. It now takes `questions: [{prompt, options}]`: each
  sub-question gets its own list, the sidebar holds the answer until every one
  has a pick, and the answer comes back labelled a line per sub-question.
  Remotely the reply is one number per question in order — "1 2" — using the
  same numbering the sidebar buttons carry, and remote users are told they may
  answer in prose instead.

- **`Other…` in an agent question is no longer a one-way door.** The numbered
  options now stay on screen and the free-text box opens beneath them, so a
  mis-click can be undone.

- **`delete_file` knows about git.** Given `CHANGES.md` and its gitignored,
  generated twin `CHANGELOG.md`, an agent found them byte-identical and deleted
  the tracked source of truth. `delete_file` now says in its result when the
  path was tracked at HEAD, with how to undo it, and the confirmation dialog
  gains a `Git:` line.

- **New `restore_file` tool.** `git checkout <ref> -- <path>` stays denylisted
  because it silently overwrites uncommitted work, but its refusal named no
  alternative that could put a file back. `restore_file({"paths": [...],
  "ref": "HEAD~1"})` restores from any ref, including files a commit deleted.
  It is confirmation-gated and checkpointed, and the denylist refusal names it.

- **`commit` can amend.** `amend: true` rewrites the previous commit, allows an
  empty index (a message-only amend), and refuses once the commit has reached a
  remote.

- **`stage` names the kind of change it staged** — `CHANGES.md (deleted)`
  instead of a bare path that read as an edit.

- **`exec_command` accepts validated environment variables.** Foreground and
  background execution share one bounded policy; process spawning stays
  shell-free.

### Remote (Telegram)

- **The live bubble no longer shows the model's streamed words.** Every
  mid-turn thought and the final answer used to appear twice: streamed into the
  "working…" bubble, then again as their own message, after which the bubble
  copy vanished. The bubble now carries status only (headline, warnings, the
  running tool) and each piece of text appears once, as a message — which is
  also what pings the phone, since Telegram does not notify on edits.
  **Trial change:** if the live text is missed, revert the commit "keep
  streamed words out of the Telegram progress bubble".

- **Slash commands clean themselves up.** After a `/command` is processed, its
  original message is deleted after `remote.delete_command_messages_after`
  seconds (default 5; `0` disables). Only terminal command results are cleaned
  up — prompts, `/steer`, voice, selections and approvals are untouched — and a
  failed delete never affects the command.

- **Photo albums arrive as one prompt,** capped at three images with an in-chat
  overflow notice. Albums split across polling responses are kept together, and
  their cursor is committed only after the event is handled; a failed cursor
  write is reported instead of taking the poll loop down.

- **One `/model` command.** Bare `/model` lists models and
  `/model <number-or-name>` pins one to the chat. A number now resolves in a
  fresh chat without running a listing first. `/models` remains a hidden alias
  (the only way to page the list on keyboard-less transports); on Telegram the
  redundant page-fallback footer is gone. `/help` sections are sorted
  alphabetically.

- **`/chats` says which workspace it is in** (`You are in: <name>`).

- **Narration is neither repeated nor over-suppressed.** A thought repeated in
  two non-adjacent rounds is sent once, and a round that mixes real work with
  an `ask_user` question narrates the work instead of being silenced.

### Sidebar

- **Image attachments open in an in-place lightbox.**
- **Switching conversations settles at the actual bottom** of a long
  transcript instead of mid-conversation.
- More shared streaming status phrases.

### CLI agents

- **Forge-spawned Claude sessions show up in the Claude extension's history.**

## 0.15.34

- **Telegram messages could arrive out of order.** Several producers write to
  the same chat - the durable outbox loop with its own 1s-to-60s retry backoff,
  the live progress channel's narration and warning sends, command replies,
  approval prompts, `/view`, selection pages - and each was ordered only within
  itself. Two sends in flight at once are ordered by whichever reaches
  Telegram's server first, so an older message could land after a newer one.
  Shipping mid-turn narration in 0.15.33 raised the volume from roughly one
  message per turn to one per round and made the race routine. Every
  chat-addressed Bot API call now runs in a per-chat FIFO lane; calls that name
  no chat, `getUpdates` above all, stay unqueued so inbound polling is never
  held behind an outbound send.

- **A rate-limited send is no longer lost or re-ordered.** Any non-2xx used to
  throw, so a 429 left the outbox to retry on its own escalating schedule -
  landing the message late and out of order - while a narration or warning was
  logged and dropped. Forge now waits the `retry_after` interval Telegram names
  and retries in place, bounded, keeping the message in its lane.

## 0.15.33

- **A long remote turn now speaks in messages, not edits.** Everything the
  agent said during a turn was written into the single "working..." bubble
  Telegram opens when the turn starts, and Telegram raises no notification for
  an edited message. A three-hour agentic turn therefore left the phone silent
  until it finished, with every thought stacked in the first bubble. Each round
  that narrates before calling tools now delivers that paragraph as its own
  message; the live bubble drops back to the headline and the running tool,
  which is the part that is genuinely volatile. Repeated narrations are not
  sent twice.

- **Warnings now reach the phone instead of only the bubble.** "agent is
  repeating the same tool call - stopping to avoid a loop" was latched into the
  edited progress message, where Telegram never announced it, so a turn that had
  already given up looked like a turn still working. Warnings are now sent as
  their own message as well as latched; an `info` notice stays an edit, because
  it is a milestone rather than news. `docs/plans/REMOTE_FAILURE_VISIBILITY_PLAN.md`
  records what a remote user is still not told - stall detection, per-tool
  failures, and a pushed liveness heartbeat - and what is already covered.

- **`/chat` accepts a conversation's name, not only its number.** `/chats`
  lists conversations by title, so typing `/chat D` is the obvious next move —
  but only a number or a full id resolved, and a title was passed through as if
  it were an id, so it failed with "conversation could not be restored." Titles
  now match case-insensitively against the same newest-first list `/chats`
  numbers, spaces included, and a genuine miss says to run `/chats` instead of
  implying the conversation is gone. The doubled `Forge: Forge:` prefix on that
  rejection is fixed too: host errors already carry the prefix.

- **`/new` says what it does.** Bare `/new` starts a chat here and `/new <n>`
  starts one in another workspace; nothing about the name said it never joins an
  existing chat. The command menu, `/help`, and the "workspace not found"
  rejection now all point at `/chat` for that.

- **`/workspace 27` now goes to workspace 27.** It read that number as a
  *page*, so the one command carried two number spaces and answered
  `/workspace 27` with "takes a page number (1-3)" — for the workspace the user
  had just read off that very list. The number after `/workspace` is a
  workspace now; the inline next/prev keyboard is the only pager, which is the
  only paging anyone was using. `/new <n>` stays as a silent alias, but `/new`
  is documented as one thing again: start a chat here.

- **Arriving in a workspace continues its most recent conversation.** The
  handoff bound a brand-new chat whatever was already there, so `/workspace 27`
  — "go to 27 and carry on" — landed in an empty chat, and the work you
  switched in order to continue was a `/chats` and a `/chat 1` further away than
  before you left. Only a workspace with no history at all gets a fresh chat.
  The arrival receipt names the conversation it landed in, so a resumed chat is
  no longer indistinguishable from a blank one without running `/view`.

## 0.15.32

- **Questions with choices now include an `Other…` route.** Selecting it opens
  and focuses a free-text answer field while preserving the immediate-submit
  numbered choices. The question modal also has more space for long context
  without changing the shared confirmation dialog.

- **Models are guided to ask one related decision group at a time.** Option
  labels are kept short and mutually exclusive; unrelated follow-ups belong in
  a later question after the first response.

- **Direct llama-server models may configure a startup health-check timeout.**
  `startup_timeout_ms` is validated per model and overrides the default
  two-minute startup window when a large model needs more time to load.

## 0.15.31

- **A turn could be arithmetically guaranteed to fail before its first token,
  and Forge spent 13.5 minutes proving it.** The model-facing excerptor trims
  the prompt until exactly `MIN_ROUND_HEADROOM_TOKENS` (4,000) of output room
  remains, then `applyOutputCap` takes its 512-token margin — so a large
  conversation converges on `max_tokens: 3488`. Against `--reasoning-budget
  4096` that is unwinnable: thinking and the answer share one budget, so the
  model burns the whole ceiling inside the thinking block, never reaches the
  budget that would have injected `--reasoning-budget-message`, and returns
  `finish_reason: length` with no content and no tool call. Every later round in
  that conversation got the identical 3,488, so the failure was permanent rather
  than intermittent. The reserve now covers the reasoning budget *plus* an
  answer allowance (`minimumOutputReserve`), and a round whose output room
  cannot outlast the reasoning budget is refused up front instead of being sent
  and discovered.

- **That cut-off round was then flushed as a completed answer.** With no tool
  calls and no content, `ToolCallingLoop` took the "model is done" branch,
  called `completeAnswer('')` and returned — the turn simply stopped, and
  neither the transcript nor the sidebar recorded a reason. A `length` stop with
  nothing to show is now recorded in the transcript as a truncated round, and
  the user is told the context is nearly full rather than being shown an empty
  bubble.

- **The agent had no clock, so it planned against a stale one.** Between rounds
  the model learned the time only from `wait` and the background-exec tools. On
  a slow local model that gap is not academic: one round took 13.5 minutes, and
  the agent reasoned "it's now ~20:50, so I should wait until 21:21" from a
  reading it had taken at 20:46 — the real time was 21:10 and the rate limit it
  was waiting on had all but reset. Tool results now carry the time they were
  produced. The stamp is rendered from a `stampedAt` fixed at creation and
  applied only to the model-facing copy, so it is byte-identical on every later
  round and cannot invalidate the KV cache — which the system prompt, the
  obvious place to put a clock, would do on every turn (363 seconds of prompt
  eval on the turn above).

- **Tool results were costed 17% over.** Measured against the live llama-server
  tokenizer over 138,571 chars of real tool results: 3.63 chars/token, against
  the flat 3.1 the estimator applied. The excerptor was cutting real content to
  satisfy a prompt size that was never there.

- **A CLI delegate that timed out threw its finished work away.** Claude Code
  edited the plan file it had been asked to revise and then hit the 600s
  ceiling; the caller received the words "timed out" and nothing else, and had
  to infer from file mtimes that anything had happened. The partial output now
  comes back with the error, along with the reminder that a CLI delegate edits
  the workspace directly and `git status` is the place to look.

- **A delegate's reply is a verdict, not a document.** `MAX_DELEGATION_RESULT_CHARS`
  is 24,000 — roughly a tenth of a 64k local window spent in one tool result —
  and the cut is head-only, so an oversized review loses its tail, which is
  where the verdict sits. CLI targets are now asked to keep the reply short and
  write long detail to a file, ending with a `REPORT: <path>` line the caller
  reads on demand. When the task was to edit files, those edits are the
  deliverable and no report file is written.

## 0.15.30

- **Every network fault reported itself as `fetch failed`, so none of them could
  be told apart.** A remote turn died with those two words after llama-server
  had been up for nineteen hours and never restarted — which ruled out the dead
  port a previous fix had addressed, and left nothing to say what had actually
  happened. Node's undici reports a refused connection, a reset socket, a
  headers timeout and a closed stream under that one message, keeping the
  reason in `error.cause`; `.cause` was read nowhere in the codebase. It is the
  same shape as llama-server answering a cut-off tool call and a malformed one
  with the same HTTP 500: one string for two faults means neither is
  actionable. `describeError` now walks the cause chain at the points where an
  error becomes something a person reads, so the message carries the reason —
  `fetch failed: read ECONNRESET` — and undici's timeout codes, which live only
  in `code`, are named too.

- **A failed turn left no trace in the session log.** `flush` writes the
  messages that exist, and a turn that dies produces none of its own, so the
  file ended on the last successful tool row and read as a healthy turn that
  simply stops. The 543-row log for the failure above carried no record of it;
  the rendered chat had the only copy. Turns that end in an error now append a
  `turn_error` row carrying the described message, beneath the rows they
  produced before stopping.

- **`exec_command grep` told the agent nothing, so it kept trying.** `grep` is
  not on the Windows PATH — the only copy lives inside Git Bash, which a
  `shell: false` spawn cannot reach — so the call failed with Node's bare
  `spawn grep ENOENT`. That names nothing usable, and it is the exact failure
  shape that left `delete_file` uncalled across ~3,000 tool calls: the agent
  reads a nameless refusal as "the capability does not exist" and goes looking
  for a workaround. `search_code` had bundled ripgrep behind it the whole time.
  The map that already redirected cmd.exe builtins (`dir` → `list_directory`)
  now also covers the Unix utilities that are simply absent — every spelling of
  grep and `rg`/`ack` → `search_code`/`search_codebase`, `cat`/`head`/`tail` →
  `read_file`, `sed`/`awk` → `edit_file`, and it matches through an `.exe`
  suffix so the second thing a model tries lands on the same advice. `find` and
  `findstr` are deliberately left out: both are real Windows programs that
  spawn successfully, and refusing a command that works teaches the same wrong
  lesson in the other direction. Nothing was added to the prompt — a rule there
  costs every turn, while an error string arrives only when it is relevant.
  What *was* changed in the prompt is the line that caused it: "**Grep** before
  creating anything new" put the verb in imperative position two lines above
  the one naming `search_code`, and now reads "Search".

- **`/status` and the status bar now report tool calls.** Nothing counted them:
  `ToolBudget` tracks only tools carrying a `tool_call_limits` entry, so
  reading it would have under-reported every unbudgeted tool. A
  `tool_call_count` now sits beside `model_request_count` on the conversation,
  incremented at the single dispatch site. It counts what was *dispatched*, so
  a refused or failed call still shows — it spent a round either way, and a
  count of successes alone would understate exactly the turns worth looking at.
  Telegram's `/status` gains a `Work:` line, placed under `Context:` because it
  answers the same question — what this chat has spent — rather than joining
  the per-window health figures on the `Forge:` line. The VS Code status bar
  tooltip gains `Tool calls:` beside `Model requests:`; its visible text is
  unchanged, being already three figures wide.

- **Unix `find` on Windows reached a different program of the same name.**
  `find . -name "*.ts"` spawns System32's `find.exe`, a text search utility,
  which rejects the arguments with `FIND: Parameter format not correct` — a
  message about a program the model did not think it was running, and one no
  error-path fix can reach, because the command *succeeded* in starting. The
  redirect therefore has to run before the spawn, which means refusing a
  command that would otherwise execute. That is only safe because the two
  `find`s are unambiguous from argv: the Windows one takes `/V /C /N /I`
  switches and accepts no `-` predicate at all, so `-name`, `-type`,
  `-maxdepth` and friends can only mean the Unix one. `find /c "needle"
  file.txt` still runs untouched, whole tokens are matched so a filename
  containing a predicate cannot trip it, and the check is Windows-only —
  elsewhere `find` *is* the Unix one and must keep working.

- **Clanker mode armed from Telegram no longer dies at the next reload.**
  Arming from the sidebar persisted to `workspaceState`; arming remotely did
  not, on the reasoning that a remote ON should not silently outlive its
  window. In practice that made the state unexplainable from either surface:
  two toggles that look identical disagreed about what a reload meant, and the
  owner could only find out by reloading. Both now persist, both on and off,
  and the Telegram help and confirmation text say so — previously the help
  described the remote rule while the sidebar quietly followed the other one.

## 0.15.29

- **`/workspace 23` answered with a page range, and 23 was a real workspace.**
  The pagers number their entries 1..N across pages, then take a *page* as
  their argument — so on a 30-workspace list the numbers 1-3 mean a page and
  4-30 mean nothing, while every one of them is also a visible entry number.
  The two readings are indistinguishable to the person typing, and the bare
  `usage: /workspace [list] <page 1-3>` that came back sent them looking for a
  paging mistake they had not made. An out-of-range page that *is* a valid
  entry number now names the command that means what was typed, and the entry
  it would select: `/workspace takes a page number (1-3), not a workspace
  number. For workspace 23 (Halluscribe), use /new 23.` A number past the end
  of the list has nothing to point at and still gets the plain range.
  Deliberately a hint and not a redirect — on a three-page list every number
  from 1 to 3 is a valid page *and* a valid entry, so acting on the guess would
  silently do the wrong thing for exactly the numbers typed most often. Applies
  to `/models` and `/chats` on the same footing, since they share the pager and
  the trap.

## 0.15.28

- **Every CI run since 0.15.13 was red, for one missing binary.** The voice
  tests drive `VoiceIngress`, which called `normalizeToWav` directly, and that
  spawns a real `ffmpeg` — so a unit suite that needs no model, GPU or network
  quietly needed a system binary. `ci.yml` installs none, so the failure was
  universal rather than flaky: ubuntu, macOS and Windows runners all failed,
  while a developer machine with ffmpeg on PATH stayed green. The symptom named
  the wrong thing twice over — `stt_failed`, and a spoken approval that resolved
  no gate — which reads as a recogniser or correlation bug, not an absent
  dependency. `VoiceIngress` now takes the normalize step as an injectable
  parameter defaulting to the real one, and the tests pass
  `passthroughNormalize`; `AudioNormalizer` remains its sole implementation.
  Verified by running the three files with ffmpeg removed from `PATH`. The
  0.15.27 tag exists but published nothing: the quality gate stopped it before
  the Marketplace step, which is exactly the order that step was put in.

- **The WakeSleep relay's dish half now exists, so `/sleep` works from the same
  Telegram chat as `/wake`.** 0.15.26 shipped `RelaySleepServer` — the receiver —
  but nothing could sign a request for it: the relay hardware is a MIPS airOS
  dish with no `openssl` binary and a busybox that ships only `md5sum`, and a
  first attempt at a Lua SHA-256 failed its test vectors, which led to a proposal
  to replace the HMAC with mutual TLS. The cause was not a missing capability.
  airOS *does* carry `/lib/lua/bit32.so`; that module **saturates out-of-range
  arguments instead of reducing them modulo 2^32** as Lua 5.2 specifies, so
  `band(2^32 + 5, 0xffffffff)` answers `0xffffffff` rather than `5`. Every
  SHA-256 addition overflows 32 bits, so folding sums with `band` pins the whole
  state to all-ones and every digest is `ffff…ff` for every input. Reducing with
  `%` instead fixes it, and no protocol change was needed. Worth remembering as a
  failure shape: a wrong digest is still a well-formed 64-hex string, so the only
  symptom downstream is a `401` — hence a self-test asserted on every daemon
  start, and a vector suite that runs on the dish rather than on the dev machine,
  which would have proved nothing about that platform. The relay itself lives
  outside this repo; nothing in Forge changed to support it.
- **Fixed the example config implying `wake_relay` takes workspace aliases.**
  The commented `wake_relay` block landed between `workspace_aliases: {}` and the
  `# Example:` that documents it, so the `ssuno:` sample read as an example of
  the wrong key. Moved below the example it belongs to.

- **Twenty-one verified high-risk bugs closed in one pass.** A full audit is in
  `docs/reports/2026-09-07-highest-risk-bugs.md`; the fixes share one theme —
  a guard that was written but not actually load-bearing. `write_file`,
  `edit_file` and the shared-runtime registry all did truncate-then-write, so a
  crash mid-write left a user file or a lease record empty rather than old;
  `writeFileAtomicSync` in `src/util/atomicWrite.ts` now owns that pattern and
  the xAI `auth.json` credential write uses it too. A relative path with **no
  workspace folder open** resolved against the extension host's own working
  directory, quietly pointing file tools at wherever VS Code happened to be
  launched from — that now refuses instead. The checkpoint capacity guard had
  no default, so any programmatic caller ran it uncapped; `DEFAULT_CHECKPOINT_LIMITS`
  supplies 512 MB / 20,000 files. Session persistence was fire-and-forget, so a
  memento write rejected on quota lost the transcript in silence and could be
  overtaken by a later update — writes are serialized and failures logged, and
  the legacy record is no longer cleared before its replacement is known to have
  landed.
- **The exec denylist was bypassable by wrapping the command in a shell.**
  Every guard ran against `command` and `args`, which is sound while the command
  is a real executable — but `bash -c "<anything>"` moves the whole payload into
  a single argument the denylist cannot parse, so the guard inspected the string
  `-c` and approved it. `bash`, `sh`, `zsh`, `dash`, `cmd` and `busybox` with a
  script flag are refused outright now, and the refusal names the alternative:
  a real executable with an args array, or the filesystem tools. Note the shape
  — the denylist was never wrong about what it saw; it was shown the wrong thing.
- **A stalled stream now aborts instead of hanging the turn forever.** The
  15-second idle heartbeat detected the stall and wrote a log line, and then did
  nothing about it — the turn stayed open indefinitely with no way back except
  reloading the window. Forty-five seconds of idle now cancels the reader and
  surfaces a real error to the user, and the late-arriving handlers stay quiet
  rather than reviving a stream already reported dead. Detection without a
  remedy reads as a working safeguard in the logs, which is worse than none.
- **A shared runtime could be borrowed while its owner was shutting down.**
  The owning window checked for live leases and then stopped, but nothing stopped
  a second window taking a lease *between* those two steps — it would then hold a
  lease on a server that was already going away. The registry record now carries
  `acceptingBorrowers`, an owner drains new borrowers before it inspects leases,
  and a borrower re-reads the record after taking its lease and releases it if the
  owner changed underneath. Discovery skips a draining runtime entirely.
- **Stopped telling a local delegate it was analysis-only.** The delegate system
  prompt opened by declaring the model a "local Forge delegation consultant" and
  forbidding tool use, edits and commands — a policy statement standing in for a
  mechanism. Policy is not what stops a local delegate from acting: `buildRequest`
  sends no `tools` array at all, so there is no channel to call one on. Spending
  tokens forbidding a capability the request never offered mostly taught the model
  it was junior. What remains is the one guard that earns its place, since a model
  with no tool channel is exactly the one that narrates edits it never made.

- **`/view [n]` replays a conversation to the phone.** There was no way to read
  a transcript remotely at all — `/status` and `/context` report numbers,
  `/chats` reports titles, and nothing showed words, so `/chat 3` switched you
  into a conversation you could not then read. It matters more since the live
  progress message: that message is edited in place and replaced with
  `Forge: completed.` at the end of a turn, so a phone that was off is shown the
  final state and never the edits it missed. Push is lossy for the trace by
  construction; `/view` is the pull that complements it. Defaults to the last 3
  exchanges, caps at 10 — a larger number is clamped and reported rather than
  refused. One message per exchange, oldest first, each headed `[2/3] You: …`
  with the prompt that asked for it. An agentic turn counts once: the text
  before its tool rounds is superseded by the answer it was working towards, so
  a `/view 3` is not spent on three fragments of one turn. Read through
  `displayPersistMessages`, deliberately not the session log — files written
  before 0.13.20 re-append the whole conversation on every reload, and a recap
  built from one would show the same answer several times over. Plan:
  `docs/plans/REMOTE_VIEW_TRANSCRIPT_PLAN.md`.

- **A turn started in the sidebar told a paired phone nothing until it was
  over.** The whole mid-turn channel — streamed commentary, tool milestones,
  phase headlines, and the notice and warning rows added last release — is
  rendered into one live remote message, and that message was only ever opened
  by `RemoteQueueDrain`, on the path that admits a prompt *from a chat*.
  `RemoteAgentProgress.handle` drops every event for a conversation with no open
  message, so for work started at the keyboard each one was discarded in
  silence; only the finished answer was mirrored. That is precisely the case
  remote control exists for — start something, walk away, watch it from the
  phone. `HostProgressOpener` now opens the message lazily on the first progress
  event, buffering what streams while the send is in flight so the trace does
  not begin mid-sentence, and the turn's own new `end` event closes it. A
  conversation nobody is paired to is decided once per turn rather than once per
  token. `/mirror off` silences the live trace exactly as it silences the echoed
  answer — they are the same content arriving at different times.

- **Approvals and `ask_user` questions had the same hole, and it blocked
  turns.** Both bridges resolved their chat by looking up the turn's remote
  request, so a confirmation gate or a question raised by a sidebar turn was
  never sent anywhere: the phone watched the work stop and was never told what
  it had stopped on. Both now fall back to the conversation's binding. One
  consequence worth knowing: while such a question is open, a plain message from
  the chat answers it rather than starting a turn — bounded to the seconds a
  gate is up, and `/`-prefixed commands are never claimed.

- `RemoteControllerOptions` moved to `remoteControllerOptions.ts`, beside the
  builder that produces it.

- **Compaction refused every conversation over 24,000 characters, and no model
  call was ever made.** The pre-request floor check measures the cheapest
  candidate that could exist — one carrying an EMPTY summary — and routed it
  through `applyCompactionWindow`, whose first line treats a summary-less state
  as "not compacted yet" and hands back the whole transcript. The floor
  therefore always equalled the uncompacted size, so the guard fired on every
  compaction above `MIN_WINDOW_CHARS_FOR_FIT_GUARD`. It surfaced as two
  identical figures on a first compaction (`~300,876 vs ~300,876`) and as raw
  transcript versus compacted window on a second (`~679,032 vs ~295,933`) — one
  bug with two faces, and neither number was a candidate that had grown.
  Measurement now builds the window unconditionally; the request path keeps its
  short-circuit. The genuine fit guard, which stops a compact/resume loop when a
  large tool-argument tail really cannot shrink, is unchanged.

- **Six phrases added to the streaming status line**, in the shared pool so they
  rotate on local and cloud routes alike.

- **`run_build` could never package, and said only "process timed out".** Its
  foreground timeout is 120 s and `npm run package` takes ~180 s, so that call
  was guaranteed to fail — and the error named no alternative, so the retry that
  works had to be guessed. An audited session burned a turn and two minutes on
  exactly this before falling back to `exec_command` with `background: true`.
  `run_build` now takes `background` itself, and its timeout says which flag to
  re-run with and which tool to poll. A refusal that cannot name its sanctioned
  alternative teaches the agent the capability does not exist.

- **`npm run package` refuses to overwrite a VSIX that is already there.**
  `vsce package` replaces `forge-llm-<version>.vsix` in place with no warning, so
  packaging without a version bump left two different builds behind one
  filename. The script now fails with the version to bump and the file to
  delete; `FORGE_ALLOW_VSIX_OVERWRITE=1` is the deliberate rebuild path. A
  mechanical guarantee rather than a prompt rule that costs tokens on every turn
  and is forgotten on the one that matters.

- **One `/select 1` from Telegram became ~30 inbound events and answered
  "remote rate limit exceeded".** The rate limit (30 per chat per minute) was
  never the problem — it was the brake. `/select <n>` calls
  `restoreConversation`, which throws when the tab cannot be opened (the 12-tab
  cap, or an id not in history), and the Telegram poll loop turned any thrown
  handler error into a `retry` that breaks the batch WITHOUT advancing the
  getUpdates offset. Telegram redelivered the same update immediately, forever,
  and only the rate limiter converting it into a rejection ended the burst — so
  the sender saw a limit they had not hit and never saw the real cause. The
  restore failure is now reported as itself, one update can be retried at most
  three times before it is given up on, and `/ratelimit [1-600|off]` sets the
  limit from the phone (persisted to `config.yaml`, live on the next message).
  Audit-log evidence: `docs/plans/REMOTE_SELECT_AND_INLINE_IMAGES_PLAN.md`.

- **`/list` and `/select` are `/chats` and `/chat`.** The plural lists, the
  singular picks — the pair `/models` and `/model` already used. The old names
  still answer, so nothing in muscle memory breaks, but they are gone from the
  help text and the command menu. The `/help` notes are also in an order now:
  they follow the command map above them instead of the order they were written
  in.

- **Images you send are shown in the chat, and open when you click them.** An
  attachment used to be invisible in the transcript, and after a reload it took
  the prompt with it: a user turn carrying a file has array content, and the
  display projection dropped every message whose content was not a string. The
  bytes are now written to the extension's own storage
  (`ChatAttachmentStore`) and the transcript keeps a reference, so nothing
  base64 reaches `workspaceState`; the sidebar renders images as thumbnails
  under the prompt that sent them, and clicking one opens it in VS Code's image
  preview.

- **Switching chat tabs no longer stalls for a second or two.** Every
  `sessionSync` shipped the transcripts of every open tab *and* all 40 archived
  history conversations to the webview — 16 MB in a measured workspace — to
  render one of them, and every tab switch also rebuilt and rewrote that same
  16 MB into `workspaceState` to record which conversation was now active. The
  host now sends only the transcripts the webview can render (the active tab
  plus anything streaming), a switch persists the active id as a single string
  instead of the whole blob, tab badges are counted without materialising the
  rows they count, and the webview's transcript reconciler walks its host rows
  once instead of rescanning them per local row. Returning to a tab you have
  already opened is a `hidden` toggle now, not a remount that re-runs
  `react-markdown` over the whole conversation, and rows scrolled out of view
  are neither laid out nor painted — which is what made coming back to the
  window from another app slow. Diagnosis and measurements:
  `docs/plans/SIDEBAR_SWITCH_LATENCY_PLAN.md`.

- **`exec_command` no longer hands a whole build log to the model in one
  round.** The formatter computed a bounded "shown" window and then returned
  the unbounded stored stream instead, so `max_output_chars` did nothing unless
  `head_lines`/`tail_lines` came with it, and the schema still advertised a
  10,000-character default that no longer existed. Both streams at the old
  120,000-char bound was ~60k tokens from a single call — on a 128k window the
  excerptor never fires, because the window is not tight yet. The returned text
  is now the only text: `max_output_chars` is honoured on every path, the
  retention bound is 60,000 characters per stream (~30k tokens for both), and
  the note names the bound that actually applied and says the rest is gone
  rather than implying `read_tool_result` can page it back.

- **A file that merely quotes the truncation marker is no longer treated as a
  truncated result.** `[truncated by ` was matched anywhere in the body by both
  `staleReadSupersede` and the new result nudge, so reading any source or
  transcript containing the phrase suppressed a supersede and attached a
  "narrow your search" instruction to a complete read. `isCapTruncated` in
  `resultCap.ts` — beside the function that writes the marker — anchors the
  match at the end, and both callers use it.

- **A compaction that cannot possibly shrink the window no longer pays for a
  summarization first.** The fit check ran after the model call, so a stuck
  window re-summarized and discarded the result on every threshold crossing.
  The same check now runs beforehand against an empty summary: a summary only
  adds characters, so if a zero-length one does not shrink the window, none
  will. The post-request check stays for a summary that came back long enough
  to undo a real reduction, and both refusals share one wording.

- **`llama_server_binary` on a model no longer requires the global binary too.**
  Config validation demanded `llama_server.binary` for any `llama.cpp` model,
  including one carrying its own override — which never reads the global value.
  Only models without an override require it now.

- **Seven helpers in `gitDiscovery.ts`/`gitLog.ts` stopped being exported.** No
  caller outside their own module and no test imported them, which is the shape
  `CLAUDE.md` calls the wired half of a bug pointing at itself.

- **A remote `/clanker` now shows up in the sidebar.** Telegram replied "clanker
  mode ON" and the gate really did open — `setClankerMode` set the flag — but it
  was the only writer of that flag that never posted `clankerChanged`, so the
  composer went on advertising gated approvals while non-dangerous writes landed
  unconfirmed. `setClankerMode` is the sole writer now and always announces a
  change; `toggleClankerMode` routes through it.

- **`/clanker off` from a phone stays off across a reload.** The sidebar toggle
  remembers itself in `workspaceState`; a remote toggle deliberately did not, so
  disarming from Telegram left the persisted ON to re-arm the gate on the next
  window reload. Remote OFF now clears that memory. Remote ON still does not
  write it — arming from away must not outlive the window.

- **Clanker's scope is stated where it is toggled.** It covers every tab in the
  window and that workspace only, which is correct for an approval-gate bypass
  and was nowhere written down. The sidebar reply, the Telegram reply, and
  `/help` now all say so, including that the sidebar toggle survives a reload —
  the remote help had claimed the opposite.

- **A turn no longer dials the port the model used to be on.** Forge's pool
  hands out a rotating port, and anything that unloads a model mid-turn — a
  `/unload`, an eviction, the benchmark freeing VRAM — brings it back through
  `startSlot` on the NEXT free port behind a *new* controller. The turn held
  the old one. On 2026-09-05 the log reads `slot ready … on port 8080` at
  16:33:05 and, twenty-two seconds later, `request start id=28
  target=127.0.0.1:8083` failing in **11 ms** with `fetch failed`. The next
  model request was 2 h 12 m later, and it was the user asking "Are you
  monitoring?". The endpoint is now resolved on every round through the pool,
  the way `getToolDefinitions` already was and for the same reason — so a
  round arriving mid-restart waits for the reload instead of failing against a
  corpse.

- **A turn that dies says so, to whoever was waiting.** The failure reached the
  status bar and the webview and stopped there. If you started the work from
  the sidebar and walked away to watch it from your phone — exactly what a
  long monitoring run is for — nothing ever told you it had stopped; silence
  and "still working" looked identical for two hours. Failures now fan out to
  the chats bound to the conversation, saying what broke and that nothing is
  still running. They decline when a chat-originated turn already gets "Forge
  request failed" from the queue drain, and `/mirror off` does not silence
  them: that switch means "stop repeating answers to me", never "stop telling
  me the work died". `/notify off` still covers them.

- **The benchmark stops evicting the chat model it does not need to.**
  `unloadForgeQwen` ran after every `qwen-forge` task, but the only thing that
  needs the GPU to itself is `qwen-minimal`, which spawns a second
  llama-server. With no minimal arm the unload freed nothing and cost the
  sidebar its model — it fired seven times in one afternoon, and one of those
  is what pulled the port out from under the monitoring agent. Teardown is now
  a `/release` unless a minimal arm actually follows, and `bench:qwen-suite`
  defaults to `--arms qwen-forge`: one shared server, one port, an agent that
  can watch its own benchmark. Ask for `qwen-minimal` by name when you want the
  comparison and have the VRAM.

- **`[AgentLoop] undefined chat failed`** — `model.provider` is optional and
  unset for local llama entries, so the log line named no provider at all.

- **`/steer 1` no longer runs a prompt that says "1".** `/drop <n>` takes a
  queue position, so `/steer <n>` looked like one too — and was not: the whole
  argument was prompt text, so `/steer 1` cancelled the running turn and asked
  the agent to act on the single character `1`. A real session went further and
  sent `/steer stop`, which is why the agent announced "Stopping the run now"
  and called `stop_execution`; it was doing exactly as told. A bare number
  after `/steer` is now always a queue position: `/steer 2` interrupts the turn
  and runs queued prompt 2, `/steer` with no argument runs prompt 1, and
  `/steer <text>` still jumps new text to the front. Every reply names which
  reading it took and quotes what it is about to run, so the two can never be
  confused silently again.

- **The queue now says what it is for.** Nothing told you that an ordinary
  message sent mid-turn waits rather than interrupts, or that the prompt you
  just typed could be promoted without retyping it — the acknowledgement
  offered `/steer <prompt>`, i.e. type it all again. A queued message now
  reports its position and the exact `/steer <n>` and `/drop <n>` that act on
  it, and `/queue` says these run in order once the current turn ends.

- **`/mirror` was implemented, documented, and invisible.** It was missing from
  Telegram's native command menu, so it existed only for someone who had read
  the help text closely. The command map lives in three places that cannot see
  each other — the handlers, `/help`, and the bot menu — so a test now reads the
  handlers back and fails when any of the three drifts. It caught a second
  omission on its first run: `/help` was not listed in its own output. `/help`
  itself was also rewritten, with a "How work is queued" section, because
  several notes described behavior that no longer matched the code.

- **The agent can tell the time again, so an hourly report is actually
  hourly.** Asked to check a benchmark every 60 minutes, it posted a "60-min
  check" seven minutes in. The transcript shows why: two `wait(360)` calls,
  each answered `Waited 360s.` and nothing else. A duration is not a position
  in time, so the only way to keep an interval was to count its own sleeps, a
  miscount is invisible from the inside, and the system prompt's new date line
  closed the last exit by telling it not to ask the shell for the clock — a ban
  with no sanctioned alternative named. `wait` and `monitor_execution` now
  report the local wall clock on every return, which is safe where a clock in
  the system prompt is not: a tool result is appended past everything already
  in the KV cache, so a value that ticks costs no re-evaluation. The prompt
  points at that clock instead of just forbidding the other one, and `wait`'s
  description says outright that an hour is four calls of 900s, not one.

- **`read_file numbered: true` no longer breaks the edit that follows it.** The
  prefix was `"675| "` — number, pipe, *space* — and a model cannot tell that
  space from the line's own first column. So every `old_str` composed from a
  numbered read carried one extra leading space on every line, and `edit_file`
  refused text that had been quoted perfectly. On 2026-09-05 that cost a whole
  session: against `.forge/config.yaml`, where indentation is load-bearing, six
  consecutive edits failed, all off by exactly one space, while a second tab
  editing the same file the same day with no numbered reads went two for two.
  The separator is now `"675|"` and the character after the pipe is column 1.
  The miss message was making it worse — it compared lines with `trim()`, so a
  uniformly over-indented block came back as "your first line matched, a later
  line differs", sending the model to hunt a line that was fine. A constant
  indent shift is now detected and named, with both indents reported. It is
  reported, never applied: silently re-indenting a YAML or Python block would
  change what the edit means.

- **`search_code` and `find_files` can see `.forge/config.yaml`.** Two things
  hid it. `.forge/**` was excluded wholesale to keep the semantic index out of
  results, and the index is one file, not a tree — the exclusion is now the
  index, the session logs and the remote inbox by name. And ripgrep applies
  `.gitignore` to what it *crawls*, which listed `.forge/`, so even the
  narrowed exclusion would not have been enough. A path the caller typed out in
  full is now handed to ripgrep as a search root rather than as a glob filter,
  and ignore rules do not filter a search root: naming a file is an explicit
  request for that file. Wildcard patterns keep the ignore rules, which is what
  stops a search drowning in build output. Before this, `search_code "num_ctx"
  include=".forge/config.yaml"` reported "No matches found" about a file holding
  37 of them, and the agent fell back to reading blind 100-line windows.

- **New tool: `open_file`.** Asked to open a file in the editor, the agent had
  no way to do it and read the file into the chat instead — a different thing
  entirely. The plumbing already existed (`ToolDispatch.openFile` backs the
  webview's file links and auto-open-after-write); nothing exposed it to the
  model. Opens at a given line, optionally beside the active editor, and never
  as a preview tab, so the file the user asked for is not replaced by the
  agent's next read.

- **The agent knows what day it is.** Nothing in the system prompt carried a
  date, so a model asked to write one reached for
  `powershell -Command "Get-Date"` — banned, because a model-authored script
  cannot be checked by the denylist — and spent a round recovering through
  `node -e`. The refusal was not at fault: it names alternatives, and none of
  them tells the time. `TemplateEngine.render` now supplies `currentDate` to
  every template. Date only, never a time: the system prompt is the KV cache's
  prefix, so anything in it that ticks re-processes the whole prompt every turn.

- **An unsent prompt stays in the tab you typed it in.** The composer held one
  `text` state for the whole panel, so a draft typed in one tab appeared in
  every other tab's prompt box — and would have been sent to whichever tab was
  open when you hit Enter. Drafts are now per conversation, the way staged
  attachments already were.

- **`format_file` no longer touches your editor.** It opened the file, ran the
  editor's format command, saved, and then closed the active tab — which was
  whatever happened to be focused by the time that command ran, not necessarily
  the file it had formatted. It now asks the document formatting provider
  directly and applies a workspace edit, the shape `rename_symbol` fifty lines
  below it already used. It also stopped reporting success it had not earned:
  a rejected edit, a failed save, or a document that changed while the formatter
  ran are all errors now, and "no formatter available" is no longer reported as
  "already formatted".

- **The git tools work without the VS Code Git extension.** `git_log`,
  `create_branch` and `switch_branch` went through that extension's wrapper
  methods, and repository discovery went through its repository list, so in a
  window where it was unavailable those tools failed outright while `git_status`
  beside them worked. Everything runs `git` directly now, and discovery asks
  git itself (`rev-parse --show-toplevel`) before consulting the extension —
  which matters beyond the missing-extension case, because the extension's
  repository list is only what VS Code happened to discover, so an outer
  repository could silently capture work meant for a nested one. Linked
  worktrees, whose `.git` is a file, are found for the same reason. Missing git,
  a path in no repository, an invalid directory, a permissions error and a git
  trust refusal are now five distinct messages instead of one, and `switch_branch`
  can no longer restore a *file* that shares the branch's name.

- **`FORGE.md` is inherited down the tree.** Only the nearest repository root's
  file was loaded, so in a monorepo one file had to carry rules for every
  package — the content a local model can least afford in its permanent prompt.
  Forge now assembles the chain from the repository root down to the directory
  being worked in, one file per level (`FORGE.md` preferred over `AGENTS.md`),
  each labelled with the directory it applies to. The 15,000-byte guard is now a
  budget across the whole assembled chain rather than per file, allocated
  root-first so a large leaf truncates instead of pushing repository-wide rules
  out; anything truncated or dropped is stated in the text and warned about
  once. A nested repository starts its own chain, and instructions reached
  through a link out of the workspace are refused rather than read. **If you
  already have a nested `FORGE.md`, it was being ignored and now takes effect.**

- **Compaction stops losing finished work.** Four defects, each of which could
  make a resumed agent redo something it had already done:
  - The 24-entry ledger cap filled itself with non-successes in oldest-first
    order, so a run of old failures could evict every recent success. Slots are
    now reserved by category and filled newest-first within each, so recent
    completed work, the latest unresolved failures and quoted output evidence
    all survive and no category can take every slot.
  - Dropped entries were silent, which reads as "this never happened". The count
    is now carried across compaction generations and stated in the block.
  - A command's identity came from the first absolute path in its *output*, so
    a build that produced a file and a later command that merely observed it
    collapsed into one entry — and the observation superseded the build. It also
    ignored the working directory, so `npm run ci` in two packages was one
    entry. Identity is now the tool, the working directory and the structured
    arguments; output naming a path is evidence, not an identifier.
  - A long final message was cut to its opening, discarding the ending where
    the next step usually is. The opening and the ending are both kept now, with
    the elision marked, and the block no longer claims nothing happened after
    the message when tool calls in fact followed it.

  The summarizer is also now told to record what is already done and what
  investigation concluded, to separate live blockers from failures already
  fixed, and is given the agent's own plan labelled as intent rather than as
  evidence. Its source is cut to whole messages from each end, with a count of
  what was dropped, instead of a character slice through the middle of one. And
  a compaction that would not actually shrink a large window is refused, keeping
  the previous state and saying why, rather than committing it and auto-resuming
  into a loop.

- **Documented the local-model runtime behaviour** in
  `docs/LOCAL_MODEL_OPTIMIZATIONS.md`: truncation-aware recovery, temporary
  thinking suppression, lazy tool groups, bounded results, prompt-prefix
  stability, per-slot budgets and the compaction ledger — with the owning file
  for each. All of it already shipped and was findable only by reading source
  comments, which is how an architecture review came to propose rebuilding four
  of them.

## 0.15.18

- **Every Telegram list and report is readable on a phone now.** The model list
  already grouped and bolded itself; everything else arrived as one unbroken
  block. `/help` ran eleven notes together with nothing between them, `/list`
  packed a title, an id, a model and a timestamp onto a single wrapping line per
  conversation, and `/status` read as six lines of undifferentiated prose. Rich
  text now covers all of them: `/help` gets a paragraph per command group and
  per note with the section label and each note's subject command in bold;
  `/list` and `/select` give each conversation a bold numbered title on its own
  line, its ids and timestamp indented under it, and a blank line before the
  next; `/models` and `/workspace` bold the entry number, which is the part you
  type back; `/status`, `/context` and `/queue` bold their line labels. The rule
  that makes it safe is the one the model list already used — escape the whole
  message first, then re-insert markup only for the structure Forge itself
  decided on — so a conversation title full of angle brackets is content, never
  markup, and a transport that does not parse HTML still gets the same
  paragraphs with nothing leaking through.

## 0.15.14

- **Remote resume and conversation selection now have distinct commands.** Bare
  `/resume` continues the conversation already bound to Telegram and loads its
  model when needed. `/select <number-or-id>` switches the binding without
  starting a turn; numbered `/resume` remains as a compatibility alias.

- **`/system` says what the machine is doing, and which PID is holding the
  VRAM.** New on both surfaces — the sidebar `/` menu and Telegram — plus a
  `get_system_status` tool so the agent can read the same numbers in one round
  instead of shelling out for them. Per-GPU load, utilisation and temperature
  come from `nvidia-smi`; the per-process VRAM does not, because on WDDM
  `--query-compute-apps` reports `[N/A]` for every process *and* lists graphics
  clients like `explorer.exe`. The report reads the same performance counters
  Task Manager does, filters to processes actually holding VRAM, reconciles each
  adapter LUID against a card, and tags Forge's own llama-server backends with
  their model name — the one line no external tool can produce. RAM and free
  space per drive ride along. A probe that fails says why: a missing nvidia-smi
  or a localised counter name is reported, never rendered as an empty section.

- **A workspace switch no longer strands the chat between two windows.**
  `/new <n>` recorded the move, stopped this window's transports and asked VS
  Code to open the target folder — but when that folder is *already open in
  another window*, VS Code focuses that window instead of reloading this one.
  Nothing reloaded, so nothing ran the arrival claim, and the transport lease
  had already been released: no window was polling Telegram at all. The chat's
  last message stayed “switching…”, and `/status` went unanswered until a window
  was reloaded by hand. Now a window that is already running watches for a chat
  handed to it and claims it without a restart — taking the transport over first,
  so two windows on one folder cannot both take the chat — and the window that
  started the switch takes it back if nobody claims within twenty seconds,
  saying so in the chat rather than leaving it quiet. The arrival receipt no
  longer blames a reload for the locked session: sessions live in the window
  that authenticated them and never cross to another one, reload or not.

- **A spoken reply no longer reads your own question back first.** The one-time
  `Chat: … · ID: …` label at the top of the first answer in a chat was being
  synthesized along with the answer — and a conversation title is derived from
  the prompt you sent, so every voice message opened by repeating your question
  and then spelling out a shortened id, before any of the reply arrived. The
  label is a written navigation aid; it is now stripped before synthesis and
  left untouched in the text message.

## 0.15.13

- **Talk to Forge, and hear it answer.** Send a voice note to the Telegram bot
  and it comes back as `Heard: "..."` for you to confirm with `/ok` before
  anything runs — the transcript is a draft, never a submission. Replies are
  spoken back as a playable voice message. Transcription is whisper.cpp with
  `large-v3`, chosen on deployment grounds rather than speed: faster-whisper's
  CUDA path cannot start without a ~500 MB CUDA 12 runtime an end user would
  have to install, and Ssuno had already tested and deleted `turbo` for
  dropping a whole couplet and hallucinating an outro.

- **Spoken approvals, and the refusals that make them safe.** Say "approve",
  "εντάξει", "deny" or "σταμάτα" and the matching gate resolves — but only when
  exactly one approval was open across your entire recording window. Anything
  ambiguous refuses and tells you to tap the button. Matching is
  whole-utterance, which is what makes the negated cases safe: a recorded
  `μην εγκρίνεις` came back from whisper as `Μείνα εγκρίνης.` — mangled past
  recognition, the negation destroyed — and was still refused, because a
  two-word phrase cannot match a whole utterance. All six recorded negations
  are now a test, against verbatim fixture transcripts, so it needs no GPU.

- **Replies are summarized for speech, not narrated.** A code fence becomes
  "Code block, 12 lines", a path becomes its last segment, a table becomes "A
  table.", a URL becomes "a link" — and inline code keeps its content, because
  `npm run ci` is exactly what you want to hear. A reply that renders down to
  nothing but placeholders is not spoken at all.

- **An invisible byte no longer costs an hour.** A stray `0x08` inside a regex
  literal made a function return the wrong answer while the identical code
  worked in plain node. It renders as `` in `od` and as *nothing* in every
  editor, terminal and grep. That is the second time this repo has been bitten
  by a control character generated through a shell heredoc, so there is now a
  test that scans every tracked source file and fails by name.

## 0.15.12

- **A resumed agent stops treating old requests as new ones.** After an
  auto-compaction the agent announced that a benchmark run had "errored again"
  and started re-investigating a fix it had already shipped and reported. The
  summary was not at fault — it carried the right root cause and an exact Next
  ("user presses Enter on the pasted command"). What it read instead was the
  last line of the `VERBATIM USER REQUESTS` block: a complaint issued before the
  fix, already answered in full, rendered in a user-role message with nothing
  marking it as history. Everything in that block is history by construction, so
  it now says so, and names the summary's Next as the authority on what is still
  open. Two earlier sessions show the same misread ("User's last message [22]…"
  when [22] was not the last message); both recovered, this one did not.

- **Forge's own prompts stopped looking like yours.** The compaction resume
  prompt is sent with an `internal` flag precisely so it is not mistaken for
  something you typed — and the flag never arrived. The wiring adapter was
  written with three parameters against a four-parameter signature, which
  type-checks and silently discards the fourth. Zero of 472 messages in the
  audited conversation carried the flag, and `Continue the active task from the
  compacted context.` was sitting in the verbatim block as entry [12], replayed
  to the model as one of your instructions.

- **The agent's last words survive the cut.** A compaction keeps the last
  exchange verbatim only when it fits 4,000 characters; one measured exchange
  cost 21,860, so nothing was kept and the agent's closing message to you — the
  one saying the command was pasted and waiting — reached the next turn only as
  a paraphrase. When the retained tail carries no words of the agent's own, the
  last thing it actually said is now recorded verbatim beside the summary.

- **The summary is in the session log.** The row recorded `summary_chars` and
  dropped the text. That summary *is* the working context for every turn after
  it, and reconstructing this misread meant digging the live copy out of
  workspaceState, which survives only until the tab is cleared.

## 0.15.9

> Ships 0.15.7 and 0.15.8 as well: both were committed but never tagged, so the
> publish workflow — which fires on the tag, not the commit — never ran for
> them. Coming from 0.15.6, everything under all three headings is new to you.

- **The sidebar gets its column back.** The panel was spending roughly two
  thirds of a 382 px column on chrome, leaving the transcript the smallest
  region on screen. Eight changes, none of them a restyle: the header is one row
  instead of two and carries the Forge mark; the sessions flyout floats over the
  transcript instead of pushing 200 px of it off-screen, and its list is twice as
  tall now that length costs the chat nothing; the composer's stacked button
  column becomes one row under a full-width field, taking the model selector with
  it; and a short conversation anchors to the bottom of the panel, next to the
  composer, rather than floating above 400 px of void.

- **The "Queue" button is gone.** While a turn was running it called the same
  submit that Enter calls, and the queued prompt already announces itself in the
  transcript with Steer and Cancel on it. Enter still queues; a line under the
  composer says so.

- **Clanker arms the field instead of shouting.** An amber all-caps pill sat a
  pointer-width from Stop — persistent state filed among actions. Clanker is
  durable across reloads, so it now colours the box you type into, with one dim
  line naming it and how to stop it. Off, none of it renders.

- **The thinking fold says how long it thought.** `Thinking · 4.2s`. Reasoning
  and the answer draw on one output budget, so that number is worth seeing
  without opening the fold.

- **"Starting backend, please wait…" stops lying.** It is rewritten in place to
  "Backend ready." rather than answered by a second row, which used to leave the
  first one in the transcript permanently describing a wait that had ended.

## 0.15.8

- **`/workspace` lists on its own now.** The namespace had exactly one verb, so
  `/workspace list` was ceremony: `/workspace` lists, `/workspace 2` pages, and
  `/workspace list [page]` still parses so the namespace stays open for the
  `create`/`confirm` subcommands the remote plan has queued behind it. Anything
  else after `/workspace` is rejected rather than silently listed.

- **`/workspace list <page>` never paged.** The command line was split with a
  limit of two, so `/workspace list 3` arrived as `['/workspace', 'list']` and
  the page number was thrown away — the page fallback printed in every list
  footer always returned page 1. Commands now split whole.

- **"Where am I?" is answerable.** A chat moved with `/new` could be sitting in
  any project on disk and nothing said which. `/status` now leads with
  `Workspace:`, and the `/workspace` list names the open folder under the
  entries. Both fall back to the folder's own name when it is not an alias, so
  the answer is never blank.

- **A workspace switch no longer goes silent.** `/new <n>` reloads the VS Code
  window, and remote TOTP sessions are memory-only, so the chat arrived in the
  new project locked — with nothing to say so. The last message was
  “switching…” and the challenge only appeared if the user happened to send
  something, so the sane reading was that the switch had hung. The window that
  comes up now sends its own arrival receipt (“now in X — a new chat is bound
  here”, plus the unlock instruction when TOTP is enrolled), which doubles as
  the signal that the switch finished, and the pre-switch line says the chat
  will go quiet for a few seconds first.

- **`/new <number>` stopped blaming the wrong thing.** A number that resolved to
  nothing reported `workspace "26" was not found` — sending the user to look for
  a missing project when the real cause was a selection list that had expired
  (they live 10 minutes) or a number outside its range. The three cases now say
  which one happened, and an unavailable switch path says that instead.

## 0.15.7

- **`/workspace list` was empty on every install.** Switching the Telegram
  chat to another project needed `remote.workspace_aliases` hand-written into
  `config.yaml` — four path/display pairs before the feature did anything — so
  in practice the block was empty and the command answered "no remote workspace
  aliases are configured". Forge now lists the sibling folders of whatever
  project this window has open, with no configuration at all: the search root is
  `dirname(workspaceFolders[0])`, derived at runtime, so it is `N:s code apps`
  for one user and `~/dev` for another and hardcoded for nobody.

  There is deliberately no `.git` filter. It was the obvious refinement and it
  would have hidden the folder that prompted the whole change — on the disk in
  question the parent holds 29 directories, 13 of them repositories, and the
  `Qwen testing` folder is not one of them. Dotfolders and dependency
  directories are skipped and the scan is capped at 100 entries. Explicit
  `remote.workspace_aliases` still win, and an explicit entry pointing at a
  discovered folder replaces it rather than listing the same directory twice.

  The scan runs when the remote controller's options are built, so a project
  created after this window opened appears after a config change or a reload
  rather than instantly.

- **`/list` sent every conversation in one Telegram message.** A workspace with
  forty conversations produced a wall of text that had to be scrolled past on a
  phone, and left it in the chat history forever. `/list`, `/models` and
  `/workspace list` now send ten entries at a time with native inline-keyboard
  `Previous` / `Next` / `Close` buttons: navigation edits the original message
  rather than posting another one, and `Close` deletes it. Numbering stays
  absolute across pages, so `/select 17` and `/model 17` mean the seventeenth
  item whichever page is on screen. `/list 2` and `/models 2` are the text
  fallback for transports without buttons.

  Every callback runs the full inbound gauntlet before it can move a page —
  private chat, paired owner, TOTP, rate limit — and carries an opaque
  twelve-character token instead of a conversation ID, so a button reveals
  nothing and cannot drive another chat, another list kind, or an expired
  selection. Issuing a list invalidates the previous one of its kind. Stored
  remote state migrates implicitly: the token is optional, so state written by
  an older build still parses.

- **Workspace pages were encoded as model pages.** The Telegram callback codec
  mapped selection kinds with `kind === 'conversations' ? 'c' : 'm'`, which
  gave `/workspace list` a keyboard stamped `m`. Pressing `Next` on it looked
  up a *models* selection under a workspace token, missed, and reported the
  list as expired — the security check working correctly against a bug on our
  own side. Encoding and parsing now share one table covering all three kinds.

- **`/workspace list` never marked where you were.** `RemoteRuntime` computed
  which configured alias matches this window's root and `RemoteCommandHandler`
  read it, but the controller passed it only to the selection-callback path, so
  on the command path it was always undefined: the `· current` marker never
  appeared, and the guard that stops `/new <alias>` from reloading the window to
  arrive where the chat already is could never fire.

- **A successful `move_file` on a directory reported `EISDIR`.** The move
  itself worked — the failure came afterwards, from the per-turn diff trying to
  read the moved directory as text, and the dispatcher turned that render error
  into the tool's result and charged the failure tracker for it. The agent then
  spent three rounds trying to recover a move that had already happened, and
  reached for `powershell -Command` on the way. Diff rendering now runs in its
  own try/catch and skips directories, `move_file`'s schema says it takes a
  file *or a directory*, and the PowerShell refusal names the write tools
  (`write_file`, `edit_file`, `move_file`, `create_directory`, `delete_file`)
  instead of only the read-only ones.

## 0.15.6

- **A cold backend start looked like a hung turn from the phone.** The sidebar
  shows a `backendStarting` row while `llama-server` spawns and the weights
  load, but a remote reader cannot see it: the mirrored Telegram progress
  message just said "Forge: working…" through the whole spawn plus a
  multi-second model load, which reads as a stall rather than a startup. A new
  `phase` agent-progress event replaces the headline of the mirrored message
  for exactly as long as the wait lasts, and `text: undefined` restores the
  default. It is emitted from the same 500 ms timer that already gates the
  sidebar notice — so a warm backend, which returns well inside that window,
  still shows nothing at all. The restore sits in the `finally` alongside
  `clearTimeout`, so a spawn that fails cannot leave the startup headline
  outliving the startup.

## 0.15.5

- **The store description was 157 characters, and the Marketplace truncates
  around 130.** "A VS Code coding agent for people who run their own models:
  real llama.cpp/GGUF control, tools built for local context limits, Keep/Undo
  on every turn, no telemetry" lost its last two clauses in search results —
  including *no telemetry*, which is the one claim in the category that most
  competitors cannot make honestly. It was also four comma-separated clauses
  with no verb, and one of them ("tools built for local context limits") is
  precise, true, and meaningless to anyone who has not already hit a per-slot
  context ceiling.

  Now: **"Run your own models in VS Code: full llama.cpp/GGUF control, 60+ agent
  tools, undo any turn, no telemetry."** 106 characters, so nothing truncates.
  Opens with a verb. `llama.cpp` and `GGUF` land inside the first 40 characters,
  which matters twice over — the Marketplace searches description text, and
  those two words are what make the intended reader stop scrolling. Applied to
  both registries and the GitHub repository, which now all carry the same line.

## 0.15.4

- **The Marketplace and Open VSX Overview pages were 38 KB of contributor
  reference.** That page is `README.md`, and nearly half of it was material a
  store visitor scrolls past forever: a forty-row VS Code command-palette table
  (10.6% of the page on its own), the `npm run test:local-tools` harness with
  its vitest environment variables, `cli_idle_timeout_ms` and LRU eviction
  rules, and a llama.cpp log line about LCP slot similarity. It also carried
  three full release sections duplicating a Changelog tab that has existed
  since 0.15.1.

  The page is now 25 KB and product-shaped: Why Forge, screenshots, what the
  agent can do, run it from your phone — then setup. The reference moved
  wholesale rather than being deleted, into `docs/COMMANDS.md`,
  `docs/TOOL_SCHEMA_AUDIT.md`, `docs/SHARED_RUNTIME.md` and
  `docs/DELEGATION.md`, each linked from the summary that replaced it. Nothing
  was lost; it stopped being the first thing a prospective user reads.

  `docs/*` is gitignored with a per-file allowlist, so all four needed an
  explicit `!` entry — untracked would have meant four 404s on the store page,
  since `vsce` rewrites relative links to absolute GitHub URLs.

  Added version, installs and license badges, which the page had never carried.
  Every relative link and in-page anchor is verified to resolve — `vsce`
  rewrites them to absolute GitHub URLs at package time, so a broken one ships
  silently and only breaks on the store page.

## 0.15.3

- **The README never said what the agent can do.** It documented backends,
  config, sharing and delegation in real depth, and then described the agent
  itself with a bullet list. An entire category was missing outright:
  **LSP-backed code intelligence** — `go_to_definition`, `find_references`,
  `find_implementations`, `get_diagnostics`, `apply_code_action`,
  `rename_symbol` and the rest run through VS Code's own language servers, so
  the agent answers "who implements this?" from real analysis rather than
  guessing from a name, and none of it appeared anywhere in the README. So was
  durable cross-session memory (`remember` / `recall` / `list_memories`). A new
  "What the agent can do" section covers all sixty-plus native tools by group,
  and every tool name in it was verified against `src/tools/` rather than
  written from memory.

- **Remote control had one bullet and a link.** Telegram control — a real Forge
  session in a private chat, with approval gates resolvable from either the
  phone or the desktop, live agent and compaction progress, attachments, and a
  queue you can steer — was a single line at the bottom of Highlights. It now
  has a section: the two gates (exact-ID pairing, private chats only, plus an
  enrolled Google Authenticator-compatible TOTP whose QR is shown locally and
  never sent through Telegram), the durability design that makes a dropped
  connection re-deliver rather than lose, the full command list, and the fact
  that the audit log is metadata only.

- **"Why Forge" gained the two reasons it was missing** — the depth of the tool
  surface, and that Forge follows you out of the room.

## 0.15.2

- **The releases page stopped at v0.12.29 in July while 0.13, 0.14 and 0.15
  shipped to both registries.** Nothing in the publish workflow ever created a
  GitHub Release, so the only account of three minor lines lived in a file you
  had to know to open. The workflow now cuts the release body from `CHANGES.md`
  via `scripts/release-notes.mjs` — the same source, not a second one written by
  hand and left to drift — and attaches the exact VSIX the registries received.
  It runs last, so a registry failure cannot leave a release announcing a
  version that never went out. The job needs `permissions: contents: write`;
  this repo's default token is read-only.

  Note for anyone looking: **0.15.0 and 0.15.1 have no GitHub Release and
  cannot get one.** This repo has immutable releases enabled, which reserves a
  tag permanently on first use; both were created, deleted in an attempt to
  attach their VSIX, and are now refused. Their notes are above, in this file.

- **The VSIX is packaged once and reused.** `vsce publish` packages internally
  and keeps nothing, so the Open VSX step built its own copy and the release
  step would have built a third. One `vsce package --out` step now feeds both.

- **`README.md` covered a version and a half of the eleven that shipped.** Its
  "What's New Since v0.12.3" section predated background execution, demand-loaded
  tool groups, the compaction-surviving task plan, terminal awareness,
  `view_video`, recycle-bin deletes, prompt-prefix stability, and the whole 0.15
  context-reduction pass — a reader on the Marketplace page was being told about
  a Forge two lines behind the one they were installing. Replaced with a "What's
  New" section organised by line, and the Highlights list gained the six
  capabilities it never learned about.

- **The extension description says what Forge is for.** "Local coding agent with
  first-class llama.cpp/GGUF control, reliable tools, and Keep/Undo checkpoints"
  led with a category and buried the wedge; "reliable tools" is a claim every
  extension makes. Both registries and the GitHub repo now carry the same line,
  and the repo gained topics and a homepage it had never been given.

## 0.15.1

- **Both registries said "No changelog available" — every release, since the
  first.** They look for `CHANGELOG.md` at the package root; this repo's
  changelog has always been `CHANGES.md`, and `.vscodeignore` excludes `*.md`
  with only `README.md` re-admitted, so even a correctly named file would not
  have reached the VSIX. `scripts/sync-changelog.mjs` now generates
  `CHANGELOG.md` from `CHANGES.md` as part of `npm run package` and
  `npm run publish`, and `.vscodeignore` re-admits it. A generated copy rather
  than a rename: `CHANGES.md` is referenced by `CLAUDE.md`, `docs/OWNERS.md`
  and years of commit messages, and churning all of that to satisfy a
  packaging convention would be the wrong trade. The copy is gitignored — it
  is a build artifact, and committing it would create a second file that
  drifts from the real one.

## 0.15.0

- **The system prompt is 585 tokens lighter, with nothing lost.** It was 3156
  tokens on every request — `execute.njk` plus this workspace's `FORGE.md` —
  and four blocks in it were paying rent they did not earn.

  *Plan governance moved to the tail.* 378 tokens of rules for how to follow a
  recorded plan sat in the system prompt of every conversation, including the
  majority that never record one. They are only actionable when a plan exists,
  so they now ship with it: `PLAN_GUIDANCE` in `src/tools/planTools.ts`,
  appended to the plan in the turn-context block. The tail specifically, never
  a conditional at the head — content that appears when `update_plan` first
  fires would invalidate the whole KV cache mid-conversation, the failure
  `PROMPT_PREFIX_STABILITY_PLAN.md` measured at 4971 re-evaluated tokens for a
  single changed line. It is appended after `PLAN_RENDER_MAX_CHARS` is applied,
  so a long plan truncates its own items rather than the rules for reading
  them. The one workspace-specific rule (plan docs must end with an acceptance
  checklist) stays in `FORGE.md`, where it belongs.

  *The `state.vscdb` session-title recipe moved to
  `docs/WORKSPACE_FORENSICS.md`.* 313 tokens — 14% of `FORGE.md`, embedded
  Python one-liner included — for a lookup needed perhaps once a month. A
  four-line pointer replaces it.

  *The model-status block is gone.* It was captioned "verify before relying on
  it": a rule the prompt told the model not to trust, charged in full on every
  turn, and it documented `zai-glm-4.7` as archived — a model not in the
  config.

  *The delegation block was rewritten*, since it still said to pick the
  smallest GGUF to minimise OOM risk. Forge now asks the user before any target
  that loads local weights, and the ranked list prefers CLI agents outright.

  Not touched, deliberately: the scripts and test-layout facts look equally
  derivable from a tool call, but a round trip on a local model costs far more
  than their 157 tokens. And `execute.njk` appears to restate roughly 150
  tokens of tool descriptions — that needs an A/B, not a guess.

- **`ask_local_agent` no longer spends 285 tokens a turn listing every model.**
  The target list was spliced into its `model` argument description on every
  request — 1027 characters against a real config, ~40% of it ten
  near-identical GGUF quant names, every entry weighted the same as
  `claude-code`. The schema now names only the configured CLI agents and says
  to call `list_delegation_targets`, a new no-arg tool that returns the full
  live list ranked by what each target costs: CLI agents first (their own
  tools, their own process, no VRAM), then cloud, then local with the VRAM
  warning. The same `load_tool_group` trade — one round when the agent needs
  the list, nothing on the turns it does not. Net ~151 tokens back per request.
  The list stays generated from config, so a model deleted from `config.yaml`
  still disappears without a reload.

- **Delegating to a model that loads local weights now asks the user first.**
  `DelegationGate` counts free SLOTS (`max_simultaneous_models`), not
  gigabytes. Set to 4 on a single 16 GB card, delegating from a resident 27B to
  another large GGUF passes every check Forge makes and then thrashes WDDM
  instead of failing — silent degradation, the worst shape a failure can take.
  `ask_local_agent` now returns approval metadata for any target that loads
  local weights, routing it through the existing per-action confirmation gate.
  Cloud and CLI targets take no slot and are not gated, and an Ollama entry
  tagged `:cloud` is correctly classed as cloud (it reaches the daemon like a
  local one but runs remotely) — `classifyModelRoute` is the owner of that
  distinction, and `eligibility.ts` now carries `localWeights` per target. A
  name that does not match a known target — a fuzzy alias or `model@profile`
  the handler still resolves — falls to the safe side and asks.

- **`wait` names its coding uses.** Its description covered interval pinging
  and rate-limit backoff but not the two cases where it is the only option: a
  dev server or file watcher launched in the background needing a moment before
  it will answer, and a file just written needing one before an index or
  watcher reflects it. Waiting once beats retrying a check that cannot succeed
  yet. `monitor_execution` is still the answer for waiting on a specific
  command.

- **A remote command is no longer held across a TOTP challenge, and `/reload`
  no longer runs twice.** Two separate mistakes stacked into one bug. First,
  the challenge branch held *any* text, so `/reload` typed at a locked session
  was armed and fired the moment the 6-digit code arrived — a command running
  at a moment its sender did not choose. Second, `/reload` awaited
  `workbench.action.reloadWindow`, which tears down the extension host: the
  code after it never ran, so `handleRemoteCommand` never marked the durable
  control receipt completed and the Telegram transport never committed its
  update cursor. The command was redelivered on the next start, un-receipted,
  and ran again. Now only a prompt is held (the reason to hold one is that it
  is expensive to retype, which a command is not), and `/reload` returns first
  and reloads a second later, so both the receipt and the cursor land and a
  redelivery is recognised as already handled. `/steer` still holds — it
  carries a prompt.


## 0.14.3

First changelog entry for the 0.14 line: 0.14.0 through 0.14.2 shipped as
local builds without their own sections, so everything below has accumulated
since 0.13.20. All of it is in 0.14.3.

- **HalluScribe's six MCP schemas are demand-loaded.** They cost 2382 tokens of
  every single request — measured, `test/prompt-context-measurement.txt` — on
  conversations that never ask about a past session. A fresh conversation now
  sees one 125-token `load_tool_group` tool instead; calling it with
  `group: "halluscribe"` marks the group active and the six real schemas arrive,
  unchanged, on the next round. Net recovery on an ordinary coding
  conversation: 2382 tokens (11014 static instead of 13396). Activation is per
  conversation and in memory only — a new chat starts unloaded, and nothing is
  written to `config.yaml`. HalluScribe stays connected and dispatchable
  throughout; only advertisement changes, and no other MCP server is affected.
  `src/tools/lazyToolGroups.ts` is the sole owner of which server is lazy.

  Validated live against Qwen3.8-27B (`test/live/LazyToolGroups.live.test.ts`,
  gated on `FORGE_LIVE_LAZY_TOOLS=1`). From the 125-token description alone and
  with no prompt hinting, the model opened both history questions with
  `load_tool_group` and went straight into the real tools --
  `load_tool_group -> search_sessions -> read_session -> read_tool_result` for
  "what did we decide about the prompt cache", and
  `load_tool_group -> search_sessions -> search_raw_transcripts -> ...` for
  "find the exact llama-tokenize error". An ordinary read-package.json request
  in a separate conversation never touched it.

- **The model-facing tool list is rebuilt every round, not once per turn.**
  `ModelTurn` snapshotted `toolDefinitions` before the loop started, so a group
  activated mid-turn could not reach the request that followed — the tool would
  have reported itself enabled while the next request still omitted its schemas.
  `ToolCallingLoopOptions.toolDefinitions` is now `getToolDefinitions()`, called
  once per round; the context-budget math reads the same live list, so the
  2382 tokens are accounted for on the turn they appear.

- **Stopping the backend no longer leaks a llama.cpp port.** `stopAll()` deleted
  its slot map entries directly instead of freeing them, so every Stop,
  `/unloadModel`, `forge.stopBackend`, and `forge.restartBackend` permanently
  lost that slot's port. `freePorts` is built once in the `BackendPool`
  constructor and never rebuilt, so with `max_simultaneous_models: 4` the fourth
  stop exhausted the pool and every later load failed until the window was
  reloaded. `StopAllContext` now carries the real `PoolSlot` (its old structural
  slot type did not even include `port`, so the leak was not expressible) and a
  `freeSlot` callback. The port-accounting tests covered `release()` thoroughly
  and never called `stopAll()` once; two regression tests now do.

- **An exhausted pool no longer blames delegation.** `claimPort` threw "all
  resident models are pinned by active delegation holds" whenever `lruSlot`
  returned nothing — including when the slot table was *empty*, which is a
  bookkeeping bug rather than capacity pressure. The empty case now says so.

- **Agent questions reach whichever surface started the turn.** `ask_user` used
  to talk straight to `vscode.window`, so a question raised during a Telegram
  turn opened a box nobody was looking at, and the desktop box was dismissed by
  any focus change — the model saw `(cancelled)` for a question the user never
  received. `UserQuestionService` now owns the question, the local box and the
  remote chat race to answer it, and cancelling the turn cancels the question.

- **A prompt sent to an expired remote session is held, not lost.** The TOTP
  challenge now names its cause, holds the prompt for 10 minutes, and replays it
  with an echo once the code lands. Repeated wrong codes, `/lock`, and unpairing
  the owner all drop the held prompt.

- **`/reload` restarts the extension host from the remote chat**, and
  `remote.attachments.retain_days` accepts up to 365 days or `null` to keep
  attachments forever — previously capped at 30 with no way to disable pruning.
  Both shipped inside commit `15894f2`, whose message mentions neither; `git
  bisect` on either will point at the wrong change.

- **Auto-compaction now recovers context-exhausted remote turns.** A tool-call
  exhaustion was recorded as an incomplete turn but returned through the failed
  branch before the post-turn compaction policy ran. The shared send pipeline
  now compacts and resumes this recoverable failure for Telegram and every
  other entry surface when auto-compaction is enabled.

- **Telegram prompts can steer instead of waiting behind the queue.**
  `/steer <prompt>` is durably recorded before Forge interrupts the active turn,
  then runs ahead of ordinary queued prompts while keeping FIFO order between
  steering prompts. `/drop <number|all>` cancels queued work, `/context` reports
  remaining room, and Telegram now publishes the supported commands in its
  native command menu.

- **Remote sessions are easier to diagnose without recording content.** The
  metadata-only audit records pairing, authentication challenges/failures,
  successful authentication, locking, and steering admission. The Forge output
  log records request id, conversation id, outcome, and context use, never the
  prompt, response, bot token, TOTP code, or raw Telegram identity.

- **The full tool surface uses less starting context.** Concise schemas for the
  largest native tools preserve their arguments, constraints, safety rules,
  and capabilities while saving 475 exact Qwen tokens in the measured tool
  catalog. No tool was removed or hidden.

- **Telegram remote control now applies replaced bot credentials immediately.**
  `Forge: Set Telegram Bot Token` used to update SecretStorage and then take the
  ordinary in-place config path, leaving the active poller on the old token
  until the extension reloaded. Credential refresh now recreates only the
  Telegram transport; unrelated transports stay up.

- **TOTP-protected Telegram approvals fit the provider protocol.** The approval
  id and auth-session UUID together exceeded Telegram's 64-byte callback-data
  limit, so enabling the authenticator could make every Approve/Deny keyboard
  fail to send. Telegram now receives a short opaque handle while the Forge
  approval id and auth nonce remain server-side and are checked together.

- **Remote progress reports the real terminal state.** Failed and cancelled
  turns no longer edit their live Telegram progress row to “completed,” and a
  busy retry is labelled queued. Telegram text chunking also preserves complete
  Unicode code points at the 4,096-character boundary instead of splitting an
  emoji in half.

- **The activity line follows the editor's configured font size.** It keeps the
  intended one-pixel emphasis without freezing the webview at 14px for users
  who increase or reduce VS Code's UI font.

- **Remote control gained a complete authenticated phone workflow.** The
  optional Telegram surface now includes owner-bound Google
  Authenticator-compatible TOTP sessions, inactivity locking, conversation and
  model controls, workspace handoff, attachments, durable notifications, and
  live agent/compaction progress. It remains opt-in and uses the normal Forge
  execution, confirmation, checkpoint, and model paths.

- **The agent can read the editor you are looking at, not just write to it.**
  `replace_selection` and `insert_code` have always written into the active
  editor, but nothing could read it back — so "fix this" with a block
  highlighted gave the model no way to see what "this" was, and it fell back to
  re-reading whole files and guessing. `get_editor_context` returns the active
  file, the selected text with its one-based range, the cursor position, and the
  paths of every open tab. It is one call rather than three tools because the
  three facts answer one question, and every tool definition is prompt weight on
  each request.

- **`find_implementations` answers "who implements this?"** On an interface or
  an abstract method, `find_references` buries the handful of implementations in
  every call site. The implementation provider returns only the concrete types.
  It reads `LocationLink` as well as `Location`, the shape mismatch that broke
  `go_to_definition` on every JS file.

- **`git_show` could always read a file at a past commit; nothing said so.** The
  ref is passed straight to `git show`, so `HEAD~1:src/app.ts` has worked from
  the start — but the description said "show a commit or object" and the agent
  never tried the `<ref>:<path>` form, checking branches out instead. The schema
  now spells it out. No behaviour change.

- **`delete_file` moves things to the recycle bin instead of destroying them.**
  Every deletion went through `fs.rmSync`, so an approved mistake was gone —
  the per-turn checkpoint covers file *edits*, not a directory the agent removed
  outright. Deletions now route through `vscode.workspace.fs.delete` with
  `useTrash`, and the confirmation dialog says "About to move to the recycle
  bin" and names the deletion as recoverable. A new `to_trash: false` argument
  restores the permanent behaviour for build output and other cases where
  filling the bin is the wrong trade. Filesystems without a recycle bin —
  network shares, most remote paths — surface the failure and tell the agent to
  retry with `to_trash: false` rather than silently deleting for real.

- **The agent sees the commands you run in your own terminal, and corrects
  them.** Watching only Forge-pasted commands solved half the problem: the
  common case is the user typing a command themselves, getting an error, and
  asking the sidebar what went wrong — at which point the agent had nothing but
  the question. `TerminalCommandTracker` now records every shell-integration
  execution, keeping the last five with their exit codes and up to 4k characters
  of output each. The turn context carries the newest command plus any recent
  failures, and `execute.njk` tells the agent to name the mistake and reply with
  the corrected command rather than asking for output it already has. Commands
  are still only visible from the moment they run: scrollback and shell history
  are never read, and `forge.terminal.watchUserCommands` turns the capture off
  for anyone who would rather keep their terminal to themselves.

- **The agent can see how a command it pasted turned out.** `run_terminal`
  pastes into a terminal Forge creates and never presses Enter, so until now the
  outcome was invisible: the agent suggested a command, the user ran it, it
  failed, and the agent's only move was to ask them to paste the error back.
  `TerminalCommandTracker` registers each pasted command against the terminal it
  went to and reads the result off VS Code's shell-integration execution events,
  so the next turn carries the command, its intended and actual working
  directory, the exit code, and up to 12k characters of output. Scope is
  deliberately narrow: the listeners drop any execution in a terminal Forge did
  not create, no scrollback or terminal history is ever read, and captured
  output is labelled untrusted in the turn context. `execute.njk` tells the
  agent to consult that context before asking the user to repeat something Forge
  already supplied.

- **"Starting backend, please wait…" / "Backend ready." only appear when a
  backend actually starts.** `runLocalProviderTurn` announced the start
  unconditionally and answered it unconditionally, so every prompt in a session
  left two permanent system rows in the transcript — on a warm pool the acquire
  they described returned in single-digit milliseconds. The announcement is now
  armed on a 500 ms timer that the acquire cancels, so a cold `llama-server`
  spawn still reports itself seconds before the wait gets uncomfortable and a
  warm one says nothing. The reply is gated in the reducer rather than at the
  post site: `READY` still flips `backendReady` (it drives the composer
  placeholder and the recovered-error sweep) but appends "Backend ready." only
  for a conversation that has an open announcement, tracked per conversation in
  `backendStartAnnouncedIds`. A failed start clears it, so the error row is the
  only answer given. `CliTurn` has gated the same pair on the first prompt of a
  session all along; this is the local-backend equivalent. As a side effect
  cloud turns, which post `ready` with no backend to start, stop claiming a
  backend became ready.

- **New conversations are labelled "Untitled chat".** It is a placeholder, not
  an action, so it cannot be confused with the New chat button. `deriveTitle()`
  replaces it with the first prompt's first line. `isUntitled()` recognises
  older stored `'Chat'` and `'New chat'` placeholders too, while `displayTitle()`
  translates them at the webview boundary without a migration pass.

- **The sessions panel closes when you pick a session.** Selecting a row is a
  navigation, and leaving the accordion open hid the conversation just chosen
  behind the list it was chosen from. Both selecting actions collapse it —
  switching to an open tab and restoring a closed one — while rename and delete
  leave it open, because walking down the list should survive them. Focus moves
  back to the "All sessions" toggle: the row that had it is hidden along with
  the panel, and without the handoff focus falls to `<body>`.

- **An empty tab now says what the backend is doing.** It rendered nothing at
  all — `MessageList` mapped an empty array — so the only way to learn whether
  the model was resident was to send a prompt and wait out a possible 40-second
  load. A new tab shows the Forge mark plus the model, its residency, and the
  **per-slot** context window (`perSlotContext()`, i.e. `num_ctx / n_parallel`,
  not the over-reported total). Remote routes name their provider instead of a
  load state, because `ModelEntry.residency` is deliberately absent for them
  and rendering `cold` would advertise a VRAM cost that does not exist. This is
  the one thing Forge can put on an empty screen that a hosted-endpoint CLI
  cannot: it drives a `llama-server` you spawned, so it has facts to report.
  Deliberately says nothing about `backendReady` — that flag is global while
  conversations run independently, so a failure in one tab would otherwise mark
  an unrelated empty tab unavailable.

- **A restored tab says it was restored.** Reopening the sidebar dropped you
  mid-conversation with no indication whether that exchange was ten minutes or
  three days old. Tabs idle longer than `RESUMED_AFTER_MS` (4h) now draw a
  `resumed · 3 days ago · 12 msgs` hairline above the composer. The set is
  snapshotted once at hydration and held in state, not recomputed per render:
  `updatedAt` moves on any activity, so a live read made the marker vanish
  mid-session and reappear on unrelated syncs. Sending in a tab clears it, via
  both the ordinary send and the Steer path.

- **A queued prompt now names what it is waiting on, and its tab shows it.**
  The row read a bare `Queued`, and `App` filtered queued prompts to the active
  conversation — so a prompt queued in a background tab was *completely*
  invisible, with nothing distinguishing "waiting for the VRAM slot" from
  "hung". The row now reads `Queued — waiting on <model>`, taken from that
  tab's own `active_model` (falling back to the selected model) so a background
  tab on a different model stays honest, and the tab chip carries a static
  amber dot. The dot is deliberately not a spinner: a tab spinning while it is
  merely waiting reads as a hang. Spinner = generating; dot = waiting.

- **The sessions panel lists open tabs, not just closed ones.** The flyout
  behind the clock button showed only closed conversations —
  `historyMetasFromSession()` filters open ids out — so there was no single
  place to see which tabs were running. It now has an **Open** section fed from
  `state.tabs`, reusing the strip's own spinner and waiting dot so the two
  displays cannot disagree, above the existing **Closed** rows (restore,
  rename, delete unchanged). Open rows get no kebab: an open tab is closed from
  the strip. Zero host changes — `SessionTabMeta.streaming` already shipped.
  The badge on the clock button still counts closed sessions only, so its
  meaning is unchanged.

- Split `webview-ui/styles/sessions-panel.css` out of `tabs.css` (408 → 245
  LOC) along the real seam: the tab strip and the sessions flyout are separate
  concerns, and the panel had just grown a second section.

- **`pwsh` was not covered by the PowerShell ban.** `checkPowerShellBan`
  matched `powershell` and `powershell.exe` only, so `pwsh -Command <script>`
  -- PowerShell 7, present on any machine set up for Codex -- walked straight
  past a guard whose stated rationale is that a model-authored script cannot be
  checked by the denylist. The launcher list is now matched as a set, so a new
  PowerShell binary is a new hole rather than a variant of an old one.

- **New tool: `wait`.** Forge could wait for a *process* (`exec_command`
  background plus `monitor_execution`) but had no way to produce a delay: that
  wait resolves the instant the process exits. Asked to ping on an interval the
  agent burned two rounds hunting a sleep binary -- `powershell -Command
  Start-Sleep` banned, Windows `timeout` needing console stdin it never gets
  under `shell: false` -- before landing on `python -c "time.sleep(15)"`, which
  is luck rather than a capability. `wait` is in-process: no shell, no binary to
  be missing, capped at 15 minutes, and it honours the turn's abort signal so /stop
  never leaves a turn parked on a timer. It reports the time it actually waited,
  not the time requested. The PowerShell refusal now names it first.
- **`notify_user`: the agent can reach the chat that started the turn.** Its
  only outbound signal was `show_notification`, a VS Code desktop toast, so a
  turn driven from Telegram lit up a window nobody was looking at. `notify_user`
  is a second producer on the road auto-compaction notices already travel:
  conversationId to bindings to the durable outbox. Fire-and-forget -- no wake,
  heartbeat, or poll; an agent that needs an answer still uses `ask_user`.

  `RemoteController.enqueueHostNotification` now returns how many chats it
  reached instead of `void`. That count is load-bearing: it is what lets the
  tool say "the user did NOT receive it on their phone" rather than reporting
  success into a void, which is how `ask_user`'s bare `(cancelled)` taught the
  model to trust a lie. Capped at 5 per turn, reset on turn START via
  `onGenerationStarted` -- a cancelled turn never reaches its end, and a leaked
  counter would silently mute the agent for the rest of the conversation.

  `/notify on|off|status` mutes one chat, in memory until the window reloads,
  the same lifetime as `/clanker`. Plan: `docs/plans/NOTIFY_USER_PLAN.md`.

- **`/help` and the Telegram command menu now document `/workspace list` and
  `/new <alias>`.** Both were handled and neither was listed anywhere, so the
  only pointer to `/workspace list` was the error text you got after already
  guessing a bad alias. A capability nothing names is one that does not exist.

Plan and mockups: `docs/plans/SIDEBAR_UX_PLAN.md`,
`docs/plans/SIDEBAR_UX_MOCKUPS.html`.

## 0.13.20

- Session transcripts no longer re-write their whole history on every window
  reload. `SessionLogger` keyed its file off the persisted conversation id but
  kept `writtenCount` only in memory, so each reload built a fresh logger over
  the same file and `messages.slice(0)` appended the entire conversation again.
  One audited session held seven copies of itself — 65% duplicate rows, 14 MB
  of a 20 MB file. The cursor is now written to the file as a `cursor` row at
  the end of each flush and recovered from the tail on construction; a
  `session_start` is still emitted per run, so `forge_version` stays per build.
  Safe because `conv.messages` is append-only: compaction is non-destructive
  (it records a summary and a cut index rather than rewriting the transcript).
  This mattered beyond disk — the duplicates inflate exactly the per-tool
  failure audit CLAUDE.md tells you to run on these files, sevenfold in that
  session.

- `query_powershell` refusals now name the tool that will work. It is confined
  to the workspace on purpose — it is the one tool that runs without the
  confirmation gate — but it answered an out-of-workspace path with a bare
  "Absolute paths are not allowed", while `list_directory`, `read_file` and
  `find_files` accept those paths happily. With a workspace at
  `N:\vs code apps\Ssuno` and the actual work under `N:\AI\ComfyUI`, an agent
  spent 7 of its 9 `query_powershell` calls re-attempting the same refused
  shape after every compaction. The refusal now points at the gated file tools
  (or `exec_command` for `get_file_hash`), an absolute path *inside* the
  workspace is answered with its relative form, and the schema says so up
  front. Same rule as the `rm -rf` denylist fix: a refusal that names no
  alternative teaches the agent the capability does not exist.

## 0.13.19

- Hold the volatile turn-context block fixed for the whole turn instead of
  rebuilding it on every tool round. The block folds into the last user
  message, which on round N of a tool loop is the request that OPENED the turn
  -- so an `update_plan` mid-turn rewrote the prompt just after the system
  prompt and invalidated that turn's own rounds. Measured live on a 4-round
  turn with three plan updates: llama.cpp prompt reuse fell from 76% to 39%,
  and two consecutive rounds that grew the prompt by 186 tokens re-evaluated
  15401 of them, ~20 s of prefill each. The plan now reaches the prompt on the
  next user turn, where the prefix is being extended anyway; the model still
  sees the tool result confirming its own write.

## 0.13.18

- Volatile turn state no longer sits at the head of the prompt, where it was
  destroying llama.cpp's KV-cache reuse on every turn. The active editor file
  was rendered into the *system prompt*, and the task plan was folded into the
  *first user message* - so changing editor tabs, or an `update_plan`, rewrote
  the prompt behind the entire conversation. llama-server reuses the longest
  common prefix and re-evaluates everything after the first divergent token,
  so the whole transcript was being re-processed.
  Measured against b10430 on a 4.9K-token prompt: an append-only turn
  re-evaluated 21 tokens in 618 ms, while changing one line near the head
  re-evaluated 4971 tokens in 7605 ms - a 12x prompt-eval penalty with a cache
  hit of exactly zero. Reproduced on gemma-4-E2B (CPU) and Qwen3.8-27B (GPU).
  Both are now injected at the *latest user message* instead, by the new
  `injectTurnContext`. Everything above it stays byte-identical.
- The task plan no longer carries relative age text ("updated about 2 min
  ago"). It was re-rendered on every tool round, so a turn that crossed a
  minute boundary rewrote the prompt head *mid-turn* with nothing else having
  changed. `updatedAt` is still kept on the conversation for the UI; it just
  never reaches the model.
- Forge now logs how much of each prompt the server served from cache
  (`[cache] prompt=24610 cached=24102 (97.9%) evaluated=508`, debug level, no
  prompt contents). llama.cpp reports this directly as
  `usage.prompt_tokens_details.cached_tokens`, so a future regression of this
  kind is visible rather than inferred.
- `--cache-reuse` was evaluated as a cheaper alternative and rejected: it is
  disabled by llama.cpp itself for both gemma (sliding-window) and Qwen3.8
  (hybrid/recurrent) on b10430 and b10621 alike, since neither architecture
  supports KV shifting. No config knob was added for a flag that silently does
  nothing.

## 0.13.17

- Switching a conversation that contains images to a projector-less model no
  longer kills the turn. The vision gate only ever checked the *new* prompt's
  attachments, so with nothing freshly attached it was a no-op and the
  `image_url` parts already in history — from an attachment, `view_image`, or
  `view_video` — went on the wire anyway and came back as
  `HTTP 500: image input is not supported`. The conversation stayed dead until
  the images were cleared or the window reloaded. Images are now replaced with
  an explanatory note in the model-facing copy only; `conv.messages` keeps the
  pixels, so switching back to a vision model restores them. Covers llama.cpp,
  Ollama and cloud in one place, because the strip happens at the single
  `prepareMessages` choke point.
- The strip is never silent. Every turn it happens posts a `notice` row in the
  transcript naming the model, the number of images affected, and the
  `capabilities: [vision]` / `mmproj_path` line to add if the model actually is
  multimodal — plus a once-per-model toast for the user who just switched in the
  picker and is not reading the transcript. It also says the remedy expires at
  the next window reload, because base64 has never been written to
  `workspaceState`: switch models first, or the images are gone either way. Silence here has two failure modes,
  both of which look like a broken model rather than a config fact: the model
  says it cannot see an image that is visibly sitting above it, or it guesses at
  one and nothing is left to contradict the guess.
- `HTTP 500: image input is not supported` is now translated at the client into
  a message naming the model and `mmproj_path`, on both the non-2xx response
  path and streamed SSE error frames — the same treatment truncation parse
  errors already got. Only the response path reports an HTTP status; a stream is
  already 200 and has none to report.
- A reloaded conversation now says that it lost its images, which affects
  vision models exactly as much as text-only ones: image data has never been
  written to `workspaceState`, so a restored transcript carries a note where its
  pixels used to be. Previously the model would correctly ask for a re-attach
  while the user saw only a bracketed note in their own message and no
  explanation — the same "looks like a broken model" shape as the capability
  case, triggered by a reload instead. Announced once per conversation per
  session, because unlike a model switch there is nothing the user can do to
  undo it. Unloading a model does not trigger this; only a window reload,
  extension host restart, or reopening the workspace does.
- New optional per-model `image_retention_turns` ages images out of long
  conversations even on a vision model, where they otherwise occupy the
  per-slot context forever (worst with `view_video`, which injects N frames at
  once). It counts later **user** messages, not protocol messages, so a
  tool-heavy round cannot evict an image you just attached, and the note says
  how to get the image back rather than implying it is gone. Omitted means
  never age out, which stays the default — there is no implicit fallback.

## 0.13.16

- A background job that prints nothing no longer costs the turn. `monitor_execution`
  now returns `suggested_next_wait_ms`, a geometric backoff (10s → 20s → 40s → 60s)
  derived from the *requested* wait, that resets to 10s the moment new output
  appears. The agent has to stay parked inside a live turn to observe a background
  job — Forge has no auto-wake, by design — so every poll spends one of the turn's
  `max_tool_rounds`. At the old 10s default a 20-minute download cost 120 rounds and
  the turn died waiting; at the ceiling it costs 20. Once the ladder leaves the
  default, a `silence_note` also says why silence is not evidence of a stall
  (progress bars redraw with a carriage return and never reach a pipe) and where to
  look instead.
- `list_directory` now reports each entry's size and how long ago it was modified,
  so "is this job still making progress?" is two calls and a comparison rather than
  a hand-written `python -c` with `os.path.getmtime`. Directories over 500 entries
  are listed without metadata and say so. `list_directory` moved to
  `src/tools/listDirectoryTool.ts`; `dirTools.ts` keeps the two ripgrep-backed
  search tools.

## 0.13.15

- Delegation to an Ollama model whose `provider` is inherited from a `group`
  works again. `BackendPool.isOllamaModel()` scanned the raw `config.models`
  entry, but group merge runs at request time only, so every such model was
  classified as llama.cpp: gated on a free llama-server slot it did not need,
  reported as a guaranteed rather than best-effort hold, and — with
  `shared_runtime` enabled — dragged into the shared-runtime key derivation,
  which composes a llama-server argv and threw `missing gguf_path for llama.cpp`
  before the daemon was ever contacted. That last path made `ask_local_agent`
  delegation to those models fail outright. Confirmed live against a running
  daemon, pre- and post-fix (`test/live/OllamaGroupDelegation.live.test.ts`,
  gated on `FORGE_LIVE_OLLAMA=1`). The classifier is group-resolved now, the
  same fix `ControlModelCatalog.entryFor` already carries for the identical
  defect.

- The command-palette model picker resolves `provider` through the model's
  group too. It read the raw entry, so a grouped model was labelled
  "llama.cpp" in the quick pick and, on selection, handed to the backend pool
  — a grouped `provider: cli` agent or cloud model would have been routed as
  a local llama.cpp load instead of being recognised. Third instance of the
  same raw-scan defect.

- An expanded tool result only renders as Markdown when the tool actually
  returns prose. `read_file`, `exec_command`, `git_diff` and everything else now
  render verbatim in a monospace block, because their output is not prose: a
  `# comment` line in `config.yaml` was being parsed as an H1, and since nothing
  in the stylesheet sized headings, it painted at the browser default 2em inside
  a 12px row. Reading a commented YAML or shell file turned the transcript into
  banners. `rendersAsMarkdown()` in `src/sidebar/toolResultView.ts` owns the
  split — an allowlist, so a tool added later renders verbatim by default rather
  than exploding. Headings are also sized now, in both the tool body and the
  assistant message body, so a delegated agent's `# Report` stays proportionate.

- The streaming status line now deals its phrases from a shuffled bag instead of
  drawing one at random each rotation. With 26 phrases in the local + Clanker
  pool and a 12s hold, independent draws needed roughly 100 picks — about twenty
  minutes of unbroken streaming — before every phrase had shown once, so the
  rarer ones went unseen for days. The bag deals each phrase exactly once per
  cycle and persists across turns, which is the part that matters: most turns
  are short enough to show two or three phrases, so a deck reset per turn would
  never get past the top. Each pool composition keeps its own deck, so toggling
  Clanker Mode or switching to a cloud model does not discard progress through
  the other one, and the rotation still never repeats the phrase on screen.

- A compaction summary now carries what the agent *did*, recorded by Forge from
  the tool calls rather than described by the summarizer. Every entry is
  classified from its paired tool result: a write that failed reads `FAILED`, a
  write whose result never arrived (the normal state for a compaction that
  fires mid-turn) reads `ATTEMPTED … outcome unknown`, and commands carry their
  exit codes — `ran \`npm run ci\` → exit 0`. Previously a resumed agent had only
  model-written prose, could not tell a claim from a verified fact, and re-read
  the files to find out; that re-verification is the cost this removes. The
  classifier uses Forge's own result contract (`Error:`, `User declined:`, both
  ToolBudget refusals, the reload marker), because a check for `Error:` alone
  would have reported a user-declined write as a completed one.
- Compaction also records the working tree: unstaged, staged, and
  `git status --short` together, so untracked files and staged work are visible
  — a plain `git diff --stat` shows neither, and an agent that had just created
  and staged three files would have read an empty diff and concluded nothing
  happened. The three commands run concurrently, are bounded at 3s, and a
  failure returns nothing rather than losing the summary.
- New `update_plan` tool: the agent's task list is now conversation state
  rather than transcript text, so a compaction cannot summarize it away. It is
  re-injected verbatim each round (after the system prompt, never between an
  assistant's tool calls and their results), bounded at 20 items × 200 chars,
  auto-approved so marking an item done is never gated behind a confirmation,
  and persisted for live *and* archived conversations. Worst case after a
  compaction is one stale item instead of a plan rebuilt from prose.
- The post-compaction resume prompt no longer says "do not redo work" — a
  prohibition a model breaks the moment it feels uncertain. It now points at
  the host-recorded blocks and permits verification exactly where they are
  silent: entries marked FAILED or unknown.

## 0.13.14

- `ask_local_agent` can now delegate to a configured cloud model (xAI,
  OpenRouter, OpenAI-compatible) and to Ollama cloud-routed models. The old
  block was a VRAM-capacity rule applied to targets that hold no local slot, so
  the agent's only route to OpenRouter was curl'ing the control server's
  `/chat` proxy through the terminal. Cloud targets skip the backend hold
  entirely — a second opinion now works *while* the local slot is busy — and
  get a 300s timeout instead of the 120s sized for a resident local model. A
  non-local Ollama endpoint is still refused; Forge holds no auth for someone
  else's daemon.
- `ask_local_agent` now names its callable targets in its own schema. The
  `model` arg was a bare string with no list anywhere — not in the schema, not
  in the system prompt, and no tool enumerates models — so the only way to
  learn that `qwen/qwen3.8-max` is a legal value was to read config.yaml, ~9k
  tokens of context spent before the first delegation and a standing invitation
  to invent model names. The hint costs ~300 tokens and is rebuilt per turn, so
  a model added to config.yaml appears without a window reload.

## 0.13.13

- Model name is centred in the picker. The chevron is out of flow so it no
  longer pulls the name off-centre, and its lane stays reserved so a long name
  ellipsises before reaching it.

## 0.13.12

- Streaming status line is larger (0.78em -> 0.92em) with a matching 7px dot; it
  sat below comfortable reading size for an ambient line.
- New phrases: "Something smells burned..." (local) plus a route-agnostic shared
  pool, "Sloppy coding..." and "No code for you...".
- Removed the three bouncing dots from the transcript. They stated the same fact
  as the streaming line above the composer, which stays put while the transcript
  scrolls, so the dots were duplicate motion in a worse place.

## 0.13.11 - slower phrase rotation

- Streaming phrases rotate every 12s, up from 6s. The line sits under the text
  you are reading, and anything quicker pulls the eye to it.

## 0.13.10 - stop the idle dot blinking, slow the phrase rotation

- **The blue dot blinked forever, even with nothing running.** It was hidden
  with `opacity: 0` while a keyframe animation drove that same property, and a
  running animation outranks normal declarations in the cascade — so the idle
  rule never applied. The dot is now hidden with `visibility`, and the
  animation is attached only while a turn is streaming.
- **Phrases rotate every 6s instead of 3.5s.** At 3.5s the line pulled the eye
  away from the text it sits under, which is the opposite of what an ambient
  indicator is for.

## 0.13.9 - one streaming line, and it has opinions

- **The status line rotates through a pool of phrases.** With no spinner glyph
  a fixed line sits motionless for the length of a cold model load, and a
  motionless indicator cannot tell working from hung — so the rotation is the
  liveness signal, not decoration. Local turns talk about your own hardware
  ("Melting VRAM…", "Heating the room…"); Clanker Mode adds its own set.
- **Cloud turns get their own pool** ("Burning credits…", "Renting a GPU…").
  Claiming local VRAM load during an xAI or Ollama-cloud call would undercut
  the residency signalling the picker now does honestly — and the wording
  quietly tells you when a turn went to the wrong model.
- **No phrase claims progress.** "Almost there" is unknowable, so nothing in
  any pool says it. A unit test enforces this.
- **The line no longer moves the page.** It kept its own bordered strip that
  appeared on stream start and pushed the composer down exactly as text began
  arriving. It is now always mounted at a reserved height, borderless, and
  clips rather than wraps when the sidebar is narrow.
- **Screen readers get a fact, not a joke every 3.5s.** The rotating text is
  aria-hidden; a stable "Generating" lives in the live region instead. The
  blinking dot honours prefers-reduced-motion.
- Removed the dead header typing-dot indicator, which had been display:none
  but still expanded the header row on every turn.

## 0.13.8 - the model picker says whether your next send pays a cold load

- **Readiness dot in the model picker.** Picking a model only *pins* it; the
  llama-server spawn happens on your first send. On a single-slot card that
  means the next turn can evict what is resident and spend tens of seconds
  reading weights, with nothing in the UI saying so beforehand. Each local
  model now shows solid (loaded and ready), hollow-pulsing (resident, still
  starting) or dim (cold — the next send loads it).
- **No dot for remote models.** Residency is meaningless for a model Forge does
  not host, Ollama *cloud* included — it reaches the daemon on localhost but
  holds no VRAM here. Showing those as "cold" would advertise a load cost that
  does not exist, so they get no dot at all.
- The dot is polled, not pushed, and lags reality by at most 1.5s. Slot state
  mutates in nine places across five files; a signature compare cannot rot the
  way an emit call that someone forgets to add can. It only runs while the
  sidebar is visible. See `docs/plans/MODEL_READINESS_DOT_PLAN.md`.

## 0.13.7 - rename a chat from the history row; model picker by the prompt

- **History rows can be renamed.** The only control on a row was a 12px trash
  icon held at opacity 0 until hover — a permanent, unrecoverable action that
  was invisible until the cursor was already on top of it. Rows now carry a
  kebab at half opacity in a real 28×28 target, opening Rename / Delete. Rename
  edits in place (Enter commits, Escape cancels); delete still routes to the
  existing modal confirm. Renaming leaves `updatedAt` alone, so a cosmetic edit
  does not reorder history.
- **Closed chats are renameable at all.** `/rename` only ever retitled the
  *active* conversation, so an auto-derived title like "hello man" could not be
  fixed once the chat was closed without restoring it first.
- **The model selector moved to the composer**, next to the prompt where the
  choice is actually made — it previously sat above the tab strip, the history
  panel and the whole scrolled transcript. The dropdown opens upward. The token
  budget stays in the header: it is ambient status that has to stay readable
  while scrolling, not only when you look down to type.
- **The history list stops slicing a row in half** at the scroll boundary.

## 0.13.6 - say what happened to missing output

- **"Capped, call again" and "gone for good" are no longer the same flag.**
  `stdout_truncated` meant both, so an agent could not tell whether more output
  was waiting or whether it had permanently missed some. Given a 4.7 MB job it
  guessed wrong, decided the cursor API was broken, and fell back to writing a
  file. `monitor_execution` now reports `stdout_more_available` (keep calling)
  separately from `stdout_dropped_chars` (that much is unrecoverable), plus
  `stdout_oldest_available_cursor` so the retained window is visible rather
  than something to infer from cursor arithmetic.
- **A dropped-output note names the way out.** When the retention cap has eaten
  part of a stream, the result carries a note saying how much went, where
  reading resumed, and that redirecting to a file is the way to capture a noisy
  job from the start — instead of leaving the agent to work that out and lose
  confidence in the tool on the way.

## 0.13.5 - background execution reporting fixes

- **Truncated output can be read to the end.** `monitor_execution` capped the
  output it returned but reported the next cursor as the end of the whole
  stream, so everything the cap held back was unreachable: `stdout_truncated`
  told the agent it had missed output and then gave it no way to fetch it. The
  next cursor is now computed from what the call actually returned, so repeated
  calls page through the retained buffer. `tail_lines` still consumes to the
  end, since a caller asking for the tail does not want to resume mid-buffer.
- **`waited_ms` is measured, not requested.** It echoed the `wait_ms` budget
  even when the process finished — or the turn was cancelled — a fraction of
  the way in, which made it impossible to tell a prompt return from a full
  wait, including when checking whether cancellation worked at all.
- **Execution timestamps say they are UTC, and elapsed time is reported
  directly.** `started_at` / `finished_at` are now `started_at_utc` /
  `finished_at_utc`, and both `list_executions` and `monitor_execution` carry
  `ran_for_ms`, so "how long has this been running" no longer requires
  subtracting two ISO strings against a clock three hours off.

## 0.13.4 — video frames, background execution follow-ups

- **`view_video` extracts frames for vision models.** A new tool pulls frames
  via ffmpeg (`ffmpeg_path` and `frame_max_dimension` under a new `video:`
  config block) so a vision-capable model can look at a clip. Models without
  vision get an explicit unavailable message naming the model rather than a
  silent no-op.
- **Every spawned process now gets an upper-case Windows drive letter.** VS
  Code's `Uri.fsPath` lower-cases it, so a workspace on `N:` reached `spawn` as
  `n:\...`. Node runs that fine, but tools resolving module ids against `cwd` —
  anything on Vite — key the same file under two spellings and load two copies
  of their own module graph. `npx vitest run` failed all 140 files at `describe`
  with "Cannot read properties of undefined (reading 'config')", which reads as
  a broken test suite and was a broken path. Normalising happens at the spawn
  itself, so it covers every tool, not just `exec_command`.
- **Background executions can no longer run forever unnoticed.**
  `exec_command` now honours `timeout_ms` when `background: true`, arming a kill
  deadline that reports `terminated` with the elapsed limit in `error`. There is
  deliberately no default deadline in background mode — inheriting the 30s
  foreground default would have killed every long job it exists to support — so
  the schema now states both halves of that rule.
- **`list_executions` recovers a lost `execution_id`.** The agent's own record
  of an id does not survive a `/compact`, which left a running job unreachable
  and unstoppable until the window closed. The new tool lists every execution
  the session still knows about, with status, pid, cwd, and exit code.
- **`stop_execution` no longer prompts.** Stopping a job the agent itself
  started is less risky than starting it was; gating the stop harder than the
  start only added friction.
- **A background command that fails to launch says so immediately.** The status
  was read in the same tick as the spawn, before Node reports a failed launch,
  so a process that was already dead came back as `running`.

## 0.13.3 — image handling, permission visibility, and an explicit risk statement

- **The README states the risk in plain language.** A new "Responsibility and
  Risk" section says the authors accept no responsibility for lost work,
  deleted files, destructive commands, or unwanted git operations, restates the
  Apache 2.0 AS-IS terms, and lists what each safety measure does and does not
  cover. The example config carries a short pointer to it.
- **The shipped example config no longer trips its own deprecation warning.**
  It set `permissions.agents.cloud_workers`, removed in 0.13.0, so every user
  copying it got a warning toast on first load. It also now documents `groups`
  (referenced by a model in the file but never defined), `model_dirs` (empty
  means the model browser scans nothing at all), `custom_instructions`, and
  `log_level`, and states that `net.search: true` does nothing without a
  `search:` block.
- **A partial `permissions` block no longer switches capabilities off in
  silence.** Naming any one group makes the schema defaults authoritative for
  every other group, so adding `fs.delete` to grant one tool also revoked
  `web_search`, and `net.fetch` stayed off because nobody knew to set it — the
  only symptom either time was a tool missing from the model's list, which
  reads as a broken model rather than as config. Forge now warns at config load
  and names the exact keys to set, once per distinct message per session.
- **`read_file` no longer decodes binary files.** It read every path as UTF-8
  with no size cap, so a 1.3 MB PNG returned roughly 1.3 million replacement
  characters and could exhaust a single-slot context in one tool result. It now
  refuses binary content, names `view_image` when the file is an image, and
  caps text reads at 120,000 characters with an instruction to re-read a
  narrower `start_line`/`end_line` range.
- **A model without a vision projector is told why it cannot see images.**
  `view_image` was only withheld from the advertised tool list while remaining
  in the registry, so a model calling it blind would still ship base64 to a
  backend with no projector, and a model that never saw it went looking for a
  substitute. The call is now refused at dispatch with the reason and a pointer
  to switching models.
- **A prompt sent with an attachment survives a reload.** Persistence extracted
  text only for `role: 'tool'` messages, so a user turn carrying an image had
  array content, failed the string test, and was dropped whole — losing what the
  user had asked along with the picture.
- **Restored image results no longer read as intact successes.** Image data is
  deliberately never written to workspace state, but the reloaded transcript
  still said `Loaded image ...`, inviting the model to describe something it
  could no longer see. Restored turns now carry an explicit note that the image
  is gone and must be re-loaded.

## 0.13.2 — Open VSX release audit

- **The complete dependency audit is clean, including development tooling.**
  Upgraded Vitest and its V8 coverage provider to 4.1.11, esbuild to 0.28.2,
  and the transitive Vite toolchain to patched releases. The migration keeps
  the full test suite and coverage thresholds intact, updates the Vitest
  configuration to native ESM, and adapts a constructor test double to Vitest
  4's JavaScript constructor semantics. `npm audit` now reports zero
  vulnerabilities across production and development dependencies.
- **Production dependency audit is clean.** Updated `js-yaml` and the MCP SDK
  to patched releases, including their URL parsing and HTTP-server transitive
  dependencies. `npm audit --omit=dev` now reports zero vulnerabilities.
- **Delegation and privacy documentation matches the shipped behavior.** The
  README now distinguishes tool-free local-model delegates from read-only CLI
  delegates, removes the last reference to deleted CLI workers, and discloses
  that an explicitly invoked authenticated CLI uses its own network settings.
  The public tool-coverage matrix was regenerated from the current 48-tool
  catalog, removing retired worker tools and access columns.
- **The VSIX contains only release assets.** Removed a duplicate root logo,
  unused palette previews, and an unused SVG logo source from the package. The
  resulting archive contains no source, tests, local configuration, machine
  paths, source maps, or credential-shaped strings.
- **Forge's local-model wedge is clear at first glance.** The README now leads
  with first-class llama.cpp/GGUF control, local-model tool reliability, and
  reversible Keep/Undo checkpoints; Marketplace metadata uses the same
  concrete positioning. Open VSX is documented as an installation source, and
  development guidance uses the canonical `npm run ci` and `npm run package`
  gates.
- **The HTTP streaming smoke test no longer depends on a lucky ephemeral
  port.** Its loopback server retries ports that Fetch classifies as unsafe,
  eliminating a Windows CI failure that appeared only when the OS selected one
  of those otherwise-free ports.

## 0.13.1 — Shared-runtime reliability and worker removal

Supersedes 0.13.0, which was never published. The entries below marked *(found
in smoke testing)* came out of the manual two-window validation rather than the
automated suite — worth noting, because none of the 952 tests caught them.

- **Stop cancels the generation instead of killing the server** *(found in
  smoke testing)*. The Stop button aborted the request and then SIGTERM'd
  llama-server, so cancelling one generation cost a full model reload. Under a
  shared runtime it was worse: the owning window's Stop tore down the server a
  second window had borrowed, silently. Closing a tab took the same path.
  Aborting the request is what ends generation; backend teardown belongs to
  unload and eviction.
- **Re-borrowing no longer leaks the previous lease** *(found in smoke
  testing)*. Re-attaching to a restarted server took a second lease without
  releasing the first, leaving a lease file naming a live process — which
  blocked the owner from ever unloading. The exact failure shared leases exist
  to prevent, reached by a different route.
- **Window close no longer calls `stop()` on borrowed backends** *(found in
  smoke testing)*. It relied on `stop()` throwing into a swallowed catch, and
  skipped attachment-state cleanup. The borrower path is now explicit.
- **`forge.logLevel` is read again** *(found in smoke testing)*. The setting was
  contributed and shown in the settings UI but wired to nothing; only
  `config.yaml`'s `log_level` had any effect.
- **One llama-server output channel, not one per backend** *(found in smoke
  testing)*. Each backend created its own identically-named channel and nothing
  disposed them. Servers now announce themselves with a banner naming the model
  and port.
- **Repository instructions no longer name removed tools** *(found in smoke
  testing)*. `FORGE.md` still told the model to call `dispatch_workers`, costing
  a turn per delegation while it worked out the tool did not exist.

- **Releasing a borrowed model no longer strands the owner.** A runtime
  borrowed from another Forge window is now detached rather than stopped, and
  its lease is released even if detaching fails. Previously the release threw
  before cleanup, leaving a lease that blocked the owning window from ever
  unloading the model.
- **Leases from crashed windows are reclaimed.** Lease files record a PID and
  are discarded when that process is gone or the file is malformed, so a
  force-killed or crashed borrower no longer pins another window's VRAM
  indefinitely.
- **A borrowed runtime now counts as ready.** A window whose only backend was
  borrowed reported the model as loaded but not ready, so the status bar and
  the prompt gate disagreed about the same usable endpoint.
- **Worker dispatch is removed.** `dispatch_workers` and `list_worker_models`
  are gone, along with the coordinator/worker role split, its per-role
  permission and path policy, and the `Forge: Dispatch Workers` command.
  Delegation is unaffected: `ask_local_agent` still asks a second local model
  or an external CLI agent (Claude, Codex) for an opinion.
  `permissions.agents.cloud_workers` remains valid in `config.yaml` so existing
  configurations keep loading, but it grants nothing and Forge warns once at
  startup when it is present.

## 0.12.49 — Reliable resumes, Git batches, and repository instructions

- **Host-initiated turns always expose Stop.** The shared send pipeline now
  announces every accepted turn, including automatic post-compaction resumes,
  and a restored webview recovers busy conversations from the host session.
- **`git_stage` accepts multiple paths from one repository.** Repository
  selection uses one Git API snapshot and compares normalized roots instead of
  wrapper-object identity, while still rejecting genuinely cross-repository
  batches.
- **The context bar follows llama-server's occupied-token counter.** Completed
  local turns retain exact prompt-plus-completion usage, including thinking,
  instead of jumping back to a character estimate after the response lands.
- **`FORGE.md` is Forge's canonical repository instruction file.** It is
  preferred over `AGENTS.md`, resolved per nested repository, injected into
  Forge-native worker prompts, generated by `/initForge`, and—when
  `forge_instructions.auto_create` is enabled—created non-destructively in each
  Git repository VS Code discovers. `AGENTS.md` remains a compatibility
  fallback.

## 0.12.47 — Search, the round cap, and the tools that were quietly failing

- **`search_code` stopped returning its own index instead of your code.** Three
  faults compounded. `.forge/` was never excluded, so the embeddings index — a
  verbatim copy of every indexed chunk — matched nearly any query; being a
  dot-directory it was also the *first* thing ripgrep reached. The exclude globs
  were root-anchored (`!.git/**`), so a monorepo's `subproject/.git/` and nested
  `node_modules/` were searched anyway, while `find_files` had always excluded
  them recursively. And the 50-line output budget was global, so whichever file
  came first spent all of it. Measured on a real workspace, a search for
  "pickup" returned fifty lines of index JSON and not one source file. Excludes
  are now recursive and cover `.forge/`, and a per-file snippet cap stops any
  single file from starving the rest.
- **`web_search` is reachable again — the permission, not the key, was hiding
  it.** `permissions.net.search` defaults to `false`, and once a `permissions`
  block exists at all those schema defaults are authoritative. Any config with
  an `exec` or `agents` group but no `net` group therefore filtered `web_search`
  (and `web_fetch`) out of the advertised tool list entirely, so the model
  truthfully reported having no web search tool — with a valid API key sitting
  in SecretStorage the whole time. Enable it with `permissions: { net: { search:
  true } }`.
- **Web search now authenticates the way Tavily documents.** The key moved from
  an `api_key` body field to an `Authorization: Bearer` header, and a 401 now
  says the key was *rejected* rather than implying it was missing. This is a
  cleanup, not a bug fix: verified against the live API, Tavily still accepts
  the undocumented body form, so a 401 from either form means the key itself is
  bad — check the key before suspecting the transport.
- **The context bar is calibrated against the tokenizer instead of a guess.**
  Chars-per-token was 4, the English-prose figure; measured against llama-server
  on 200,000 chars of real transcript, this workload runs 3.15. The system
  prompt was counted as a flat 200 tokens when the rendered template alone is
  659, because `injectSystemPrompt` builds it outside the message array the
  estimate walks. And reasoning was counted despite never being sent to the
  model — on an agentic turn that is a whole thinking budget of phantom tokens
  per round. The first two pushed the bar low and the third pushed it high, so
  each previous fix appeared to help and then drifted. This matters beyond the
  display: `auto_compact.at` and the 75% warning are fractions of this number,
  so a bar reading 0.85 was really nearer 0.95 of the window.
- **The Stop button survives an automatic compaction.** Compaction posts `done`
  in its `finally`, which clears the webview's streaming state, and the resume
  that follows is host-initiated — so it produced no `USER_SEND` either. The
  resumed turn generated with Stop hidden and only Send showing, leaving no way
  to cancel a turn that was still running. It looked random because auto-compact
  fires on a threshold, not on anything you did.
- **A refusal on one tab no longer disarms another.** `SendPipeline`'s guard
  errors were unaddressed, and the webview resolves an unaddressed message
  against the active tab — clearing *its* streaming state. A background
  conversation refusing a send hid the Stop button on whatever tab you were
  looking at.
- **Running out of tool rounds no longer throws your work away.** The loop
  *threw* at the cap, which discarded the turn's text and left nothing in the
  transcript to say the turn had been cut short — so the next request re-planned
  from a history that looked complete. It now returns, records the stop as an
  assistant turn, and keeps every edit the capped rounds landed.
- **The tool-round cap is configurable.** `max_tool_rounds` on `defaults`, a
  group, or a model — set it once on `defaults` to cover every model
  (built-in default 40, hard ceiling 400) replaces one constant that had to serve both a
  chat turn and a multi-file refactor. Measured on a real session: a turn that
  made 28 successful edits was killed at 40 rounds with the refactor half done.
  The cap's job is to bound a runaway loop, not to decide how big a task may be.
  Hitting it now says so, and names the setting.
- **Tool paths say what they resolve against.** Every `path`, `cwd`, and
  `include` resolves against the workspace root — but nothing said so, and a
  task pointed at a repository *nested* in the workspace ("you are working in
  .../Qwen testing/threejs-game-prompt") would ask for `BUGS.md` and get a bare
  ENOENT naming a path it never chose. The contract is now stated in the system
  prompt and in the tool schemas, including that `search_code` and `find_files`
  already return paths in the accepted form.
- **`edit_file` can apply several edits in one call.** One edit per call is one
  *round* per edit, and rounds are the scarcest thing a turn has: 616 calls
  across recent sessions at an average of 1.62 tool calls per round, against a
  40-round budget. Pass `edits: [{old_str, new_str}, ...]` to change one file in
  a single call. Edits apply in order and all-or-nothing — a miss on any one of
  them leaves the file untouched rather than half-written.
- **`read_file` can number its lines.** `apply_line_edits` wants 1-based line
  numbers and verbatim `expected_lines`, but nothing could produce them: the
  only way to read a file returned bare text, so the model counted lines itself
  and failed **14 of the 19 times** it tried. `numbered: true` prefixes each
  line with its real number, ranged reads included.
- **`find_files` uses ripgrep, like `search_code`.** It used VS Code's indexed
  search service, which on a workspace held on a mapped network drive reported
  "no files match" for paths that plainly exist and are not ignored —
  `threejs-game-prompt/package*.json` among them, **16 failures in 42 calls** —
  while `search_code` was returning those very paths from the same root. Two
  file-matching tools backed by two engines could disagree about what the
  workspace contains. Now there is one engine, one root, one glob dialect.
- **A repeated tool name is no longer concatenated into an unknown one.** Only
  `arguments` is streamed in fragments; the name arrives whole. Appending every
  name delta assumed otherwise, so a provider that repeats it on each chunk
  produced `search_codesearch_code` — dispatched as an unknown tool, and a
  wasted round, every time (measured on `gemma4:31b-cloud`).
- **The `rm -rf` rule no longer refuses scoped deletes.** Its pattern ended in
  `-?[fF]` with the hyphen optional, so any bare "r" in a later filename
  satisfied it: `git rm -f README.md` was refused while `git rm -f notes.txt`
  was allowed. Recursion and force must now both be present as real flags,
  short or long. Every destructive form stays blocked, with tests to prove it.
- **The denylist covers the git commands that actually destroy work.** It
  blocked `git reset --hard` — which the reflog can undo — while allowing
  `git checkout -- .` and `git restore .`, which delete uncommitted changes with
  no confirmation and nothing to recover from. Also now refused: `git push` (any
  push is outward-facing, not only a forced one), `rebase`, `branch -d/-D`,
  `stash drop/clear`, `filter-branch`, and `reflog expire`. `git checkout
  <branch>`, `restore --staged`, `stash pop`, `add` and `commit` stay allowed —
  git itself refuses a checkout that would clobber local edits, so that is not
  the hazard, and a denylist that refuses ordinary work just teaches the agent
  to route around it.
- **A blocked command names the sanctioned route.** `delete_file` went uncalled
  across roughly three thousand tool calls while the agent reached for shell
  deletion and got a bare refusal. Refusals now say what to use instead.
- **`exec_command` stopped refusing ordinary one-liners.** The shell-operator
  guard matched `&&`, `;`, `|`, `` ` ``, `>`, `<` as *substrings* of an
  argument. Commands spawn with `shell: false`, so those characters reach the
  program verbatim and no shell ever sees them — the check prevented nothing and
  blocked a great deal: `node -e "for(let i=0;i<50;i++)console.log(i)"` was
  refused for containing `;` and `<`, which rules out most one-liners, every
  arrow function, every comparison, and every JS template literal. It now
  matches whole argument tokens, which is the thing actually worth catching:
  a model writing a shell line and handing over the pieces as argv.
- **`git_blame`, `git_show`, and `git_diff` on a path find the repository.**
  They spawned git in the workspace root while `git_status` and `git_log` went
  through VS Code's Git API, which *discovers* repositories. In a workspace
  whose repo sits one directory down, half the git tools worked and half
  answered `fatal: not a git repository`. All of them now resolve the repo —
  preferring the one containing the file, so several repos in one workspace
  blame the right one.
- **`go_to_definition` works on JavaScript again.** `executeDefinitionProvider`
  is typed as returning `Location[]`, but VS Code lets a provider answer with
  `LocationLink[]` — and the JS/TS server does. Reading `loc.range.start` on one
  threw `Cannot read properties of undefined (reading 'start')` on every JS
  file. `find_references` was never affected; its provider returns real
  Locations.
- **Session logs keep the reasoning on tool-call turns.** `ToolCallingLoop`
  deliberately carries each round's thinking onto the assistant message, and
  `SessionLogger` dropped it for exactly the turns that have `tool_calls` — the
  turns where the model decides what to do, and where it goes wrong. A 56-round
  session persisted thinking for one turn, the last. Reviewing why an agent
  spiralled meant reading its tool calls and guessing at the reasoning behind
  them. A turn that produced only reasoning is now kept too, instead of being
  skipped for having no content.
- **Language-intelligence tools open the file before asking about it.** VS Code
  providers analyse open documents; a file nobody has opened can report no
  symbols and no hover while plainly containing them — `get_document_symbols`
  answered "No symbols found." for a file whose `export class Game` a text
  search found on line 32. All the path-taking LSP tools now prime the document
  first, and a file that cannot be opened still reaches the provider rather
  than failing on the preparatory step.
- **`insert_code` and `replace_selection` name the file they wrote to.** Both
  target the *active editor* — whichever file the user has focused, which the
  model can neither choose nor inspect — and both replied "Inserted at line 0."
  with no indication of where. A write landing in an unrelated file left nothing
  in the transcript to show it. Their descriptions now say so plainly and point
  at `edit_file`, which takes a path.
- **`run_tests` and `run_build` take a `cwd`.** Both hardcoded the workspace
  root, so in a workspace holding several projects they looked for a
  `package.json` that was never there and failed with a bare ENOENT naming a
  path nobody had chosen. The error now names the directory it searched.
- **A search that finds nothing says why it might not have.** `search_code` is a
  literal search, so a regex like `\.heal\(` cannot match however much of it is
  in the file — and "No matches found" reported that identically to a term that
  is genuinely absent. The miss now names the search mode and the glob it used.

## 0.12.45 — Post-refactor audit fixes

- **A backend that was still starting no longer costs you thinking for the whole
  session.** The capability probe is cached per model, but a probe that failed
  degraded silently to name heuristics — and that degraded verdict was what got
  cached. A thinking-capable model raced at the first turn of a session ran the
  rest of it without thinking kwargs, warned you it did not support them, and
  only recovered on a config change. Degraded answers are now evicted so the next
  turn re-probes; concurrent turns still share one probe.
- **Workspaces whose paths contain `..config` or `..cache` work again.** The
  canonical containment check tested for a `..` prefix rather than a `..`
  segment, so any first path segment merely *beginning* with two dots read as
  traversal and every tool refused the file with "Path is outside the
  workspace". Containment now has one owner, `util/pathContainment.ts`.
- **The last turn before you close the window is recorded.** `last_used` writes
  were debounced 2s with nothing to flush them, so closing within that window
  lost the turn — the exact case the Model Manager's usage view exists to show.
  `deactivate()` now flushes.
- **CI evaluates the bundle, not just the types.** Circular-import and
  module-scope failures type-check clean and only appear on load, which is
  precisely what module reshuffling creates. `npm run ci` now loads the built
  bundle under a stubbed `vscode`.
- Full record in `docs/archive/validation/POST_REFACTOR_AUDIT.md`, including what came back clean and
  the two items left for a decision (coverage-threshold enforcement, oversized
  docs).

## 0.12.44 — Compaction stops leaving the agent stale

- **Auto-compact can now resume the turn it interrupted.** Compaction used to
  end at a notice: the agent parked mid-task holding nothing but a summary, and
  you had to notice and re-prompt. When the previous turn was actually cut off —
  output limit, exhausted context, or the 40-tool-round cap — Forge now
  continues it. A turn that finished cleanly is left alone, `/compact` never
  resumes, and no more than two resumes happen without a prompt from you.
  Configurable as `auto_compact.resume` (default true).
- **A compaction no longer swallows a message sent while it runs.** The cut
  point was read *after* the summary came back, so anything you sent in those
  seconds ended up in neither the summary nor the retained tail — still visible
  in the chat, invisible to the model. The cut point is now taken before the
  summarization starts.
- **The conversation is marked busy while it summarizes.** Nothing was, so the
  input stayed live and a send could race the compaction; prompts are now queued
  and sent when it finishes.
- **Compaction keeps the last exchange verbatim.** The model used to be left
  with a paraphrase and nothing else. The last user turn is retained as-is
  (capped, so a large tool dump cannot be kept whole) and excluded from the
  summary.
- Added `query_powershell`: structured, read-only PowerShell inspection on
  Windows (workspace overview, location, directory listing, file hash). It takes
  named operations, never a raw script.

## 0.12.43 — The thinking pane follows its own reasoning

- **Fixed: an expanded thinking pane never followed the reasoning streaming into
  it.** The pane is its own scroll container (280px tall), so the message list's
  auto-scroll never reached it — past that height new text landed below the fold
  and stayed there. It now pins to the newest text, and stops following the
  moment you scroll up to read back.
- Auto-scroll no longer stalls mid-turn. Every token is a new message array, and
  the smooth scroll restarted its animation on each one without ever arriving.
  Streaming updates now jump instantly; settled ones keep the animation.

## 0.12.42 — Tool calls that outgrow the context no longer lose the turn

- A tool call cut off mid-arguments is now recognised as a truncation instead of
  a malformed call. Previously llama-server's HTTP 500 ("Failed to parse tool
  call arguments as JSON") was read as "this model cannot do native tool calls",
  so Forge stripped tools and re-sent the same oversized request — turning one
  lost call into a lost turn, and eventually disabling tool calling for the
  whole chat.
- On a truncation Forge now tells the model what actually happened — nothing was
  written, this is a size limit — and gives it a hard character ceiling for the
  retry. Two recoveries, then the turn fails with a clear `/compact` message
  rather than spinning.
- Recovery rounds disable thinking. Thinking and the answer share one output
  budget, so a retry that re-thinks starts with less room than the attempt that
  just failed.
- Added `append_file`, so a file too large for one call can be built across
  several. `write_file` and `append_file` both advertise the size ceiling.
- `max_tokens` is now derived from the room actually left in the slot rather
  than from a config value unrelated to it (4096 by default, or larger than the
  entire context where configured). It only ever lowers an explicit setting.
- **Fixed: the context bar and HalluMeter bridge over-reported every model with
  `n_parallel > 1`.** `--ctx-size` is the total across slots and `--parallel`
  divides it, so per-conversation context is `num_ctx / n_parallel`. A
  `n_parallel: 2` model now reads half what it did before — that is the correct
  figure, not a regression.
- A mid-stream SSE error frame is now surfaced instead of silently dropped. That
  class of failure used to end a turn with no message at all.

## 0.12.40 — Live context metering and warm CLI delegation

- The context bar and the HalluMeter bridge now update once per tool round
  during a turn instead of staying frozen until it ends. Ticks are throttled,
  scoped to the conversation, and never trigger auto-compact mid-turn.
- `ask_local_agent` to a `provider: cli` target (Claude Code, Codex) now reuses
  a warm CLI process for the conversation instead of spawning a cold one per
  call. A repeat review no longer re-pays the CLI's system prompt, tool
  schemas, and project instructions as a prompt-cache miss.
- Delegation and sidebar CLI chat now share one session registry, so
  `max_cli_agents` caps the real process count and closing a tab disposes both.
  Delegation sessions are keyed apart from chat sessions so a read-only review
  can never inherit a chat session's write permissions.
- Raised the delegation timeout to 10 minutes for `provider: cli` targets. The
  120s ceiling (unchanged for local models) was aborting working reviews and
  discarding everything they had spent.
- A timed-out or cancelled CLI turn now keeps its session id, so the next
  attempt resumes the existing session instead of starting cold.

## 0.12.31 — Shared runtimes, resilient Codex sessions, and queueing

- Added opt-in compatible llama.cpp runtime sharing between Forge VS Code windows.
- Hardened Codex app-server streaming and final-message recovery after command execution.
- Added queueing for a follow-up prompt while a conversation is streaming, preserving its tab.
- Corrected the control catalog so group-inherited Ollama and cloud providers report their
  actual provider and route.

## 0.12.29 — Config overhaul, Model Manager, CLI subscription agents

- Added schema-v2 config `groups` ("boards") that share tools, context, tool-call
  budgets, and sampling across model sets, layered under existing
  defaults/profiles/aliases, plus a v1→v2 config migrator (backup on write) and
  comment-preserving config writes.
- Added the Model Manager webview: scan a chosen directory, per-parameter tabs,
  model-path view, keyboard navigation, autosave, and delete-from-config or
  delete-from-disk (both confirmed).
- Added deterministic fuzzy worker resolution so short names like "gemma4"
  dispatch to the right model instead of failing on exact-name lookup.
- Added Claude Code and Codex as `provider: cli` agents that run through their own
  subscription login (no API key, no keys stored in Forge).
- Added persistent warm CLI sessions: one reused process per conversation tab
  (bounded pool with idle eviction) so only the first turn pays process startup,
  with checkpoint coverage and disposal on tab close and deactivate.
- Replaced eager whole-workspace CLI `Buffer` snapshots with bounded,
  disk-backed checkpoints, exact hash finalization, byte/file/free-space gates,
  per-conversation Keep/Undo stacks, and rollback preparation before
  `Backend ready`. Large workspaces are now refused safely instead of exhausting
  the VS Code extension host.
- Added the explicit `forge.checkpoint.externalCliEnabled` temporary opt-out.
  Disabling it skips external CLI workspace scans and clearly warns that those
  changes have no Forge Keep/Undo coverage; native Forge tools remain protected.
- Surfaced the CLI `Starting…`/`Backend ready`/disabled-rollback warning only on
  the first turn of a conversation, since later turns resume the warm session
  rather than restarting it; streaming state still updates every turn.

### Tool audit hardening

- Fixed `search_code` startup on current VS Code distributions by resolving the
  platform-specific `@vscode/ripgrep-universal` binary while retaining legacy
  layouts and the final `PATH` fallback.
- Expanded ripgrep startup errors with the resolved command and bundled
  candidates checked, making Extension Host layout failures actionable.
- Reworked `npm run test:local-tools` to derive all 48 native schemas from
  `registerAllTools.ts`, including structured-edit and delegation tools.
- Made strict tool-argument checks structural: reordered object keys now pass,
  while array order and changed values remain significant.
- Added explicit `--include-mcp` discovery, separate native/MCP origin labels,
  schema-emission-only reporting, and exact coordinator/worker catalog tests.
- Added isolated successful handler execution for every native tool group using
  temporary workspaces, repositories, controlled VS Code adapters, and mocked
  network providers; ordinary CI requires no model, GPU, secret, or internet.
- Added opt-in coordinator, worker, tool-free advisory, vision, and semantic
  capability checks with non-overwriting dated reports and a canonical
  native/MCP coverage matrix.
- Added an image-input preflight that explains how to select a vision model or
  configure a compatible llama.cpp `mmproj_path` instead of sending images to a
  text-only model.
- Fixed `run_tests` and `run_build` on Windows by resolving npm/npx shims to
  their adjacent Node CLI without enabling shell execution.

## 0.12.28 — Worker orchestration and safe structured editing

- Added bounded one- or two-worker coding orchestration across configured local
  and explicitly enabled cloud models.
- Added exact read/write worker access contracts, workspace discovery budgets,
  cancellation, backend admission, typed activity status, and coordinator
  review of verified changes.
- Added `apply_line_edits`, a strict atomic multi-edit tool with exact stale-line
  checks, bounded ordered operations, checkpoint integration, and exact worker
  path enforcement.
- Added opt-in local-agent consultation, MCP per-tool permission enforcement,
  non-evicting backend holds, and cancellation propagation.
- Hardened first-run configuration, Add Model preservation, permission gates,
  mutation metadata, and Keep/Undo coverage.
- Expanded the automated suite to 289 tests across 40 test files.

## Session JSONL Logging (HalluMeter + HalluScribe integration)

### What changed

Two files were added or modified to make Forge write conversation sessions to disk,
so that HalluMeter and HalluScribe can read them.

#### New file: `src/sidebar/SessionLogger.ts`

Writes one JSONL file per conversation to `~/.forge/sessions/<session-id>.jsonl`.

Called from `SidebarProvider` after every turn completes (in the `finally` block of `handleSend`).

**File format — one JSON object per line:**

```jsonl
{"type":"session_start","session_id":"<uuid>","title":"Chat","model":"gemma4-e4b-it-ud-q4kxl","timestamp_ms":1747000000000}
{"role":"user","content":"user message text","timestamp_ms":1747000000001}
{"role":"assistant","content":"assistant response text","timestamp_ms":1747000000002,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":null,"tool_calls":[{"name":"read_file","input":{"path":"src/main.ts"}}],"timestamp_ms":1747000000003,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":"Done.","reasoning":"I checked the file first.","timestamp_ms":1747000000004,"model":"gemma4-e4b-it-ud-q4kxl"}
```

Rules:

- First line is always `session_start` (written once when the first turn completes)
- `system` role messages are skipped
- Tool call messages have `content: null` and a `tool_calls` array
- `reasoning` field is included when the model produced a thinking block
- Messages are appended incrementally — each flush only writes new turns since last flush
- File is never overwritten, only appended

#### Modified file: `src/sidebar/SidebarProvider.ts`

- Imported `SessionLogger`
- Added `sessionLoggers: Map<string, SessionLogger>` field to the class
- Added `flushSessionLog(convId)` private method
- Called `this.flushSessionLog(conv.id)` in the `finally` block of `handleSend`, alongside `persistSession()` and `postTokenBudget()`

#### Also modified: `src/sidebar/SidebarProvider.ts` (HalluMeter bridge)

`postTokenBudget()` also writes `~/.forge/hallumeter-bridge.json` on every token budget update:

```json
{
  "model": "gemma4-e4b-it-ud-q4kxl",
  "used_tokens": 12500,
  "max_tokens": 98304,
  "timestamp_ms": 1747000000000
}
```

This is a single file, always overwritten. HalluMeter polls it every 5 seconds to show the live ring indicator.

Added imports at top of `SidebarProvider.ts`: `fs`, `os`, `path` from Node.js built-ins.
Added `writeForgeBridge()` standalone function before the class definition.

---

### What depends on this

| App         | What it reads                     | Purpose                                       |
| ----------- | --------------------------------- | --------------------------------------------- |
| HalluMeter  | `~/.forge/hallumeter-bridge.json` | Live context fill % for ring indicator        |
| HalluScribe | `~/.forge/sessions/*.jsonl`       | Nightly sweep → Gemma summarization → archive |

### Build note

After any change to `src/sidebar/SessionLogger.ts` or `src/sidebar/SidebarProvider.ts`,
rebuild and reinstall the `.vsix`:

```bash
npm run build
# then install the generated .vsix in VS Code
```
