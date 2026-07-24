# CLI Daemon Plan — persistent Claude / Codex agents in Forge

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
| codex | `codex app-server` / `codex mcp-server` (stdio) | JSON-RPC over stdio; one connection serves many turns |

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
- Idle timer: self-dispose after N minutes (config, default ~5 min) of no turns.

### 2. `CliSessionRegistry` — process pool (new file)
- Keyed by **`conv.id + '\0' + modelName`** (matches how `cli_sessions` is scoped
  per conversation, [sessionTypes.ts:56](src/sidebar/sessionTypes.ts#L56)).
- `acquire(key, spawnOpts)` returns the existing warm session or starts one.
- **Hard cap** on concurrent warm processes (config `max_cli_agents`, default 3);
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
(no silent respawn masking — CLAUDE.md No-Fallbacks). Model-mismatch (Haiku) is
out of scope per your call; `--model`/`cli_model` remains the lever if revisited.

## Verification
- `npm run ci` (type-check, lint, tests, build) — canonical gate.
- New unit tests: registry cap + LRU eviction; session serialization;
  dispose-on-close kills the process; idle timeout fires.
- Manual: open 3 `claude-code` tabs, confirm 3 warm PIDs, confirm turn-2 latency
  drop, close a tab → its PID dies, idle a tab → PID self-disposes.

## Open questions before build
1. ~~Confirm `claude -p --input-format stream-json` accepts multiple turns on one
   stdin.~~ **RESOLVED 2026-07-21** — smoke test passed: multi-turn stdin works,
   context persists in-memory, no `--resume` per turn. See "Claude smoke test".
2. `codex app-server` vs `mcp-server` — which exposes a clean per-turn request
   with streaming deltas? Spike in Phase 2.
3. Warm-process crash mid-session: confirm cold reconnect via stored `sessionId`
   restores context (relies on Claude's on-disk session persistence). Test in
   Phase 1 before shipping.
