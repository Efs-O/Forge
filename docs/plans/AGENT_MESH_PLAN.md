# Agent mesh: Forge-hub agent communication, visible to the user

**Date:** 2026-09-19 · **Status:** v2.1 — revised after Codex NO-GO review, then
final audit (Claude, 2026-09-19; see "v2.1 audit amendments" below) ·
**Builds on:** [AGENT_MESSAGING_PLAN.md](AGENT_MESSAGING_PLAN.md) (the three
inbound doors, the peer pipe, `forge.sh`, the bus file protocol — all shipped) ·
**Investigation:** [../AGENT_COMMUNICATION_INVESTIGATION.md](../AGENT_COMMUNICATION_INVESTIGATION.md) ·
**Review:** [../CODEX_PLAN_REVIEW_2026-09-19.md](../CODEX_PLAN_REVIEW_2026-09-19.md)

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

The v1 plan (2026-09-19) added detect-or-create, standby, a board, and a command
surface. The Codex review (NO-GO) found that its **protocol and lifecycle were not
precise enough to implement safely**: "queued" was recorded as "delivered",
standby was asserted without a mechanism, ownership had no durable record, the
ledger had no writer topology, and "full mesh" was claimed without a route. This
v2 closes those blockers. Where v1 and v2 disagree, v2 wins. Where v2 and the
**v2.1 audit amendments** section disagree, the amendments win.

## v2.1 audit amendments (normative — override the sections below)

The final audit found that v2 treats "Forge" as **one process**. It is not: every
VS Code window runs its own extension host, and all of them share
`~/.forge/agent-bus/` (`agentRoutes.ts` already says "another window may own
[endpoint.json] now"). Several v2 rules are unsafe under that fact, and a few
other seams were left open. These amendments are binding:

- **M1. Multi-window writer topology (replaces §3 "Single writer").** Any window
  may append events, so the board has several writers **across processes**.
  All writes to `exchanges.jsonl` (both appends and compaction) take one
  interprocess lock: `exchanges.lock`, created with O_EXCL and holding
  `{host_pid, host_started_at}`. Inside a window, writes still go through the
  in-process queue. A lock is stale **only** when its holder host is proven dead
  (pid dead, or pid alive with a different start time); age alone never makes it
  stale. Compaction rewrites to a tmp file and renames it over the log, all under
  the lock. That rename runs into Windows EPERM when another process holds the
  file open, so readers open, read and close; they never keep a handle. A failed
  rename leaves the old log in place, and the next compaction retries it.
- **M2. Ownership is per window (replaces §0's ownership file + reaping rule).**
  Records are per alias: `ownership/<alias>.json`, not one shared
  `ownership.json` that several windows rewrite with tmp + rename (last writer
  wins, and that loses updates). Each record adds
  `owner_host: {pid, started_at}` (the extension host that holds the stdio pipe)
  and `thread_id`. **Startup recovery may reap a session only if its
  `owner_host` is dead.** "The pid is alive but *I* don't hold its pipe" is the
  normal state for a session another open window owns, and reaping on that
  would kill a peer window's live session. The creation claim
  (`ownership/<alias>.claim`) also carries the claimant's
  `{host_pid, host_started_at}`. It becomes stale when the claimant host is dead,
  **not** after a fixed time, so a spawn slower than the time bound cannot cause
  a double spawn.
- **M3. "Warm" survives a restart through the thread, not the process (revises
  §2b "Forge restart while parked").** `CodexAppServerSession` already does
  `thread/resume` when it is built with a confirmed session id. When a session's
  owner host is dead, recovery reaps the orphan process (ownership proven via
  M2), but it **keeps** `thread_id`. The next message for the alias starts a new
  app-server that resumes that thread, so it needs no consent and keeps its
  context. If `thread/resume` fails, the board writes a `context_lost` event and
  the user sees it; the plan never swaps in a fresh thread silently. The same
  path handles `parked → dead`.
- **M4. Idle TTL never reaps a parked session, and turn end reaps nothing.** The
  ledger's "entry removed when Forge reaps (turn end / …)" is struck: reaping at
  turn end contradicts park-but-warm. An owned session leaves only through
  `close`, the idle TTL (only while **not** parked), owner-host death recovery
  (M2/M3), or process death.
- **M5. Admission: one host-side FIFO per alias (fills the gap in §1/§2b).**
  `CodexAppServerSession.send()` **throws** when a turn is already active, and
  it resolves only at **turn end**. So `tell_live_session` and relayed messages
  must never await `send()` and must never call it while a turn is running. Each
  owned alias gets one host-side FIFO, owned by the window that owns the session
  (M2): a message queues as `accepted`, then goes out as `started` when the turn
  begins. `completed` arrives later as a board event. A `steer` interrupts the
  active turn (`turn/interrupt`), then runs next. The queue has a bound (e.g. 20);
  overflow is `rejected`, reported to the sender, and never silently dropped.
- **M6. The hub relay is host-side and addressed (closes gap A for real).** The
  inbound route gains `to=<alias>`, so it becomes
  `POST /agent/message?from=<alias>&to=<alias>`. When `to` is not Forge, the
  **host** forwards the message through the recipient's adapter. **No Forge
  model turn is spent, and the Forge model does not decide whether to relay.**
  The host writes two hop events under one `exchange_id`. An unknown `to` is
  rejected with the list of live aliases. Loop guard: a relayed message cannot
  be relayed again (hop count ≤ 2 per exchange). The `to` field on
  `tell_live_session` covers only Forge-originated sends, not relays.
- **M7. Event log + sender validation + host-side wait are P0.** P0 already
  "wires the delivery state machine into the board events", so the
  `exchanges.jsonl` **writer** (M1, compaction, dedupe) ships in P0, and P2 only
  **renders**. §4's `from`/`to` alias validation and §2b's host-side wait with
  its cost guard also move to P0. Codex's gap H was that these are prerequisites
  for truthful states, and v2 had left them in P2/P3.
- **M8. Compaction never removes a non-terminal exchange.** Last-N and the TTL
  apply only to exchanges whose latest state is terminal (`completed`,
  `rejected`, `timeout`, `cancelled`, `crashed`, `recovered`, `context_lost`).
  Non-terminal exchanges do not count toward N. An in-flight exchange never
  loses its history. So that exemption cannot grow the log forever, every
  non-terminal exchange has a deadline: for example, a user-opened session
  that stays `accepted` with no verdict. When the deadline passes, the exchange
  gets a terminal `timeout` event and becomes eligible for compaction. A late
  verdict after that is an orphan, announced once (criterion 5).
- **M9. Scope of an inbound bus message.** An exchange inherits `workspace` and
  `conversation` from its parent `exchange_id`. An unsolicited inbound message
  takes the scope of the window and conversation it is injected into (the
  window that holds `endpoint.json`). An event with no conversation is rendered
  in the sidebar of its workspace only, **never** on Telegram. **An unbound
  Telegram chat's `/status`** shows no per-chat crash count and no board line;
  it says "no conversation bound", and it never falls back to global numbers.

## The model: three friends, one hub, one board

Each agent (Forge, the live Claude session, the live Codex session) is a "friend."
**v1 decision (revises v1's "full mesh"): the transport is hub-and-spoke through
Forge.** Every message routes agent→Forge→agent. There is **no direct Claude↔Codex
transport in v1** — the bus is Forge-centric, and claiming a peer route without a
specified envelope, acknowledgement, and retry was the v1 mistake (Codex, gap A).

- **Multidirectionality is preserved functionally:** Codex can talk to Claude by
  messaging Forge with `to: claude`; Forge delivers it and records **both hops** on
  the board with a shared `exchange_id` (parent correlation). The user sees the
  whole exchange either way.
- **Direct peer routing (a real Claude↔Codex envelope) is explicitly out of
  scope** for v1 — it is future work, not a v1 claim.
- **The board is the user's view.** A durable, append-only **event log** of every
  hop and state transition, rendered in the Forge sidebar and mirrored (scoped) to
  Telegram. Delivery is still per-door; the board records it.
- **Token cost is accepted** for the user's visibility; the board is UI, not
  model context.

## Design

### 0. Session identity: aliases + ownership (replaces v1's bare detect-or-create)

v1's "detect-or-create" contradicted itself: "the user is never the courier" and
"refuse to guess between several sessions" cannot both hold without a stable
identity. v2 resolves it with **one-time explicit registration + Forge-owned
sessions as the default** (Codex, gap B + §4):

- **Alias:** each agent has a stable alias (e.g. `codex`, `claude`) mapped to a
  session identity in `~/.forge/agent-bus/aliases.json`
  (`{alias: {agent, session_id, registered_at, by}}`). The `config.yaml`
  `codex_thread` / `claude_session` values become **deprecated pins** — an alias
  wins; a pin is used only if no alias exists and the pin's session is live.
- **First creation is explicit.** Creating a Forge-owned session starts a
  privileged CLI with side effects, so the **first** creation for an alias requires
  user-visible consent (a confirmation, like `ask_local_agent`). Subsequent reuse
  within the alias is automatic. The user registers once, then is never the
  courier again — the v1 promise, honestly scoped.
- **Detect:**
  - **Claude:** `readClaudeSessions()` (registry) + `pickClaudeSession()` (refuse
    to guess). Unchanged — it already works.
  - **Codex:** a live session matching the alias's `session_id` is used directly.
    Discovery of *unknown* sessions (`codex agents --remote <endpoint>`) is **not
    in v1**: the `--remote` endpoint source on Windows is unverified, and building
    the lifecycle on an unproven adapter was the v1 mistake (Codex, gap B).
    Discovery becomes a later, separately-tested enhancement with a versioned
    adapter contract + a hermetic compatibility test.
- **Create (per agent):**
  - **Codex (P0, proven infra):** spawn-and-own via the existing
    `src/agents/CodexAppServerSession.ts` — a warm, reusable `codex app-server
    --stdio` JSON-RPC session (`send()` per turn, `threadId`, interrupt, dispose;
    launched via `codexAppServerArgs` with `danger-full-access` +
    `approval_policy=never`). **The owned session is what makes real delivery
    states possible** (§2): Forge sees turn start and turn end directly.
  - **Claude (deferred to P4):** a Forge-owned Claude session is a **persistent
    stdio session** (long-lived `claude` process, framed like `claudeRelay` but
    kept alive, addressed by Forge alias — it does not appear in the sidebar
    registry). v1's "spawn a claude CLI process" was underspecified (Codex, gap B):
    a spawned process is not automatically an interactive registry session. P0
    covers Claude **detect + pin only**; the user's workflow always has a Claude
    session open, so the missing create path is rare, not blocking.
- **Ownership record (durable):** `~/.forge/agent-bus/ownership.json`, one entry
  per Forge-owned session: `{alias, agent, session_id, pid, started_at, protocol,
  workspace, created_at, parked: bool, lease_expires_at}`. Written atomically
  (tmp + rename) at creation; updated on park/wake/lease renewal. **Reaping is
  allowed only when Forge can prove ownership:** the record exists AND the pid is
  live AND `started_at` matches (guards against PID reuse). A user-opened session
  (sidebar) has no ownership record and is **never** reaped.
- **Creation lease (concurrent spawn):** before spawning, Forge atomically claims
  `ownership/<alias>.claim` (unique token). A second caller that sees the claim
  waits for the alias record to appear (bounded) instead of spawning a duplicate.
  Without this, "one session per agent" is aspirational (Codex, gap E).
- **Startup recovery (revises the v1 ledger contradiction):** no code runs during
  a crash, so **no notice is sent during the crash.** On next start, Forge reads
  `ownership.json`: for each owned session, if the pid is dead → write board row
  `state: crashed` (exactly once, idempotent by event id) and best-effort send the
  finished notice *then*; if the pid is alive but the stdio pipe is gone (Forge
  restarted) → the session is unreachable → reap it (ownership proven) and mark
  the row `recovered: reaped`. The notice is a recovery-time event, not a
  crash-time one.

### 1. One-way push: `tell_live_session` — a distinct typed primitive

**Not** `ask_live_session` with `wait: false` (Codex, gap C): a notification has
no expected answer, no correlation id, no reply contract, no orphan policy. An
`ask` has all of those. Overloading one call for both makes it too easy for models
to infer that a non-blocking send was processed.

- New tool `tell_live_session({target, to?, message})` — typed schema, no free-form
  blob. Delivers and **returns at once** (no `waitForReply`).
- `target: claude` → `sendPeerMessage` (a successful pipe write = `accepted`, §2).
- `target: codex` → owned session: `send()` starts a turn (Forge observes
  start/completion, §2); user-opened session: `codex queue` (exit 0 = `accepted`
  only).
- `to` (optional): the *final* recipient when the hub is relaying
  (e.g. `to: claude` from a Codex-originated message). Forge records both hops
  under one `exchange_id`.
- Use for: "started", "blocked", "turn finished", "you can stop". **Coalescing
  rule (Codex, §3):** progress is host-visible and coalesced — "started / blocked /
  finished" are events; repeated percentage updates do **not** wake a supervisor.
- `tell` returning saves the *sender's* model turn; a notification that wakes the
  recipient still costs the recipient a turn. Transport cost ≠ model cost.

### 2. Transport truth: delivery states (replaces v1's single "delivered")

`codex queue` is fire-and-forget: exit 0 confirms **queued**, not that the session
is alive or will process the message (investigation §2.4; Codex, gap C). v1
recorded `state: delivered` on that — a lie the board would display as health. v2
states:

```
created → accepted → observed → started → completed
                ↘ rejected      ↘ timeout / stalled / cancelled / unknown
```

- **`accepted`** — the transport accepted the message (pipe write ok / `codex
  queue` exit 0 / `send()` dispatched). A transport exit code may advance **only**
  to `accepted`.
- **`observed`** — the recipient's session is known to have the message in its
  queue/window (owned session: Forge holds the handle; user-opened: best-effort,
  may stay `accepted`).
- **`started`** — a turn began processing it. **Owned sessions report this for
  free** (`CodexAppServerSession.send()` resolves per turn; the peer pipe has no
  such signal — Claude stays at `accepted`/`observed` honestly).
- **`completed`** — the turn ended with a result (verdict file / reply / turn text).
- Board rows record **transitions**, one event per transition (§3). The UI shows
  the latest state per exchange; "accepted" renders as *queued*, never as
  *delivered*.

### 2b. Standby: park-but-warm, with a real mechanism (revises v1's assertion)

"Park the blocking wait but keep the session warm" (user definition, kept) is now
defined per adapter — **a state label is not a wake mechanism** (Codex, gap D):

- **Codex, owned session (the primary case):** the session's *default* state is
  idle — no active turn, process alive, zero tokens. **Park** = mark the
  ownership record `parked: true` (exempt from the idle TTL). **Wake** = Forge
  calls `send()` on the session — JSON-RPC `turn/start` **deterministically starts
  a new turn** in the same session with its full context. No shell loop, no
  polling, no `codex queue` timing dependency.
- **Codex, user-opened (sidebar) session:** park = the session is idle between
  turns; wake = `codex queue` (delivered between turns — if mid-turn, the message
  waits; the board shows `accepted`, not `started`). **Honest limitation:** Forge
  cannot prove this wake happened; the state stays `accepted` until a verdict
  file appears.
- **Claude, user-opened (peer pipe):** park = session idle (the registry exposes
  `status: idle`); wake = `sendPeerMessage` — the framed message appears in the
  session's chat and starts a turn. Real wake, but no completion signal (stays at
  `accepted`/`observed`).
- **Claude, owned stdio session (P4):** same shape as owned Codex — send a frame,
  a turn starts, Forge observes completion.
- **State machine (the ledger's contract):**
  - `active → parked`: turn ends, session stays alive, record marked parked.
  - `parked → active`: wake starts a new turn (owned: deterministic; user-opened:
    best-effort).
  - `parked → active (steer)`: a steer to a parked session wakes it (same wake
    path, priority flag).
  - `parked + queued message`: the wake delivers the queued message (one active
    turn per session — the adapter serializes; `CodexAppServerSession` already
    refuses a second concurrent turn).
  - `parked → dead`: the process dies; next detection marks the alias `dead`,
    invalidates the ownership record; the next message re-creates (with consent
    only if the alias was never registered).
  - `parked → reaped`: explicit `close` (Forge-owned only) or user closes their
    own window.
  - **Forge restart while parked:** ownership record survives; the owned stdio
    pipe does not → startup recovery reaps and marks `recovered: reaped` (§0).
- **Cost guard (kept from v1):** a wait loop that has done > N empty model turns
  stops and tells the user. The *preferred* wait is host-side (a Forge-owned
  blocking read / file watch with deadline + cancellation), **not** an agent shell
  sleep loop — a promised `bash` loop is a Windows portability dependency (Codex,
  §3). The blocking-shell pattern survives only as the documented fallback for a
  user-opened Codex session that has no host-side owner.

### 3. The exchange board: an immutable, scoped event log (revises v1's ledger)

- **Model: immutable event log** (Codex, gap F). `~/.forge/agent-bus/exchanges.jsonl`
  is append-only **events**: `{seq, event_id, ts, exchange_id, workspace,
  conversation, from, to, type, state, detail}`. Latest state per exchange is
  **derived** by reading; the file is never rewritten in place. v1's
  "append-only while sweeping/rewriting" contradiction is gone: **sweeping
  compacts whole exchanges** (all events of an exchange leave together), never a
  transition whose predecessor remains.
- **Single writer: the Forge backend process.** The webview only reads. Telegram
  handling and bus inbound run in the same backend process and serialize through
  one in-process writer queue (async mutex) + `fs.appendFile`. Torn last line on
  crash: dropped on read (tolerant parse). No interprocess lock is needed because
  there is one process; if a second writer is ever added, it must take a real
  interprocess lock — the board must never be concurrent read-modify-write.
- **Idempotency:** `event_id` is a UUID; a duplicate `event_id` is skipped on
  read (recovery replays safely). This is the check, not just a note.
- **Scope (cross-workspace leak fix, Codex, gap F):** every event carries
  `workspace` + `conversation`. The sidebar renders only its workspace; Telegram
  `/status` renders only its bound conversation. A local file is **not** treated
  as globally visible.
- **Retention: one policy.** Keep the last N=200 **exchanges** (with all their
  events); the 24 h TTL is a backstop that only fires when fewer than N exist.
  Last-N wins; the spec states which.
- **Verdict files:** UUID-named only — `outbox/<exchange_id>.verdict.md`.
  v1's `<task>.verdict.md` was collision-prone and let stale results masquerade as
  new ones.
- **Render (Forge sidebar):** an "Agent board" section in the existing status
  view — recent exchanges, newest first, latest state per exchange. Pure UI.
- **Render (Telegram):** `/status` gains a bounded "Agent board" line (last few
  exchanges *for this conversation*) — separate from the compact `/status`
  counters (Codex, §4: don't dump board content into every status response).

### 4. Unambiguous addressing: aliases (revises v1's free-text validation)

- Inbound `from` is validated against **aliases + live sessions**; an unknown
  `from` is rejected with the live list. **A human-readable name is never the
  sole identity** (Codex, §6): the alias maps to a session identity; after a
  compaction, Forge resolves by alias, not by remembering.
- Outbound `ask_live_session` / `tell_live_session` target by alias (or explicit
  session id). The configured `codex_thread`/`claude_session` are deprecated pins
  (§0).
- Sender identity is kept in **turn metadata** (board event + turn record), not
  only the transcript, so a compaction cannot drop it.

### 5. `/status` crash-unknown: scope first, keep `unknown` honest (revises v1)

v1 mixed three decisions (scope, resolve, re-mean crash) and proposed re-sending a
`dedupKey` — which can **duplicate a side effect** unless the remote operation has
an authoritative idempotent receipt (Codex, gap G). v2 contract:

- **Scope (P1):** `requestHealth()` gains a per-conversation variant; `/status`
  shows the count for *the calling chat's* conversation. Old records without
  conversation metadata are attributed to `unknown-scope` and excluded from
  per-chat counts. A Telegram `/status` uses the bound conversation's identity.
- **`unknown` stays `unknown`.** No auto-resolve to `failed` — uncertainty is not
  turned into a clean-looking counter. A terminal state is derived only from a
  receipt or an explicit user reconciliation action.
- **One contract:** scoping is P1; reconciliation is a named later step. v1's
  "full auto-resolve is P2" vs "P1 resolves unknown" contradiction is removed.

### 6. Bus `/steer` (interrupt allowed) — P3
- `POST /agent/message?from=<alias>&priority=steer`, recognised via the existing
  `parseSteerCommand` (single owner — reuse, don't copy).
- **Decision (user, 2026-09-19): a bus steer MAY interrupt a running turn**, same
  as remote steer. A steer to a **parked** session wakes it (§2b state machine).
  `forge.sh steer <alias> [file]` verb + README.

### 7. Bus queue visibility in the Telegram view — P3
- The remote/Telegram queue view lists pending **bus** messages too (alias + first
  line), labelled as agent-bus items.
- Clarify the `{"queued": N}` return of `forge.sh say`: `N` is the queue *length*,
  not a position; `0` means started at once. Document in `forge.sh`/README.

### 8. Command surface: typed lifecycle operations (revises v1's string blob)

**Not** a generic slash-command/string tool (Codex, §4): lifecycle commands are
**typed operations**, validated by one owner (`RemoteCommandHandler`), authorized
by session ownership.

**Peer-targeted (hub-relayed, by alias):**
- `say <alias> <msg>` — send a message (existing, `forge.sh say`).
- `steer <alias> [msg|file]` — interrupt a running turn / wake a parked one (§6).
- `standby <alias>` — **park-but-warm** (§2b). The default "done for now."
- `wake <alias>` — explicitly wake a parked session (a `say`/`steer` does the same
  implicitly).
- `handoff <alias> [context-file]` — a `say` with a convention: "my part is done,
  here's the state, you take over." High value for the one-session model.
- `close <alias>` — hard-kill a **Forge-owned** session (ownership record proven).
  **Never** targets a user-opened session. Distinct from `standby`.

**Observational:**
- `status` — compact counters, scoped (§5).
- `board` — the exchange board for this scope (last N exchanges).
- `peers` — live sessions + aliases + states (`live`/`parked`/`dead`).
- `queue` / `context` — pending messages / context usage (existing).

**Also user-facing via Telegram:** `/status` gains a **"Live sessions" line**
(alias, target, state) — the user checks from the phone who is live or parked
before sending a proposal. No new route.

### 9. Auto "turn finished" notice + status.json — P1/P2
- When a **bus-started** turn ends (done / error / `/stop` / crash-recovery),
  Forge sends the sender one line (`finished · 23 min · last message: …`) via
  `tell_live_session` + a board event. Crash case: sent at **recovery** (§0), not
  during the crash. The model doesn't have to remember → no silent stalls.
- While a bus-started turn runs, write `~/.forge/agent-bus/status/<turn>.json`
  (`{started_at, last_activity_at, tool_calls, state, plan:{done,total,current},
  context_pct}`), mirroring `update_plan` (zero model tokens, always accurate) and
  the `OpenAIClient` stall watchdog (`state: stalled`). Replaces the manual
  `BM-<n>.progress.md` workaround.

### 10. Documentation + tool-description cleanup (the hackjob) — P5

- **`FORGE.md` (the agent-bus bullet, lines ~35–46):** the "Windows workaround
  (until the infra is fine-tuned)" note is **obsolete** — the ENOENT is fixed
  (`resolveCliExecutable.pickExecutable` prefers the `.cmd` shim, 0.16.9). Replace
  it with the alias/ownership model: `ask_live_session` resolves by alias (or
  spawns with one-time consent); the manual `codex queue` + verdict-file-poll
  pattern becomes a **fallback**, not the primary door. Keep the "board line ≠
  notification" rule.
- **`ask_live_session` description (`liveSessionTool.ts`):** currently says Codex
  is "the open Codex session set in config." Update to: *resolves by alias; a
  Forge-owned session is created with one-time consent; the config thread/session
  is a deprecated pin.*
- **`ask_local_agent` description (`localAgentTool.ts`):** make the relationship
  explicit — it is the **cold-session** route (fallback when no live session
  exists); `ask_live_session` is the **live-session** route (primary). Today the
  two descriptions never cross-reference, so the model reaches for the wrong one.
- **`tell_live_session` description:** a notification — no expected answer, no
  blocking; use it for progress/finished/stop, not for questions.

## What is NOT in scope
- **Direct Claude↔Codex transport** (a real peer envelope with its own ack/retry).
  Hub-and-spoke through Forge is the v1 transport; the board shows the relayed
  exchange. Direct routing is future work, not a v1 claim.
- **Codex session discovery** (`codex agents --remote <endpoint>`): the
  `--remote` endpoint source on Windows is unverified. Discovery is a later,
  separately-tested enhancement with a versioned adapter contract; v1 uses
  alias + owned session + (deprecated) pin.
- **A split "conversation between agents" webview pane** (the board is a list,
  not a chat pane).
- Rebuilding the peer pipe, the bus file protocol, or the inbound routes — all
  shipped and tested.
- Part B (Halluscribe Rust/Svelte findings) — different repo, reference only.

## State × lifecycle ledger

| Artifact | Create | Delete | Disable (`agent_bus.enabled: false`) | Crash mid-write | Owner-process death | TTL / bound |
|---|---|---|---|---|---|---|
| `aliases.json` | one-time explicit registration (user consent) or first owned-session creation | user removes the alias (command); the alias record survives session death | not read; doors report "agent bus disabled" | tmp + rename → previous file intact | survives (it is the recovery input) | permanent until removed |
| `ownership/<alias>.json` (Forge-owned sessions; per alias, M2) | written atomically at spawn, after the creation lease is claimed; carries `owner_host` + `thread_id` | entry removed on `close` / idle TTL (not parked) / process death; on owner-host-death recovery the process is reaped but `thread_id` is **kept** for resume (M3). **Never at turn end** (M4) | not written; existing entries are not reaped while disabled (re-enabled later) | tmp + rename → previous file intact | **recovery on next start** (see §0): pid dead → board `crashed` + best-effort notice; pid alive and **`owner_host` dead** → reap + `recovered: reaped` (M2). Owner host alive (another window) → untouched. No notice is sent during the crash (no code is running). **Known limitation (tracked):** recovery nulls the dead owner's `owner_host` and keeps `thread_id` for resume, but it does NOT kill the dead window's orphaned CLI child process — a cross-process kill of another window's process tree is not implemented, so a crashed window's Claude/Codex process can leak until it exits on its own. The M3 primary guarantee (thread/context survives for resume) is met; the process leak is a secondary crash-edge concern, accepted for now | idle TTL (e.g. 30 min) from last activity, paused while `parked`; a parked session is exempt from the TTL |
| creation lease `ownership/<alias>.claim` | atomic claim before spawn | removed when the alias ownership entry is written (or the claimant dies) | not taken | claim file without a matching ownership entry is stale **only if the claimant host is dead** (M2) → next claimant reclaims | a dead claimant host's claim is stale → reclaim; a live-but-slow claimant is waited on, never raced — this is what prevents concurrent double-spawn | waiter's bounded wait (e.g. 2 min) then reports "creation in progress" — it does not reclaim a live claim |
| `exchanges.jsonl` (event log) | any window's host appends one event per transition, under the in-process queue **and** the interprocess `exchanges.lock` (M1) | **compaction removes whole terminal exchanges** (all events leave together), never a lone transition, never a non-terminal exchange (M8); tmp + rename under the lock | not written; board shows "agent bus disabled" | torn last line dropped on read (tolerant parse); the append is a single `appendFile` call | writer is the backend; a crash between append and ack → the event is on disk, recovery re-derives state; `event_id` dedupe makes replay safe | last N=200 **terminal** exchanges (all their events); 24 h TTL only as a backstop when < N exist. Last-N wins. Non-terminal exchanges are exempt (M8) |
| `status/<turn>.json` | written while a bus-started turn runs (tmp + rename each update) | deleted when the turn ends (finished notice already sent, or recovery marks `crashed` then deletes) | not written | tmp only → previous snapshot intact | turn dies → recovery marks `state: crashed` then deletes | one per live turn |
| verdict file `outbox/<exchange_id>.verdict.md` | the session writes it (tmp + rename; UUID name only) | Forge after polling + board event `completed` | route 404 / file never written | tmp only → Forge keeps polling (file incomplete = not there yet) | session dies mid-task → Forge's poll times out → board event `timeout` + a `tell` to the user; a **stale** verdict (exchange_id of a finished exchange) is ignored, never applied to a new task | 24 h bus sweep (unchanged) |
| Scoped `unknown` request tag | `load()` tags the conversation when flipping `running`→`unknown` | **only** a receipt or an explicit user reconciliation transitions it to a terminal state — never auto-`failed` | unchanged (remote, not bus) | unchanged (remote state file, atomic) | unchanged | 30 d retention (unchanged); scoped count is derived, not stored; records without conversation metadata are excluded from per-chat counts |
| `exchanges.lock` (M1) | O_EXCL create with `{host_pid, host_started_at}` per write/compaction | released after the write | not taken | lock left behind → stale only when holder host is proven dead, then removed | holder host dead → next writer removes it | held for one write/compaction only |
| Per-alias FIFO (M5) | in memory, in the owning window | drained per turn | not created | in-memory only: queued-but-unsent messages are lost with the window → recovery writes a `timeout` event for each `accepted`-but-not-`started` exchange of a dead owner host | same as crash | bound e.g. 20; overflow → `rejected` |
| `endpoint.json`, `forge.sh`, `README.md`, `inbox/`, `outbox/` | (unchanged — AGENT_MESSAGING_PLAN) | (unchanged) | (unchanged) | (unchanged) | (unchanged) | (unchanged) |

CI row: extend the existing bus-folder test to allow `exchanges.jsonl`,
`aliases.json`, `ownership/` (per-alias records + claims), `exchanges.lock`, and `status/` (empty when idle),
and still fail on any other stray file. An event is written on **every**
transition, so the board and the doors can never disagree about what happened.

## Phases

0. **P0 — identity + ownership + transport truth (the foundation).** Alias
   registry + one-time consented creation; `ownership.json` + creation lease +
   startup recovery (owner-host-aware, M2/M3); the delivery state machine (§2) wired into the board
   events **with the `exchanges.jsonl` writer, lock and compaction (M1/M8)**; `from`/`to`
   alias validation (§4) + host-side relay (M6); per-alias FIFO (M5); host-side wait + cost guard (M7); `tell_live_session` as a distinct typed primitive (§1); owned Codex
   session via the existing `CodexAppServerSession` with real `started`/
   `completed` states. **Exit gate: one Forge-owned session per agent, one
   message at a time, with explicit ownership and truthful states** (Codex, §1).
   Nothing in P1–P5 may claim a state the transport cannot prove.
1. **P1 — scoped `/status` + finished notice.** Scoped `requestHealth()`
   (per conversation, old records excluded); `unknown` stays `unknown` (§5);
   auto "turn finished" line for bus-started turns (crash case at recovery).
2. **P2 — the board (render only; the writer shipped in P0).** Sidebar render; Telegram `/status` bounded
   board line + "Live sessions" line.
3. **P3 — standby/wake + `/steer` + queue visibility.** The §2b state machine
   (park/wake/steer/death/restart, per adapter); `forge.sh cmd` allowlist with
   the typed lifecycle operations (§8); bus queue in the Telegram view;
   `{"queued": N}` clarification.
4. **P4 — Claude owned session + Codex discovery (both separately tested).**
   Persistent stdio Claude session with the same lifecycle semantics as owned
   Codex; **and** the Codex discovery adapter (`codex agents --remote`) with a
   versioned contract + hermetic compatibility test. Each lands only when its
   own tests pass — they are enhancements, not prerequisites.
5. **P5 — documentation + tool-description cleanup.** FORGE.md agent-bus bullet
   (drop the obsolete ENOENT workaround); `ask_live_session` / `ask_local_agent`
   / `tell_live_session` descriptions aligned with the alias/ownership model
   (§10). Lands last so the prose describes shipped behavior.

## Risks
- **The board is a new durable file.** Single writer (the backend) + scoped
  events + whole-exchange compaction are the contract; the CI row enforces
  "nothing else in the folder."
- **Owned sessions are privileged.** `danger-full-access` + `approval_policy=
  never` — the first creation is consented and the alias is persisted, so a
  restart never silently re-adopts a stranger.
- **Warm is not free.** A long-lived session's transcript grows: input tokens
  rise and compaction can trigger. Bounded context maintenance (a handoff/
  summary boundary) is a P4 concern; the cost acceptance test (§, criterion 14)
  measures it over a long run instead of assuming warm = cheap.
- **Codex liveness for user-opened sessions is not provable.** The owned session
  is the fix; a user-opened sidebar session honestly stays at `accepted` until a
  verdict file appears.
- **Full mesh is a relay, not a peer wire.** The board must render relayed
  exchanges as such (two hops, one `exchange_id`) — never as a direct route.

## Acceptance criteria
Each maps to a test or a named manual step. v2 criteria replace v1's where the
numbering differs.

1. **Session resolution:** no match, one match, multiple matches (refuse, list
   them), stale pin, invalid pin, concurrent create (exactly one session via the
   creation lease), process death, restart, user-owned vs Forge-owned. (Unit +
   integration: fake registry/discovery + fake spawn; assert one session per
   alias.) **Plus (M2): two extension hosts** — window B's startup recovery
   leaves window A's live owned session untouched; a slow-but-live claimant is
   never raced into a second spawn.
2. **Transport truth:** a successful pipe write or `codex queue` exit advances
   **only** to `accepted`; tests prove the transitions to `started` and
   `completed` for an owned session (including a message sent during a running
   turn — it must not start a second turn); a user-opened session stays at
   `accepted` until a verdict file appears. (Unit: fake adapters per state.)
3. **Standby is real:** park, restart Forge, wake, steer-while-parked, duplicate
   wake, queued-while-parked, process death while parked, `close`. Tests verify
   "warm" is real (session identity + context survive a park/wake) and that no
   model-side polling occurs. (Integration: owned Codex session; assert
   `send()` after park starts a new turn in the same `threadId`.) **Plus (M3):**
   after the owner host dies, the next message resumes the **same** `threadId`
   in a new process without consent; a failing `thread/resume` produces a
   visible `context_lost` event, never a silent fresh thread. **Plus (M5):** a
   `tell` during an active turn queues (no throw, no second turn); queue
   overflow is `rejected` and reported.
4. **Ledger safety:** two writers (serialized through the single writer queue),
   retries, duplicate `event_id`, out-of-order transitions, torn writes, crash
   during compaction, TTL/last-N boundaries (whole-exchange removal only),
   malformed lines, startup recovery. **Two processes** appending concurrently
   while a third compacts (M1): no lost line, no interleaved line; a
   non-terminal exchange survives compaction regardless of age or N (M8). The
   result never loses a committed event or shows a false `completed` state. (Unit: simulate each; assert derived
   state.)
5. **Verdicts:** UUID correlation, atomic write, timeout, late answer (orphan,
   announced once), duplicate answer, **stale answer after restart is ignored**,
   cleanup only after the terminal board event is durable. (Integration.)
6. **Scope and authorization:** two workspaces, two conversations, two Telegram
   chats, unknown sender, forged sender name, and a user-owned session targeted
   by `close` (rejected — no ownership record). No board event or command
   crosses its scope; Telegram never renders another conversation's exchanges;
   an unscoped event never reaches Telegram (M9). **Relay (M6):** Codex→`to:
   claude` is forwarded by the host with zero Forge model turns, two hop events
   share one `exchange_id`, unknown `to` is rejected, a relay of a relay is
   refused. (Unit + remote test.)
7. **`/status`:** old records without metadata are excluded from per-chat
   counts; scoped unknown counts; crash/reload; `unknown` **stays** `unknown`
   until a receipt or explicit reconciliation (the test documents why);
   Telegram identity for an unbound `/status` (M9: "no conversation bound",
   no count, no board line, never global numbers). (Unit on the scoped
   `requestHealth`.)
8. **Finished notice:** when a bus-started turn ends, the sender gets one
   `finished · …` line + a board event; the crash case sends it at **recovery**,
   exactly once (idempotent by event id). (Integration.)
9. **One-way push:** `tell_live_session` delivers and returns within ~1 s
   **without** waiting for a reply; a board event `accepted` is written;
   percentage-style progress is coalesced (no supervisor wake for non-terminal
   updates). (Unit: fake `sendClaude`/`queueCodex` + assert no `waitForReply`.)
10. **`/steer` on the bus (P3):** a `priority=steer` bus message interrupts a
    running turn (same as remote steer, reusing `parseSteerCommand`) and wakes a
    parked session. (Integration.)
11. **Queue visibility (P3):** the Telegram queue view lists pending bus
    messages labelled as agent-bus items; `{"queued": N}` is documented as a
    length. (Remote test.)
12. **Telegram board + live sessions (P2):** `/status` shows the last few
    exchanges *for this conversation* and a "Live sessions" line (alias, state).
    (Remote test: seed `exchanges.jsonl`, assert scoped output.)
13. **Command surface is typed (P3):** `say`, `steer`, `standby`, `wake`,
    `handoff`, `close`, `status`, `board`, `peers`, `queue`, `context` are typed
    operations through one owner; `close` requires a proven ownership record.
    (Unit: one owner, per-command authorization.)
14. **Cost (measured, manual step):** a measured run demonstrates **zero model
    polling turns** while waiting (host-side wait), bounded notification
    wakeups, and records input-token behavior over a long reused session (the
    "warm is not free" baseline). (Named manual step: a 30-min relayed
    exchange, token counts before/after.)
15. **Docs and tool descriptions match the model (P5).** The FORGE.md ENOENT
    "Windows workaround" is gone; `ask_live_session` says alias/consent;
    `ask_local_agent` is the cold-session fallback; `tell_live_session` is a
    notification, not an ask. (Manual: diff FORGE.md + the three descriptions.)
16. **`npm run ci` green; no file over 500 lines; OWNERS rows present.**
