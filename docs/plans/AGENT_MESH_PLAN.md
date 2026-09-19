# Agent mesh: full-mesh Forge ↔ Claude ↔ Codex, visible to the user

**Date:** 2026-09-19 · **Status:** draft for review · **Builds on:**
[AGENT_MESSAGING_PLAN.md](AGENT_MESSAGING_PLAN.md) (the three inbound doors,
the peer pipe, `forge.sh`, the bus file protocol — all shipped) · **Investigation:**
[../AGENT_COMMUNICATION_INVESTIGATION.md](../AGENT_COMMUNICATION_INVESTIGATION.md)

## Why

AGENT_MESSAGING_PLAN gave every agent an inbound door, but the system is still
**half-duplex from Forge's side and invisible to the user**:

1. **Forge has only one way out** — `ask_live_session`, which **blocks** until an
   answer. There is no one-way push, so a "started / 50% / done" note from Forge
   is impossible without the supervisor spending a reply (tokens) and Forge stalling.
2. **Codex burns tokens while it waits.** `codex queue` delivers only *between*
   turns, so a Codex supervisor that "listens" must keep a turn alive (poll through
   the model) — ~127K input tokens per 30 s poll, and it is deaf while doing it.
3. **The user cannot see the exchanges.** Messages between agents appear in each
   agent's own window, but Forge's window shows only its own tool calls. The user
   wants to watch "three friends talk" — transparency beats token efficiency here
   (explicitly accepted).
4. **`/status` shows a stale global "N crash unknown"** that never resolves and is
   not scoped per chat/workspace.
5. **Addressing is ambiguous** — `from` is free text, not validated against live
   sessions, so after a compaction Forge can guess the wrong session.

This plan is the layer on top: **full mesh, one-way push, push-then-idle for Codex,
a visible exchange board, unambiguous addressing, and the `/status` fix.** It does
not rebuild the doors AGENT_MESSAGING_PLAN already shipped.

## The model: three friends, one board

Each agent (Forge, the live Claude session, the live Codex session) is a "friend."
Every message is written to a **shared exchange board** that the user can read in
Forge, and delivered to the recipient's own window through its existing door.

- **The board is the user's view.** It is a durable, append-only log of every
  exchange (`from → to: subject + first line + timestamp + state`), rendered in the
  Forge sidebar. The user sees the whole conversation even though each message
  physically lands in one window.
- **Delivery is still per-door.** The board does not replace the doors; it records
  them. A message to Claude goes over the peer pipe, to Codex via `codex queue`, to
  Forge via `/agent/message`; the board gets a row for each.
- **Token cost is accepted.** The user reads the board in Forge (no model tokens —
  it is UI). Agents do not re-read the whole board each turn; they see their own
  incoming message in their own window. So the board is cheap for the user and for
  the agents; the "not too token efficient" concern is bounded by design.

## Design

### 1. One-way push: `tell_live_session` (fixes blocking + Codex burn)
A new tool (or `ask_live_session` with `wait: false`) that delivers a note to a
Claude peer pipe or `codex queue` and **returns at once** — no `waitForReply`.
- `target: claude` → `sendPeerMessage` (free, instant).
- `target: codex` → `queueToCodex` (free, between-turns).
- Records a board row immediately (`state: delivered`).
- Use for: "started", "50% done", "turn finished", "you can stop". The supervisor
  never has to reply to a `tell`, so it costs the supervisor nothing.

This is the primitive that makes push-then-idle possible.

### 2. Codex push-then-idle (fixes the token burn)
- Forge → Codex: only via `codex queue` (push). Codex is **idle** between pings.
- Codex → Forge: writes a **verdict file** (`outbox/<id>-reply.md` for an answer, or
  a named `<task>.verdict.md` for a task result). Forge polls the file with a local
  `stat` (zero model tokens), not a model round-trip.
- **Rule for the Codex session (documented in the bus README + the plan handoff):**
  a supervisor that must wait does **one blocking shell call** (a bash loop that
  sleeps and returns only when the verdict target appears, capped ~25 min). It must
  **never** poll through the model (`write_stdin`/`yield`).
- **Cost guard:** a wait loop that has done > N empty model turns stops and tells
  the user (a `tell_live_session` to Forge + a board row `state: stalled`).

### 3. The exchange board (the user's view)
- **Store:** `~/.forge/agent-bus/exchanges.jsonl` (append-only, one JSON line per
  exchange: `{id, ts, from, to, subject, first_line, state}`). Atomic appends
  (tmp + rename of the whole file, or a locked append — see ledger). Rows for:
  Forge→Claude, Forge→Codex, Claude→Forge, Codex→Forge, Claude→Codex, Codex→Claude,
  plus `state` transitions (`delivered`, `answered`, `timeout`, `stalled`, `finished`).
- **Render (Forge sidebar):** an "Agent board" section in the Forge sidebar webview
  (a section of the existing status view, not a new panel) listing recent exchanges,
  newest first. Pure UI — reads the file, no model tokens. This is the user's
  consolidated "briefing" of all agent-to-agent exchanges, including direct
  Claude↔Codex messages that otherwise appear only in those two windows.
- **Render (Telegram):** the remote `/status` handler gains an "Agent board" line
  showing the last few exchanges (sender → recipient, subject, state), so the user
  can see the board from their phone too. One extra read of the file in the existing
  status path; no new route.
- **Bounded:** keep the last N (e.g. 200) rows in the file; older ones are swept by
  the existing TTL. The board never grows unbounded.

### 4. Unambiguous addressing (fixes identity loss)
- `from` on `/agent/message` is validated against **live sessions** (Claude registry
  names) or an explicit session id; an unknown `from` is rejected with the live
  list (reuse `pickClaudeSession`'s listing). No more guessing between two sessions.
- The sender identity is kept in **turn metadata** (the board row + the turn record),
  not only in the transcript, so a compaction cannot drop it.
- `ask_live_session` for Codex addresses by the configured `codex_thread` UUID (it
  already does); the double-space title is a red herring and never used for matching.

### 5. `/status` crash-unknown fix (scoped + resolved)
- **Scope:** `requestHealth()` gains a per-conversation/workspace variant; `/status`
  shows the count for *the calling chat's* conversation, not the global store.
- **Resolve:** on `load()`, when flipping `running`→`unknown`, also tag the
  conversation. Add a resolve path: a request whose terminal outcome is re-observed
  (or a re-send of the same `dedupKey` that completes) transitions `unknown`→
  `completed`/`failed`. At minimum, the scoped count stops showing the same global
  number everywhere. (Full auto-resolve is P2; scoping is P1.)

### 6. Bus `/steer` (interrupt allowed) — P3
- `POST /agent/message?from=<name>&priority=steer`, or recognise a leading `/steer`
  via the existing `parseSteerCommand` (single owner — reuse, don't copy).
- **Decision (user, 2026-09-19): a bus steer MAY interrupt a running turn**, same as
  remote steer. `forge.sh steer <name> [file]` verb + README.

### 7. Bus queue visibility in the Telegram view — P3
- The remote/Telegram queue view lists pending **bus** messages too (sender + first
  line), labelled as agent-bus items. `/steer <n>` numbering covers them, or the view
  says clearly they are a separate queue.
- Clarify the `{"queued": N}` return of `forge.sh say`: `N` is the queue *length*, not
  a position; `0` means started at once. Document in `forge.sh`/README.

### 8. Auto "turn finished" notice + status.json — P2
- When a **bus-started** turn ends (done / error / `/stop` / crash), Forge itself
  sends the sender one line (`finished · 23 min · last message: …`) via
  `tell_live_session` + a board row. The model doesn't have to remember → no silent
  stalls.
- While a bus-started turn runs, write `~/.forge/agent-bus/status/<turn>.json`
  (`{started_at, last_activity_at, tool_calls, state, plan:{done,total,current},
  context_pct}`), mirroring `update_plan` (zero model tokens, always accurate) and
  the `OpenAIClient` stall watchdog (`state: stalled`). Replaces the manual
  `BM-<n>.progress.md` workaround.

## What is NOT in scope
- A split "conversation between agents" webview pane (the board is a list, not a
  chat pane). The existing AGENT_MESSAGING_PLAN already scopes that out.
- Rebuilding the peer pipe, the bus file protocol, or the inbound routes — all
  shipped and tested.
- Part B (Halluscribe Rust/Svelte findings) — different repo, reference only.

## State × lifecycle ledger

| Artifact | Create | Delete | Disable (`agent_bus.enabled: false`) | Crash mid-write | Owner-process death | TTL / bound |
|---|---|---|---|---|---|---|
| `exchanges.jsonl` (the board) | append on every exchange + state transition (tmp + rename of whole file, or locked append) | rows swept when they age out of the last-N window | not written; board shows "agent bus disabled" | whole-file rewrite: tmp only → the previous file is intact (atomic rename); a locked append: a torn last line is dropped on next load (parse tolerantly) | append is idempotent per `id`; a duplicate `id` is not re-added | last N=200 rows; older swept by the 24 h bus TTL |
| `status/<turn>.json` | written while a bus-started turn runs (tmp + rename each update) | deleted when the turn ends (finished notice already sent) | not written | tmp only → the previous snapshot is intact | turn dies → the finished-notice path marks it `state: crashed` then deletes | one per live turn; deleted on end |
| Codex verdict file (`outbox/<id>-reply.md` / `<task>.verdict.md`) | the Codex session writes it (tmp + rename) | Forge after polling + board row `answered` | route 404 / file never written | tmp only → Forge keeps polling (file incomplete = not there yet) | Codex dies mid-task → Forge's poll times out → board row `timeout` + a `tell` to the user | 24 h bus sweep (unchanged) |
| Scoped `unknown` request tag | `load()` tags the conversation when flipping `running`→`unknown` | request resolved to a terminal state, or ages out | unchanged (remote, not bus) | unchanged (remote state file, atomic) | unchanged | 30 d retention (unchanged); scoped count is derived, not stored |
| `endpoint.json`, `forge.sh`, `README.md`, `inbox/`, `outbox/` | (unchanged — AGENT_MESSAGING_PLAN) | (unchanged) | (unchanged) | (unchanged) | (unchanged) | (unchanged) |

CI row: extend the existing bus-folder test to allow `exchanges.jsonl` and
`status/` (empty when idle), and still fail on any other stray file. A board row is
written on **every** exchange and on **every** state transition, so the board and the
doors can never disagree about what happened.

## Phases
1. **P1 — one-way push + `/status` scope + finished notice.** `tell_live_session`
   (or `wait:false`); scoped `requestHealth()`; auto "turn finished" line. Smallest
   change that removes the biggest blind spots.
2. **P2 — the board + status.json + `forge.sh cmd`.** `exchanges.jsonl` writer +
   sidebar render; `status/<turn>.json` from `update_plan` + stall watchdog;
   `forge.sh cmd <slash>` → `POST /agent/command` (allowlist `/status /queue /context
   /stop /steer /view /compact`, one owner = `RemoteCommandHandler`, destructive ones
   logged in `RemoteAuditLog`).
3. **P3 — `/steer` on the bus + queue visibility + identity + liveness/cost guard.**
   `parseSteerCommand` reuse (interrupt allowed); Telegram queue view lists bus
   items; `from` validated against live sessions; Codex liveness check + cost guard.

## Risks
- **The board is a new durable file.** It must be atomic and bounded, or it becomes
  the next `endpoint.json`-style leak. The ledger's create/delete/crash cells above
  are the contract; the CI row enforces "nothing else in the folder."
- **`exchanges.jsonl` is read by the webview and written by the backend.** Use a
  single-writer (the backend) + the webview only reads; never let the webview write.
- **Full mesh means more messages.** The board is bounded (last N) and the agents
  still only see their own incoming message, so this does not inflate any agent's
  context. The user's view is UI, not tokens.
- **Codex liveness is still not provable** (Part A open item 3): `codex queue` queues,
  it does not confirm the session is idle. The cost guard + verdict-file timeout are
  the mitigation; a true liveness probe is a follow-up.

## Acceptance criteria
Each maps to a test or a named manual step.

1. **One-way push:** `tell_live_session(target: claude)` delivers to the peer pipe
   and returns within ~1 s **without** waiting for a reply; a board row
   `state: delivered` is written. (Unit: fake `sendClaude` + assert no `waitForReply`
   call + assert board row.)
2. **One-way push to Codex:** `tell_live_session(target: codex)` calls `codex queue`
   and returns at once; board row written. (Unit: fake `queueCodex`.)
3. **Push-then-idle:** a Codex verdict file written after a `tell` is picked up by
   Forge's poll and recorded as `answered`; Forge spent **no** model round-trip
   waiting. (Integration: write the file, assert the poll resolves.)
4. **The board is visible:** after a Forge→Claude→Forge exchange, the sidebar board
   shows all three rows (newest first) with sender, subject, and state. (Webview
   test: seed `exchanges.jsonl`, assert rendered rows.)
5. **The board is bounded:** writing > N rows keeps only the last N. (Unit.)
6. **The board is atomic:** a crash mid-write leaves the previous file parseable.
   (Unit: simulate a torn append, assert tolerant parse + no crash.)
7. **`/status` scope:** two conversations each with one `unknown` request show
   `crash-unknown=1` in *their own* `/status`, not a shared global count. (Unit on
   the scoped `requestHealth`.)
8. **Finished notice:** when a bus-started turn ends, the sender gets one
   `finished · …` line via `tell_live_session` and a board row `state: finished`.
   (Integration: start a bus turn, end it, assert the notice + row.)
9. **Unambiguous addressing:** `POST /agent/message` with a `from` that matches no
   live session is rejected with the live list; a matching `from` is accepted and its
   identity survives a simulated compaction (stored in turn metadata, not only the
   transcript). (Unit + integration.)
10. **`/steer` on the bus (P3):** a `priority=steer` bus message interrupts a running
    turn (same as remote steer), reusing `parseSteerCommand`. (Integration.)
11. **Queue visibility (P3):** the Telegram queue view lists pending bus messages
    labelled as agent-bus items. (Webview/remote test.)
11b. **Telegram board:** `/status` shows the last few agent-board exchanges
    (sender → recipient, subject, state). (Remote test: seed `exchanges.jsonl`,
    assert the `/status` output includes them.)
12. **Cost guard:** a Codex wait loop that exceeds N empty model turns stops and
    sends a `stalled` notice. (Manual step, documented in the handoff.)
13. **`npm run ci` green; no file over 500 lines; OWNERS rows present.**
