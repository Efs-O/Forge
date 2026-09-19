# HANDOFF — Agent mesh IMPLEMENTATION (2026-09-19, ~23:46)

**Why this file exists:** the user is compacting before the implementation phase.
A resumed turn reads this first. The plan is FINAL (v2.1, GO from both auditors).
Everything below is verified state as of 23:46 local, 2026-09-19.

## The plan is DONE and approved — do NOT re-review it
- **Plan:** `docs/plans/AGENT_MESH_PLAN.md` = **v2.1** (my v2 + Claude's normative
  "v2.1 audit amendments M1–M9" section right after "Why").
- **Codex review:** `docs/CODEX_PLAN_REVIEW_2026-09-19.md` (NO-GO on v1; all gaps
  A–H addressed in v2/v2.1).
- **Claude audit:** returned **GO for v2.1**, edited the plan in place. Its key
  finding: **multi-window** — each VS Code window is its own extension host sharing
  `~/.forge/agent-bus`; v2's "reap if I don't hold the pipe" would kill a peer
  window's session, and "single writer, one process" was false. Fixed via M1/M2
  (per-alias `ownership/<alias>.json` with `owner_host{pid,started_at}`; reap only
  on DEAD owner host; O_EXCL `exchanges.lock`; creation claim stale only on
  claimant-host death).
- **I (Forge) reviewed v2.1 and concur.** Ledger rows + acceptance criteria
  (16, strengthened) are consistent in the file.

## The plan = 6 phases (implement in this order)
- **P0 foundation:** alias registry + consented first creation; per-alias
  ownership records + owner-host-aware recovery + creation lease; delivery state
  machine (accepted→observed→started→completed); `tell_live_session` typed
  primitive; owned Codex session via existing `src/agents/CodexAppServerSession.ts`;
  **event-log writer + interprocess lock + compaction; host relay (from/to);
  per-alias FIFO; host-side wait + cost guard** (all in P0 per M7).
- **P1:** scoped `/status` (per conversation; `unknown` stays `unknown`); auto
  "turn finished" notice (crash case at recovery).
- **P2:** render-only — sidebar Agent board + Telegram bounded board line +
  "Live sessions" line.
- **P3:** standby/wake state machine (per adapter); `/steer` on the bus; typed
  command surface; bus queue visibility in Telegram.
- **P4:** Claude owned stdio session + Codex discovery adapter — each separately
  tested, enhancements not prerequisites.
- **P5:** FORGE.md + the three tool descriptions aligned with alias/ownership.

## Implementation strategy (user's instruction, 2026-09-19)
**Phase-by-phase, gated:** implement a phase → validate (tests + CI) → commit →
next phase. The user wants to validate each phase before moving on.

**Review-per-phase decision (user's question, my recommendation — CONFIRM on
resume):** do NOT wait on Codex for every phase. Codex is on the OpenAI Plus slow
queue (3 attempts today = ~180 min, all network-killed; the resume that finally
worked took ~57 min). A per-phase Codex gate would take days. Instead:
- **Self-review each phase** against its acceptance criteria (I have the full
  context; this is the cheap, fast gate).
- **Run CI after every phase** (`npm run ci` — type-check + lint + tests).
- **One Codex review at the end of P0** (the foundation — highest risk, and it
  exercises the multi-window/ownership/transport-truth seams Codex cares about).
  Fire it in the background EARLY (right after P0 commits) so it runs while I do
  P1; fold in its findings before P2.
- **One Codex review at the end of P3** (standby/wake + command surface — the
  second riskiest). Same fire-early pattern.
- P4/P5 are lower-risk (separately-tested enhancements + docs) — self-review + CI.
- Use the **resume pattern** if a Codex run dies (it will, probably): `codex exec
  resume <session-id>` — it picked up correctly both times.
- If Codex is unreachable for a phase gate, **proceed on self-review + CI** and
  tell the user (do NOT block the run on the queue).

**Codex invocation that works (verified):**
```
node "C:/Users/efso office/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js" \
  exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  "<task: read <plan>, review <phase>, write verdict to
   C:/Users/efso office/.forge/agent-bus/codex-<phase>-review.md.tmp then rename
   to .md, end with REPORT: <path>>"
```
Run with `exec_command background:true`, cwd = `n:\vs code apps\Forge`. Poll the
verdict file (OS-profile path, NOT the workspace). Expect the OpenAI queue; the
process can run 30–90 min. On failure, `codex exec resume <session-id>` with the
same "continue and write the file" prompt.

## House rules for the implementation (from FORGE.md / project instructions)
- **Commit straight to main** (solo repo). Run `npm run ci` first; commit per phase.
- **`docs/*` is gitignored** — force-add new docs (`git add -f`). The plan + Codex
  review are already tracked (force-added earlier).
- **500-LOC hard ceiling per file; OWNERS rows for new files** (`docs/OWNERS.md`).
- **CHANGES.md** is the release source of truth (CHANGELOG.md is generated). Add a
  0.16.x entry describing the agent-mesh feature when it lands.
- **State×lifecycle ledger is the contract** for every durable artifact
  (`aliases.json`, `ownership/<alias>.json`, `ownership/<alias>.claim`,
  `exchanges.jsonl`, `exchanges.lock`, `status/<turn>.json`, verdict files).
  Follow it exactly — the whole point of the plan is that these seams are safe.
- **`config.yaml` is NEVER written back by code** — alias/ownership live in
  `~/.forge/agent-bus/`, not config. The `codex_thread`/`claude_session` config
  values become DEPRECATED pins (alias wins).
- **Test layout:** `test/unit` (fast), `test/integration` (real processes/git,
  hermetic), `test/live` (real models, skipped by default), `test/webview` (DOM).
  `npm test` runs the non-live set. CI = `npm run ci`.
- **A Forge-owned Codex session runs `danger-full-access` + `approval_policy=never`
  (via `codexAppServerArgs`).** First creation is consented; resume-without-consent
  (M3) is correct only because the alias was consented once. Keep it that way.

## Key file map (verified) — start here, don't re-discover
- **Owned Codex session (REUSE, don't rebuild):** `src/agents/CodexAppServerSession.ts`
  (warm `app-server --stdio` JSON-RPC; `send()` per turn, `threadId`, interrupt,
  dispose). `send()` **THROWS during an active turn** and resolves at turn END →
  the per-alias FIFO (M5) is required before `tell` can use it.
  Launch args: `src/agents/codexAppServerArgs.ts`.
- **Doors:** `src/tools/liveSessionTool.ts` (`ask_live_session`; add
  `tell_live_session` as a DISTINCT tool, not `wait:false`);
  `src/agentBus/claudePeer.ts` (`readClaudeSessions`/`pickClaudeSession`/
  `sendPeerMessage` — the Claude detect path, works);
  `src/agentBus/codexDelivery.ts` (`queueToCodex` — fire-and-forget, exit 0 =
  `accepted` ONLY); `src/agentBus/agentBus.ts` (bus files, TTL, orphans);
  `src/agentBus/agentInbox.ts` (in-memory FIFO, cap 20);
  `src/backend/agentRoutes.ts` (`/agent/message`, `/agent/reply`; **line ~178 says
  each window is its own host** — the M1/M2 basis).
- **`/status` crash count:** `src/remote/RemoteRequestStore.ts` — `load()` flips
  running→unknown; `requestHealth()` counts globally; add per-conversation scope
  (P1). `unknown` stays `unknown` (no auto-resolve).
- **Steer:** `src/remote/RemotePromptAdmission.ts` `parseSteerCommand` (single
  owner — reuse for bus `/steer`, P3).
- **Bus folder (real):** `C:/Users/efso office/.forge/agent-bus/` (endpoint.json,
  forge.sh, README.md, inbox/, outbox/). New: aliases.json, ownership/, exchanges.jsonl,
  exchanges.lock, status/.
- **Codex review verdicts land in:** `C:/Users/efso office/.forge/agent-bus/`
  (OS profile). The plan + Codex review are mirrored into the workspace at
  `docs/CODEX_PLAN_REVIEW_2026-09-19.md`.

## Residual risks (Claude's, to keep in mind during implementation)
1. Thread resume after a mid-turn kill is UNPROVEN — criterion #3's live test must
   pass before M3 is trusted.
2. Windows rename-over-open-file EPERM on compaction — the sidebar file watcher must
   not hold a handle open.
3. Last-N=200 is global across workspaces (busy evicts quiet). Acceptable v1.
4. Per-alias FIFO is in memory — queued-but-unsent messages die with their window,
   surface as `timeout`, never replayed (deliberate: no silent duplicates).
5. Owned sessions are `danger-full-access` — resume-without-consent relies on the
   one-time alias consent.
6. A user-opened Codex session never goes past `accepted` — board shows many
   "queued" until a verdict. Honest, can read as broken.

## Where the user left off
The user chose: **implement each phase separately → validate → commit → next
phase**, and asked how to handle Codex review per phase. My recommendation
(confirmed in chat): self-review + CI gate every phase; one Codex review at the
end of **P0** and **P3** (fired in the background, folded in before the next
phase); P1/P2/P4/P5 are self-review + CI only. If Codex is unreachable for a
gate, proceed on self-review + CI and tell the user.

## P0 STATUS (in progress, 2026-09-19)
**Built + unit-tested (all green):** `src/agentMesh/` — hostIdentity,
deliveryState, exchangeLog (M1 lock + M8 compaction), aliasRegistry, ownership
(M2 lease + recovery, M3 thread-keep), aliasFifo (M5), hostWait (M7), adapters,
sessionProvider (M2/M3 owned-session lifecycle), meshOrchestrator (tell + M6
relay), meshContext. Plus `src/tools/tellLiveSessionTool.ts` (registered, 78th
tool), `src/vscode/agentMeshSetup.ts` (wiring + startup recovery), and the M6
relay branch in `src/backend/agentRoutes.ts` (`/agent/message?to=`).
New tests: AgentMesh{DeliveryState,HostIdentity,ExchangeLog,Ownership,
AliasRegistry,Orchestrator,BusFolder}.test.ts + TellLiveSessionTool.test.ts.
Tool-catalog tests bumped 76→77 / 77→78. OWNERS rows added. Version 0.16.10,
CHANGES.md entry added.
**Next:** full `npm run ci` must be green → commit P0 → fire Codex P0 review in
the background → start P1.

## Where the user left off
The user is deciding the full-auto implementation strategy and is about to
compact. On resume: **confirm the phase-by-phase + review strategy above** (or
take their new instruction), then start **P0**. Do not re-review the plan — it's
final. Implement P0, validate (tests + CI), commit, then fire the first Codex
review in the background and move to P1.
