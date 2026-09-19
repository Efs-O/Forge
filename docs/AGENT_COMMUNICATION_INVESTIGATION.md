# Forge ↔ Claude Code ↔ Codex communication — investigation report

Date: 2026-09-19. Scope: the agent-bus / live-session / delegation layer in `src/`,
traced file-by-file against the two source docs (copied into this folder):

- `docs/CODEX_MESSAGING_AND_FINDINGS.md` — Part A (the Codex ENOENT) + Part B (Halluscribe review).
- `docs/TODO-agent-bus-steer-and-queue-visibility.md` — 8 items raised 2026-09-18/19.

Goal stated by the user: **full-auto communication between Forge, one live Claude
session, and one live Codex session during an implementation or a plan discussion —
without opening cold sessions, and without burning Codex tokens while it waits.**

---

## 0. TLDR

- **The Codex ENOENT is fixed** (this session): `resolveCliExecutable` now prefers the
  `.cmd` shim on Windows. Verified: 7/7 unit tests + clean type-check. Needs a VSIX
  rebuild + window reload to be live.
- **The deeper problem is architectural, not a one-line bug.** Forge has exactly **one**
  way to reach a supervisor: `ask_live_session`, which **blocks** until an answer arrives.
  There is **no one-way push** from Forge to a supervisor, and **no push-to-wake** for
  Codex. That single fact causes three of the eight TODO items (non-blocking progress,
  queue visibility, and the Codex token burn) and it is the thing to fix first.
- **Codex cannot be woken except by `codex queue`, which only delivers *between* turns.**
  So a Codex supervisor that "waits" by polling through the model burns ~127K input
  tokens per poll (the observed ~850K in minutes). The only correct pattern is
  **push-then-idle**: Forge pushes via `codex queue` when there is something to say,
  Codex stays fully idle, and answers by writing a verdict file Forge polls (cheap).
- **`/status` "N crash unknown" is a real bug**: `requestHealth()` counts every request
  that was `running` when Forge last crashed/reloaded, marks it `unknown`, and **nothing
  ever resolves it back** — it lingers for the full 30-day retention, and the count is
  **global**, not per conversation/workspace. That is why "2 crash unknown" shows
  everywhere.
- **Recommended topology** (detail in §5): keep **one** live Claude session (peer pipe,
  free, bidirectional Q&A) + **one** live Codex session (push + verdict file, idle
  between pings). Keep `ask_local_agent` as a **cold fallback** only. Add a one-way
  `tell_live_session` (or `ask_live_session` with `wait: false`) so Forge can push
  progress/finished-notices without blocking or costing the supervisor a reply.

---

## 1. The three communication doors (architecture map)

Everything lives under `src/agentBus/`, `src/tools/liveSessionTool.ts`, and
`src/backend/agentRoutes.ts`. The bus folder is `~/.forge/agent-bus/` (OS profile,
never the workspace). Files: `endpoint.json` (url+token, rotated per start),
`forge.sh` (the client), `inbox/` (questions Forge is waiting on), `outbox/` (file
answers).

| Door | Direction | Mechanism | Cost | Blocking? |
|------|-----------|-----------|------|-----------|
| **A. Forge → Claude (question)** | Forge asks, waits | `ask_live_session(target: claude)` → peer pipe (`claudePeer.sendPeerMessage`) or `relay` (`claudeRelay`, a `claude -p` one-shot) | pipe: free/instant · relay: ~$0.10 | **Yes** — `waitForReply` up to `wait_minutes` (≤20) |
| **B. Forge → Codex (question)** | Forge asks, waits | `ask_live_session(target: codex)` → `codex queue --thread <id>` (`codexDelivery.queueToCodex`) | free | **Yes** — same `waitForReply` |
| **C. Claude/Codex → Forge (message)** | supervisor drives | `forge.sh say <name>` → `POST /agent/message` → `AgentInbox` (in-memory FIFO) → visible Forge turn | free | No (queued; one turn per message) |
| **D. Claude/Codex → Forge (answer)** | answers a question | `forge.sh reply <id>` → `POST /agent/reply` → `outbox/<id>-reply.md` | free | No — `waitForReply` polls the file |

Key structural facts, all confirmed in code:

1. **Forge → supervisor is one-way-out only via a blocking question.** There is no
   `tell`/`notify` primitive. `liveSessionTool.ts` has exactly two outbound paths
   (`deliver` for claude/codex) and both end in `waitForReply`. A "50% done" note from
   Forge is therefore impossible without the supervisor replying.
2. **The inbound queue (`AgentInbox`) is memory-only and separate** from the remote
   (Telegram) prompt queue. `agentInbox.ts` holds `queue: string[]`, `INBOX_CAP = 20`,
   drains one turn per message, and `accept()` returns the queue *length*, not a
   position. Nothing surfaces it to the Telegram queue view.
3. **`codex queue` is fire-and-forget.** `codexDelivery.ts` sets `QUEUE_TIMEOUT_MS =
   30_000`, collects only a stderr tail, and returns on exit 0. It confirms the message
   was *queued*, not that the session is alive or will process it. (Part A, open item 3.)
4. **Claude peer pipe is the cheap, free, bidirectional door.** `claudePeer.ts` reads
   `~/.claude/sessions/<pid>.json`, writes one framed message to the session's named
   pipe. `pickClaudeSession` refuses to guess between several sessions. This is the
   door that already works well.

---

## 2. What is actually broken (top priority, code-grounded)

### 2.1 Codex `ask_live_session` ENOENT — **FIXED this session**
`where codex` on this Windows host lists the extensionless npm shim
(`...\npm\codex`, a 421-byte Unix shell script) **before** `codex.cmd`.
`resolveCliExecutable.defaultWhich` took the first match; Node cannot `CreateProcess`
an extensionless shim → `ENOENT`. The spawn layer (`cliProcess.spawnCliProcess`)
already wraps `.cmd` shims via `windowsCmdShim`, but never received one.

**Fix applied:** `src/agents/resolveCliExecutable.ts` — new exported `pickExecutable`
prefers the `.cmd`/`.bat` match on `win32` (reusing `needsWindowsCmdShellWrap`);
`defaultWhich` feeds all `where`/`which` matches through it. POSIX unchanged.
**Verified:** `test/unit/resolveCliExecutable.test.ts` 7/7 (3 new cases), `npm run
type-check` clean. **Not yet live** until VSIX rebuild + window reload.

Note the config already points the *delegation* `codex` model at the real vendored
`codex.exe`; only the **live-session** door used the bare `codex` name. The fix makes
the live door resolve to `codex.cmd`, which `spawnCliProcess` then runs through
`cmd.exe` correctly.

### 2.2 No one-way Forge → supervisor push (root cause of items 3, 8)
`liveSessionTool.ts` handler: `deliver()` then `await waitForReply(paths, id, waitMs,
signal)`. There is no `wait: false`, no `tell` verb, no status-file writer. Consequences:

- Forge cannot send a "started" / "50% done" / "turn finished" note without the
  supervisor consuming a reply (tokens) and Forge stalling (TODO item 3).
- The only existing "heartbeats" are internal (`OpenAIClient` stream-stall watchdog,
  `FileLease` for jobs) — none is visible to a supervisor.
- The interim workaround (worker appends to `docs/internal/briefs/BM-<n>.progress.md`)
  is manual and costs the supervisor's attention to read it.

### 2.3 Codex burns tokens while "waiting" (TODO item 8)
Observed 2026-09-19: a Codex supervisor polled a PowerShell session with
`write_stdin(yield_time_ms: 30000)`. Every 30 s poll is a **full model turn** that
re-sends the whole context (~127K input tokens, mostly cached) → ~850K input tokens in
a few minutes, with nothing happening. Worse, while that turn never ended, the queued
`codex queue` handover messages **could not be delivered** (`codex queue` delivers only
between turns) — so Codex was deaf exactly while it was "listening".

Root cause: **Codex has no push-to-wake.** The only inbound door is `codex queue`,
which lands between turns. So the *only* way a Codex supervisor can react to Forge is
to keep a turn alive — i.e. poll — which is precisely what burns tokens. This is not a
Forge bug Forge can patch away; it is a property of the Codex CLI. The fix is to
**change the pattern to push-then-idle** (§5.2), which requires the one-way push from
2.2 plus a verdict-file reply channel.

### 2.4 `codex queue` delivers only between turns (Part A, open item 3)
Even after the ENOENT fix, `ask_live_session(target: codex)` can report "delivered"
while the session is mid-turn and will not see the message until that turn ends. There
is no liveness/read-back ("session N is open and idle"). For a Q&A this is tolerable
(with the wait + orphan handling); for a supervisor it is the trap in 2.3.

### 2.5 `/status` "N crash unknown" is a stale global counter (TODO item 7) — **real bug**
Traced to `src/remote/RemoteRequestStore.ts`:

- `load()` (runs on every Forge start/reload) flips **every** request that was
  `running` to `unknown` (lines 69–73). That is the "crash" detection: a request that
  was in flight when the process died is, by definition, of unknown outcome.
- `requestHealth()` (lines 118–124) counts `state === 'unknown'` **across the whole
  global store** — not scoped to the calling conversation or workspace.
- **Nothing ever resolves `unknown` back to a terminal state.** I searched the codebase:
  the only transitions into `unknown` are `load()` (running→unknown) and the control-
  receipt path; the only *read* of `unknown` is the count in `requestHealth()`. There is
  no code that marks an `unknown` request completed/failed/cancelled.
- Retention: `RETENTION_MS = 30 * 24 * 60 * 60_000` (30 days, `RemoteStoreSchemas.ts:126`).
  The `mutate()` filter keeps a record while `updatedAt >= cutoff` **or** its state is
  `queued`/`running` — an `unknown` record is kept until its 30-day `updatedAt` expires.

So: two requests that were running when Forge last crashed/reloaded become `unknown`,
stay `unknown` for up to 30 days, and the count is shown **globally** in `/status`
(`remoteCommands.ts:71` → `crash-unknown=${status.requests.unknown}`). That is exactly
"2 crash unknown" appearing in every chat and workspace. Fix options in §6 (P1).

### 2.6 Codex reported as "not installed" (TODO item 5)
`liveSessionTool.ts` `NO_CODEX_THREAD` fires when `agent_bus.codex_thread` is unset:
"No Codex session is configured, so the question was NOT sent. … the user opens it in a
terminal with `codex resume <thread>` …". The model paraphrased "not configured" as
"not installed". The CLI *is* installed (codex-cli 0.153.2, on PATH). The message is
technically right but easy to misread. (Distinct from 2.1: 2.1 is the spawn bug once a
thread *is* set; 2.5/2.6 are the no-thread path.) Fix: reword to `CODEX_NOT_CONFIGURED:`
and say the CLI may be installed.

### 2.7 Supervisor identity lost after compaction (TODO item 4)
`forge.sh say <name>` → `POST /agent/message?from=<name>`. `from` is free text
(`FROM_PATTERN`, `agentRoutes.ts`), **not** validated against open Claude sessions.
`forgeInboundPrompt` (`busContent.ts`) then tells Forge to answer with
`ask_live_session: session: "<from>"`. If `from` is a role name like
`claude-supervisor` (not a real `/rename` session name), `pickClaudeSession`
(`claudePeer.ts`) fails — and after a compaction Forge no longer remembers which of two
open sessions was the right one. Fix: validate/accept a session id, and keep the sender
identity in turn metadata, not the transcript.

### 2.8 Bus queue not visible from Telegram (TODO item 2)
`AgentInbox` (in-memory) is a separate queue from the remote prompt queue, so the
Telegram queue view says "no messages in queue" while bus messages wait. `forge.sh say`
returns `{"queued": N}` where `N` is the queue *length*, not a position — nothing
documents that. Fix: surface bus messages in the queue view (labelled), and clarify the
`queued` return.

---

## 3. What already works well (do not rebuild)

- **Claude peer pipe (`claudePeer.ts`).** Free, instant, bidirectional, refuses to
  guess between sessions, reports every failure. This is the model for the whole
  system and the door to keep as the primary supervisor channel.
- **The bus file protocol (`agentBus.ts`).** Atomic `.tmp`→rename writes, TTL sweep,
  orphan handling (a late answer to a withdrawn question is announced once, never
  lost, never double-shown), `fg` id prefix so Forge never claims another asker's
  reply. This is solid and tested.
- **`pickClaudeSession`** never guesses. **`FROM_PATTERN`** bounds inbound names.
- **The `relay` escape hatch (`claudeRelay.ts`)** for a Claude Code whose pipe format
  Forge can't speak — opt-in, costs a model call. Good fallback.

The gaps are all about **push** (Forge → supervisor without blocking) and **Codex
liveness/cost**, not about the plumbing.

---

## 4. The 8 TODO items, mapped to code (status)

| # | Item | Where | Status / verdict |
|---|------|-------|------------------|
| 1 | `/steer` over the bus | `agentRoutes.ts` (only `/agent/message`, `/agent/reply`); `RemotePromptAdmission.parseSteerCommand` is the single owner | **Not built.** Bus has no priority/steer form. Reuse `parseSteerCommand`, don't copy. Open decision: may a bus steer interrupt a running turn (remote steer does) or only jump the queue? |
| 2 | Bus queue not visible from Telegram | `agentInbox.ts` (in-memory, separate); `remoteCommands.ts:71` | **Not built.** Separate queues; `queued` return is a length, undocumented. |
| 3 | Non-blocking progress Forge → supervisor | `liveSessionTool.ts` (only blocking `ask_live_session`); no status-file writer | **Not built — this is the root cause.** Needs `tell_live_session` (or `wait: false`) + optional `status/<turn>.json`. |
| 4 | Supervisor identity lost after compaction | `agentRoutes.ts` `from` free text; `busContent.forgeInboundPrompt`; `claudePeer.pickClaudeSession` | **Not built.** Validate `from` against open sessions / accept an id; keep identity in turn metadata. |
| 5 | Codex "not installed" misread | `liveSessionTool.ts` `NO_CODEX_THREAD` | **Message is right but misread.** Reword to `CODEX_NOT_CONFIGURED:` + "the CLI may be installed". Decide: auto-discover `codex_thread` or stay explicit. |
| 6 | Reuse existing features on the bus | `RemoteCommandHandler` (one owner); `update_plan` state; `OpenAIClient` stall watchdog | **Not built — high value, cheap.** `forge.sh cmd <slash>` → `POST /agent/command` (allowlist `/status /queue /context /stop /steer /view /compact`); mirror `update_plan` into `status/<turn>.json`; auto "turn finished" notice; stall detection. Priority: `cmd /status` + finished notice first. |
| 7 | `/status` "2 crash unknown" everywhere | `RemoteRequestStore.load()` (running→unknown), `requestHealth()` (global count), `RETENTION_MS` 30d | **Real bug — nothing resolves `unknown`; count is global.** See §6 P1. |
| 8 | Codex burns tokens while waiting | `codexDelivery.queueToCodex` (fire-and-forget, between-turns only); no push-to-wake | **Pattern problem, not a one-line fix.** Push-then-idle (§5.2) + cost guard. |

Part A open items (from the findings doc): (1) spawn target — **done (2.1)**; (2) thread
addressing by UUID (the double-space title is a red herring — the tool uses the UUID,
confirmed in `liveSessionTool.ts`); (3) delivery verification / liveness — **open (2.4)**;
(4) no read channel from Forge — **by design, the verdict-file pattern in §5.2 is the
answer**.

---

## 5. Recommended topology (the design direction)

Principle: **one live Claude session + one live Codex session, both reused; no cold
sessions unless we explicitly want one.** Claude is the *bidirectional* supervisor
(free peer pipe); Codex is the *push + verdict* worker (idle between pings).

### 5.1 Roles
- **Claude (peer pipe):** the conversational supervisor. Forge asks with
  `ask_live_session(target: claude)`; Claude answers with `forge.sh reply <id>`. Free,
  instant, bidirectional. This is the default "other half of the task" door.
- **Codex (push + verdict):** the implementation worker. Forge *pushes* work with
  `codex queue --thread <id>` (one-way, free, between-turns). Codex does the work and
  **writes a verdict file** (e.g. `~/.forge/agent-bus/outbox/<id>-reply.md` or a named
  `<task>.verdict.md`); Forge polls that file (cheap `stat`, no model tokens). Codex
  stays **fully idle** between pings — no polling turn, no token burn.
- **`ask_local_agent` → codex/claude-code:** the **cold fallback** only — when there is
  no live session, or we explicitly want a fresh, isolated context. Never the default.

### 5.2 The push-then-idle pattern (fixes items 3 + 8 together)
1. Forge needs to tell Codex something (a task, a progress note, "you can stop"):
   `codex queue --thread <id> --message "<text>"`. Free, one-way, returns at once.
2. Codex, if it must wait for Forge, does **ONE blocking shell call** — a bash loop
   that sleeps and returns only when `inbox/*.pending` (or the verdict target) appears,
   capped at ~25 min. **Never** poll through the model (`write_stdin`/`yield`).
3. Forge, if it must wait for Codex, polls the **verdict file** (a local `stat`), not a
   model round-trip.
4. Net: both sides idle while waiting; tokens spent only on actual work.

This requires the one-way push primitive (item 3) to exist as a tool so Forge doesn't
have to burn a blocking `ask_live_session` to send a "started/finished" note.

### 5.3 `ask_live_session` vs `ask_local_agent` — recommendation
- **Keep both.** They are different tools, not duplicates:
  - `ask_live_session` = reach a session that **already knows the work** (peer pipe /
    `codex queue`). Bidirectional Q&A. **Primary.**
  - `ask_local_agent` = a **fresh, unrestricted** CLI session with its own tools, no
    VRAM, no shared context. **Fallback** when no live session exists or isolation is
    wanted.
- **Do not consolidate** into one: the routing rule ("live vs cold") is exactly the
  thing the model gets wrong, and it already lives in `ask_live_session`'s description
  (the reason it was made a tool rather than a FORGE.md paragraph). Merging would blur
  that.
- If anything changes: give `ask_live_session` a **`wait: false` / `tell` mode** (item 3)
  so it can also do one-way push, and keep `ask_local_agent` strictly for cold starts.

### 5.4 Heartbeat / status without tokens
- Write `~/.forge/agent-bus/status/<turn>.json` while a bus-started turn runs:
  `{started_at, last_activity_at, tool_calls, state, plan: {done, total, current},
  context_pct}`. Mirror `update_plan` state (zero model tokens, always accurate) and
  the `OpenAIClient` stall watchdog (`state: stalled`).
- Auto "turn finished" notice: when a bus-started turn ends (done / error / `/stop` /
  crash), Forge itself sends the sender one line (`finished · 23 min · last message:
  …`). The model doesn't have to remember → no silent stalls.

---

## 6. Prioritized fix list

**P0 — already done**
- Codex ENOENT spawn fix (`resolveCliExecutable.pickExecutable`). Verified. Awaiting
  VSIX rebuild + reload to be live.

**P1 — do first (removes the biggest blind spots, small surface)**
1. **One-way push:** add `tell_live_session` (or `ask_live_session` with `wait: false`).
   Deliver a note to a Claude peer pipe or `codex queue` and **return at once** — no
   `waitForReply`. This unblocks items 3 and 8.
2. **`/status` crash-unknown bug:** resolve `unknown` requests. Concretely: on `load()`,
   when flipping `running`→`unknown`, also record the conversation; and either (a)
   scope `requestHealth()` per conversation/workspace (the count a user sees should be
   *their* chat's), and/or (b) add a resolve path — when a request with a known terminal
   outcome is re-observed, or after a bounded grace period, transition `unknown`→
   `failed` (or drop it from the count). At minimum, **scope the count** so it stops
   showing the same global number everywhere.
3. **Auto "turn finished" notice** for bus-started turns (item 6, high value).

**P2 — cheap, high value (item 6 cluster)**
4. `forge.sh cmd <slash>` → `POST /agent/command` (allowlist `/status /queue /context
   /stop /steer /view /compact`), one owner = `RemoteCommandHandler`, destructive ones
   logged in `RemoteAuditLog`.
5. Mirror `update_plan` + stall watchdog into `status/<turn>.json` (item 3/6).
6. Reword `NO_CODEX_THREAD` → `CODEX_NOT_CONFIGURED:` + "the CLI may be installed"
   (item 5).

**P3 — needs a decision**
7. `/steer` over the bus (item 1): reuse `parseSteerCommand`; decide interrupt-vs-jump.
8. Bus queue visibility in the Telegram view + clarify `{"queued":N}` (item 2).
9. Supervisor identity: validate `from` against open sessions / accept an id; keep it
   in turn metadata (item 4).
10. Codex liveness check before declaring delivery (Part A item 3) + a cost guard: a
    wait loop that has done > N empty model turns stops and tells the user (item 8).
11. Decide: auto-discover `codex_thread` (latest codex session for this workspace) vs
    stay explicit (item 5).

---

## 7. Part B — Halluscribe review findings (reference only)

These are **Halluscribe repo** (Rust/Svelte) findings, not Forge. Carried here for
continuity per the user's instruction; **not investigated or fixed in Forge.**

| # | Sev | Problem (Halluscribe) | Disposition |
|---|-----|----------------------|-------------|
| 1 | High | `load_contact_book` (apple_messages/whatsapp/viber) treats a *copy failure* the same as *file absent* → silently empty contact book. | **FIXED** (Halluscribe): check `handle.resolve(...).is_none()` first; present-but-copy-fails → `ReaderError::Database`. |
| 2 | Med | `scan_whatsapp`/`scan_viber` collapse `Err(_)` into "no targets" → a provider open failure is invisible. | **FIXED** (Halluscribe): `Ok(false)`→no target; `Err(e)`→diagnostic then no target. |
| 3 | Med | `BusinessMessagesSettings.svelte` status re-fetch `.catch` swallowed the failure → stale owner-profile warning. | **FIXED** (Halluscribe): sets `workspaceError`. |
| 4 | Low/med | `read_profile_md` maps *every* read error (missing or corrupt) to `None` → "no profile". | **DEFERRED** (accepted limitation): distinguishing "unreadable" needs a richer return type + a 4th `ChatProfile` state; `profile/mod.rs` is at the 500-LOC ceiling. |
| 5 | Known | Viber group-ness inferred from distinct incoming senders, not `ZGROUPID`. | **KEPT** (plan-mandated heuristic). |

Deferred product decisions: BM-8 D10 "summary pending" (needs semantics decision);
BM-9b `OwnerProfileNotFound` in-chat vs settings-only (needs product decision).

---

## 8. Open questions for the user (before implementation)

1. **Topology confirmation** — is §5 (one live Claude bidirectional + one live Codex
   push/verdict, `ask_local_agent` as cold fallback) the shape you want, or do you want
   Codex also to be able to ask Forge questions (true bidirectional)?
2. **`/status` crash count** — scope it per conversation/workspace (my recommendation),
   or also auto-resolve `unknown`→`failed` after a grace period?
3. **`/steer` on the bus** — may a bus steer **interrupt** a running turn (like remote
   steer), or only jump the queue?
4. **`codex_thread`** — auto-discover the latest codex session for this workspace, or
   keep it explicitly set in config?
5. **Scope of this turn** — I've delivered the investigation + this report + the TLDR.
   Do you want the **P1 fixes implemented next** (one-way push, `/status` scope,
   finished notice), or a different order?
