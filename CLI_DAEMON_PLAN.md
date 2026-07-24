# CLI Daemon Plan — persistent Claude / Codex agents in Forge

**Status: implemented, validated, packaged, installed, and manually verified on
2026-07-24.**

## Problem
Each Forge chat turn on a `provider: cli` model spawns a fresh CLI process, runs
one task, and exits ([CliAgentDriver.ts:125](src/agents/CliAgentDriver.ts#L125)).
Every message therefore re-pays: process boot (Node for `claude`, Rust for
`codex`), auth + config load, MCP server spawn, `CLAUDE.md` discovery, and
`--resume`/`exec resume` reloading history from disk. That is the "load time"
felt on every prompt. Subscription auth rules out `--bare` (it forces
`ANTHROPIC_API_KEY`), so the fix must keep the CLI's own login intact.

## Goal
One **warm process per conversation tab**, reused across turns. First message
pays startup; every later message is a pipe write. Applies to both CLIs.
No new outbound traffic, no keys in Forge — auth stays inside each CLI (honours
CLAUDE.md Hard Stops).

---

## CLI persistence mechanisms (verified via `--help`)

| CLI | Persistent mode | Protocol |
| --- | --- | --- |
| claude | `claude -p --input-format stream-json --output-format stream-json --verbose` | NDJSON in **and** out over one long-lived stdio pair; feed each turn as a `user` JSON message on stdin |
| codex | `codex app-server` (stdio) | JSON-RPC-shaped NDJSON; native thread/turn lifecycle over one long-lived connection |

Asymmetry is real: Claude reuses its existing NDJSON turn protocol (the current
`claudeAdapter.handleLine` already parses those event shapes); Codex's warm
modes speak JSON-RPC, which the current `exec --json` adapter does **not**. So
Claude is the cheap, low-risk first cut; Codex needs a new adapter.

### Claude smoke test — PASSED (2026-07-21)
Spawned `claude -p --input-format stream-json --output-format stream-json
--verbose --permission-mode plan` once and sent two turns over one stdin:
- **Same PID handled both turns** — persistent stdin holds; process does not EOF
  after turn 1. Feed one stream-json `user` message per turn, terminated by `\n`.
- **Context persists in-memory across turns with NO `--resume`** — turn 2 recalled
  a fact from turn 1. Implication: within a warm session Forge sends **only the
  new turn**, not the transcript, and omits `--resume` per turn. `sessionId` is
  still captured (stable across turns) but is only needed for **cold reconnect**
  if the process dies — resume from disk, then continue warm.
- **Clean shutdown**: `stdin.end()` → process exits code 0. Dispose can simply
  close stdin (graceful) with `killCliProcessTree` as the hard fallback.

This confirms Phase 1's load-bearing assumption (Open Q1 below, now resolved).
Per-turn message shape that worked:
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`

### Claude cold-reconnect probe — PASSED (2026-07-24)
The gated live probe in
[`scripts/test-claude-cold-resume.mjs`](scripts/test-claude-cold-resume.mjs)
ran against Claude Code 2.1.185:
- A completed turn was persisted and recovered after the warm process was
  killed, using the stored `session_id`.
- A process killed during an active turn surfaced that interruption instead of
  reporting a false success.
- A later cold resume still recalled context from the earlier completed turn.

Production policy: retain the last confirmed `session_id`, surface the failed
current turn, and do **not** silently replay it. The user's next turn may cold
resume the last confirmed session and establish a new warm process.

### Codex protocol spike — PASSED (2026-07-24)
The gated live spike in
[`scripts/spike-codex-persistent-protocol.mjs`](scripts/spike-codex-persistent-protocol.mjs)
ran against Codex CLI 0.144.4:
- `app-server` exposed `thread/start`, `turn/start`, `turn/interrupt`,
  `item/agentMessage/delta`, and terminal turn events.
- Two turns used one thread and retained an in-memory nonce; both emitted
  streaming deltas.
- Interrupting an active harmless command produced terminal status
  `interrupted`.
- `mcp-server` exposed only the higher-level `codex` and `codex-reply` tools.

Decision: use **`codex app-server`**. It provides the direct lifecycle and
streaming primitives Forge needs; wrapping the MCP tools would discard that
control.

---

## Design

### 1. `CliAgentSession` — one warm process (new file, `src/agents/CliAgentSession.ts`)
Owns a single spawned CLI kept alive across turns. Responsibilities:
- Spawn once (reuse the Windows `.cmd` shim + `killCliProcessTree` from
  [CliAgentDriver.ts](src/agents/CliAgentDriver.ts) — extract those helpers to a
  shared `cliProcess.ts` rather than duplicate; grep-before-create per CLAUDE.md).
- `send(task): Promise<CliAgentRunResult>` — writes one turn to stdin, resolves
  when that turn's terminal event arrives (`result` for claude, turn-complete for
  codex). **Serialized**: a second `send` while one is in flight queues or
  rejects — never interleaves on one process.
- Reuse the existing per-CLI `CliAdapter.handleLine` for output parsing; add an
  adapter method to *build one turn's stdin payload* (claude: a stream-json
  `user` message; codex: a JSON-RPC request).
- `dispose()` — `killCliProcessTree`, reject any pending send.
- Idle timer: self-dispose after N minutes (config, default 15 min) of no turns.
- Cancellation is protocol-aware: Claude closes/kills its warm process and
  retains the last confirmed session ID; Codex sends `turn/interrupt` and keeps
  the app-server warm after its `interrupted` terminal event. A broken transport
  is disposed in either case.

### 2. `CliSessionRegistry` — process pool (new file)
- Keyed by **`conv.id + '\0' + modelName`** (matches how `cli_sessions` is scoped
  per conversation, [sessionTypes.ts:56](src/sidebar/sessionTypes.ts#L56)).
- `acquire(key, spawnOpts)` returns the existing warm session or starts one.
- **Hard cap** on concurrent warm processes (config `max_cli_agents`, default 4);
  evict LRU idle session when over cap. This is the answer to "2–3 tabs at once":
  isolated per key, but bounded so N tabs ≠ N zombie Node processes.
- Single owner of CLI-process lifecycle. Add its row to `docs/OWNERS.md`.

### 3. AgentLoop wiring
[`runCliTurn`](src/sidebar/AgentLoop.ts#L433) changes from
`runCliChat(... new CliAgentDriver().run ...)` to
`registry.acquire(key).send(task)`. The streaming callbacks
(`onText`/`onStatus`), checkpoint capture
([CliChatRunner.ts:83](src/agents/CliChatRunner.ts#L83)), and `cli_sessions`
persistence stay as-is — only the process source changes.

**Simplified per-turn payload (from smoke test):** a warm session holds history
in-memory, so `send(task)` transmits **only the newest user turn**, not the
`buildCliChatTask` full transcript ([CliChatRunner.ts:43](src/agents/CliChatRunner.ts#L43))
that spawn-per-message needs. Transcript rebuild is only for the **cold path**:
first turn of a session, or reconnect after the warm process died (resume via the
stored `cli_sessions[modelName]` id, then go warm). This is a latency win beyond
just skipping spawn — turns stop re-sending the whole conversation.

### 4. Disposal (must ship with the feature, not after)
- **Tab close**: `applyCloseConversation`
  ([SidebarProvider.ts:496](src/sidebar/SidebarProvider.ts#L496)) → dispose every
  registry session whose key starts with that `conv.id`.
- **Extension deactivate**: registry added to `context.subscriptions` so
  `deactivate()` kills all warm processes (CLAUDE.md requires disposing child
  processes there).
- **Idle timeout** (see §1) covers tabs left open but unused.

---

## Concurrency semantics (the "2–3 sessions" question)
- **Tabs isolated**: each `conv.id` owns its own warm process + its own
  `sessionId`; no shared history, no cross-talk.
- **Bounded**: registry cap + LRU idle eviction prevents process pile-up. Multiple
  VS Code *windows* are separate extension hosts (separate registries) — the cap
  is per-window; documented as a known limit, not solved here.
- **Per-process serialization**: one turn at a time per session; a mid-flight tab
  rejects/queues a second turn.
- **Shared workspace**: two Claude tabs can still edit the same files
  concurrently and both land in the one `CheckpointStack` — pre-existing risk,
  unchanged by this work. Called out, not expanded here.
- **Subscription limits**: parallel tabs = parallel calls on one subscription;
  errors surface to the user (No-Fallbacks rule), same as today.

---

## Phasing
1. **Claude persistent path** (highest value, lowest risk): shared `cliProcess.ts`
   helpers + `CliAgentSession` (claude only) + `CliSessionRegistry` + AgentLoop
   wiring + disposal. Prove latency drop on turn 2+.
2. **Codex persistent path**: new `codexAppServerAdapter` speaking JSON-RPC to
   `codex app-server`; slot into the same session/registry.
3. **Config + docs**: `max_cli_agents`, idle timeout in
   [schema.ts](src/config/schema.ts)/[types.ts](src/config/types.ts); `docs/OWNERS.md`
   rows; update `docs/TOOL_COVERAGE.md` if agent surface changes.

Fallback: if a warm session errors mid-turn, dispose it and **surface the error**
(no silent respawn or replay masking — AGENTS.md No-Fallbacks). The next user
turn may cold-resume the last confirmed CLI session. Model-mismatch (Haiku) is
out of scope per your call; `--model`/`cli_model` remains the lever if revisited.

## Verification
- `npm run ci` (type-check, lint, tests, build) — canonical gate.
- `npm run package` (release bundle + VSIX smoke) — canonical packaging gate.
- Gated live protocol probes:
  - `npm run probe:claude-cold-resume`
  - `npm run probe:codex-persistent`
  Both require `FORGE_RUN_LIVE_CLI_PROBES=1` and the corresponding absolute
  `CLAUDE_CLI` or `CODEX_CLI` executable path.
- New unit tests: registry cap + LRU eviction; session serialization;
  dispose-on-close kills the process; idle timeout fires.
- Manual: open 3 `claude-code` tabs, confirm 3 warm PIDs, confirm turn-2 latency
  drop, close a tab → its PID dies, idle a tab → PID self-disposes.

## Open questions before build
1. ~~Confirm `claude -p --input-format stream-json` accepts multiple turns on one
   stdin.~~ **RESOLVED 2026-07-21** — smoke test passed: multi-turn stdin works,
   context persists in-memory, no `--resume` per turn. See "Claude smoke test".
2. ~~Choose `codex app-server` vs `mcp-server`.~~ **RESOLVED 2026-07-24** —
   `app-server` provides the required native per-turn streaming and interruption
   lifecycle. See "Codex protocol spike".
3. ~~Confirm cold reconnect after a warm-process crash.~~ **RESOLVED
   2026-07-24** — completed context survives, an interrupted turn is surfaced,
   and the stored `session_id` restores the last confirmed context. See "Claude
   cold-reconnect probe".

---

## New-session implementation handoff

Begin implementation from this section. The protocol research is finished; do
not repeat the live spikes unless the installed CLI version changes or a
protocol regression is suspected.

### Current working-tree baseline

The research session intentionally leaves these uncommitted files:

- Modified: `CLI_DAEMON_PLAN.md`, `package.json`
- Added: `scripts/cli-probe-helpers.mjs`
- Added: `scripts/test-claude-cold-resume.mjs`
- Added: `scripts/spike-codex-persistent-protocol.mjs`

These are expected inputs to the implementation, not unrelated changes. The
live `.forge/config.yaml` was not changed. Preserve the `.forge` and `.forge-*`
checkpoint exclusions throughout this work.

Baseline validation on 2026-07-24:

- `npm run ci`: passed — 521 tests passed, 6 live tests skipped.
- `npm run package`: passed — `forge-llm-0.12.28.vsix` produced.
- Claude Code tested: 2.1.185.
- Codex CLI tested: 0.144.4.

### Implementation order

1. **Extract shared process lifecycle without changing behavior**
   - Move the reusable spawn/shim/termination logic out of
     `src/agents/CliAgentDriver.ts` into `src/agents/cliProcess.ts`.
   - Keep `CliAgentDriver` as the one-shot path used by workers/delegation.
   - Move or extend existing driver tests before adding daemon behavior.

2. **Implement the Claude warm session**
   - Add `src/agents/CliAgentSession.ts` with explicit states:
     `starting`, `idle`, `running`, `disposed`.
   - One process handles one conversation/model key and at most one active turn.
   - Write only the newest user turn on warm sends.
   - Capture a confirmed `session_id` only from successful CLI events.
   - On cancellation or transport failure, terminate the Claude process, reject
     the active turn, retain the last confirmed ID, and never replay the turn.
   - A later send starts a new process with `--resume <confirmed-session-id>`.

3. **Implement and own the registry**
   - Add `src/agents/CliSessionRegistry.ts`.
   - Key by the exact pair `(conversationId, modelName)`; use a structured key
     helper rather than prefix parsing for ownership and disposal.
   - Enforce the configured cap and evict only least-recently-used **idle**
     sessions. If every session is busy, surface a capacity error.
   - Reset the idle timer after every terminal turn event.
   - `disposeConversation(id)` and `dispose()` must await process cleanup.

4. **Wire direct Forge chat only**
   - Inject the registry into `AgentLoop`; do not construct a new session inside
     every turn.
   - Preserve conversation-keyed streaming, cancellation, checkpoints, and
     `cli_sessions` persistence already implemented in `AgentLoop`.
   - Wire conversation close in `SidebarProvider` and extension deactivation.
   - Keep `CliWorkerRunner`, `CliDelegationRunner`, and worker execution on the
     existing one-shot `CliAgentDriver` in this change.

5. **Add Codex app-server support**
   - Add a focused app-server adapter; do not route through `mcp-server`.
   - Implement `initialize`, `thread/start` or `thread/resume`, `turn/start`,
     streamed item/delta handling, terminal events, and `turn/interrupt`.
   - Correlate every response/event to its thread and turn. Reject malformed or
     mismatched protocol messages rather than silently ignoring them.
   - After a clean `interrupted` terminal event, keep the app-server process
     warm. Dispose it on transport/protocol failure.

6. **Add configuration and documentation**
   - Add validated `max_cli_agents` and `cli_idle_timeout_ms` fields through the
     canonical config schema/types/example owners.
   - Use explicit documented defaults; do not infer values from another
     extension.
   - Update `docs/OWNERS.md` for the new lifecycle and registry owners.

### Required tests

- Warm Claude process handles two turns without a second spawn.
- Cold Claude reconnect sends `--resume` with the confirmed session ID.
- Interrupted/failed turns are rejected and are not replayed.
- Two conversations use isolated processes and session IDs.
- A busy session serializes or rejects a second send deterministically.
- Registry cap evicts the LRU idle session and never evicts a busy session.
- Idle timeout and extension/conversation disposal terminate owned processes.
- Codex app-server maps deltas, completion, interruption, and protocol errors.
- Existing one-shot worker and delegation tests remain unchanged and green.
- Closing or undoing a checkpoint never snapshots, deletes, or recreates
  `.forge`.

### Definition of done

- Claude and Codex direct-chat tabs reuse one warm process per
  conversation/model.
- Different tabs can generate concurrently without blocking navigation or
  cross-contaminating streams.
- Cancellation, tab close, idle eviction, extension deactivation, and crashes
  leave no Forge-owned orphan process.
- Current-turn failures are visible; no hidden replay, respawn, or transcript
  fallback occurs.
- `npm run ci` and `npm run package` pass.
- Install the resulting VSIX and run the manual three-tab test before declaring
  the feature shipped.

### Implementation result

- Completed all implementation phases in this handoff.
- `npm run ci` passed with 531 tests and 6 gated live tests skipped.
- `npm run package` produced and installed `forge-llm-0.12.28.vsix`.
- Manual multi-tab verification confirmed Forge-owned warm Claude stream-json
  and Codex app-server processes, Claude cold resume after cancellation, no
  one-shot `codex exec` direct-chat process, and no relevant Forge log errors.
- The live `.forge/config.yaml` remained unchanged at SHA-256
  `309F4FFDF3E2A381ED02B005A6939D9ED4A529C6B4F1F6C29D4D83D61C0AAC1B`.
