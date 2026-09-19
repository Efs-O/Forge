# HANDOFF — Agent mesh: Codex review retry (2026-09-19)

**Why this file exists:** the user is compacting this chat. A resumed turn reads
this first. Everything below is verified state as of 15:23 local, 2026-09-19.

## Where we are
- **Plan is written and self-reviewed:** `docs/plans/AGENT_MESH_PLAN.md`
  (full-mesh Forge↔Claude↔Codex, board in Forge sidebar + Telegram `/status`,
  one-way push `tell_live_session`, Codex push-then-idle, `/status` crash count
  scoped per conversation, bus `/steer` may interrupt, unambiguous addressing).
  Has the required State×lifecycle ledger (before Phases) + 13 acceptance criteria.
- **Investigation report:** `docs/AGENT_COMMUNICATION_INVESTIGATION.md` (all 8
  TODO items traced to code; TLDR in §0).
- **Source docs copied in:** `docs/CODEX_MESSAGING_AND_FINDINGS.md`,
  `docs/TODO-agent-bus-steer-and-queue-visibility.md` (both force-added; `docs/*`
  is gitignored except `docs/plans/**`).
- **Codex ENOENT fix committed + shipped in 0.16.9:**
  `src/agents/resolveCliExecutable.ts` (`pickExecutable` prefers `.cmd` on
  win32) + 3 new unit tests (7/7 pass, type-check clean).
- **Commits on main:** `60df762` (fix + docs), `e8e5b2b` (0.16.9 bump + CHANGES.md).
  Working tree clean.
- **VSIX built + installed:** `forge-llm-0.16.9.vsix` (commit hash `7debcd0e2a`).
  **The running window still executes the OLD build until the user Reloads.**

## SUPERSEDED (2026-09-19, 17:17): the "hardcoded thread" model is GONE
The plan was rewritten after deeper investigation. **Do NOT follow the old
"confirm the live Codex thread" retry sequence below** — it assumed a hardcoded
`codex_thread` + a TUI, which was the hackjob the user correctly rejected.

**The corrected model (now in `AGENT_MESH_PLAN.md` §0 + P0 + P4 + criteria 13–16):**
- **Detect-or-create for BOTH doors.** The user is never the courier.
  - **Codex:** `codex agents --remote <endpoint>` discovers live sessions on the
    shared app-server daemon (the sidebar's `codex.exe app-server` IS that daemon,
    PID 14232). `codex queue --thread <UUID-or-name>` delivers. Spawn-and-own
    when none is live. `codex_thread` config = optional pin, not required.
  - **Claude:** ALREADY discovers via `~/.claude/sessions` registry
    (`readClaudeSessions`/`pickClaudeSession`, refuses to guess). Only the
    **create** path is missing (currently errors "user has to open one first").
  - **Discovery is token-free** (CLI/registry read, not a model completion).
  - **Ownership:** Forge reaps sessions it spawned; never reaps a user-opened one.
- **`codex agents` needs `--remote <endpoint>` on Windows** (verified: bare
  `codex agents` errors "requires --remote"). The endpoint source is the one open
  implementation detail — verify at build time; spawn-and-own is the fallback.
- **New phases:** P0 = discovery (foundational, lands first), P4 = FORGE.md +
  tool-description cleanup (the ENOENT "Windows workaround" in FORGE.md is now
  obsolete — the fix shipped in 0.16.9).

**Next action (revised):** the user has reloaded (0.16.9 live). The plan is
rewritten + self-reviewed. Give the user the TLDR of the corrected plan; the user
decides whether to (a) run the Codex review on it, or (b) start P0 implementation.
**Do not** ask the user to confirm a thread ID — that's the whole point of §0.

## Why the earlier attempts failed (do not repeat)
- **The "confirm the thread ID" framing was itself the bug.** The user has to
  know which session is live = the hardcoded-thread hackjob. §0 (detect-or-create)
  removes it. `codex agents` is the discovery call; the sidebar app-server is the
  daemon it lists.
- **`ask_live_session(target: codex)`** (pre-reload): the ENOENT bug — fixed in
  source, only live after reload.
- **`codex queue --thread 01a0a9a1…`** (14:41, queued id `01a0b978…`): no open
  Codex CLI session was attached to that thread (only the VS Code extension
  `codex.exe app-server` PID 22712 was running), so the message sat undelivered.
  `codex queue` delivers only to an OPEN `codex resume <id>` TUI, between turns.
- **`ask_local_agent` → codex** (14:47): 600 s delegation timeout; the spawned
  Codex (PID 26316, `app-server --stdio`) was orphaned when Forge dropped the
  pipe, ran ~25 min, exited with no verdict file. If retrying `ask_local_agent`,
  keep the task SHORT (one focused question) so it fits in 600 s, and check
  `git status` after a timeout — it may have done partial work.

## User decisions already locked (do not re-ask)
1. Full mesh — all three talk to each other; **the user must see every exchange**.
2. `/status` crash count: **scoped per conversation** (my rec, accepted).
3. Bus `/steer`: **may interrupt** a running turn.
4. Addressing: **must be unambiguous** (validate against live sessions).
5. Board: **Option A (central board in Forge sidebar) + Telegram mirror**
   (`/status` shows the last few exchanges). Each agent's own window still shows
   its messages as before; the board is the user's consolidated view.
6. This turn was plan+review only — **no implementation yet**. After the Codex
   review + corrections + final TLDR, the user decides how to proceed (P1 first:
   one-way push, `/status` scope, finished notice).

## Key file map (verified)
- Doors: `src/tools/liveSessionTool.ts` (ask_live_session, NO_CODEX_THREAD),
  `src/agentBus/codexDelivery.ts` (codex queue), `src/agentBus/claudePeer.ts`
  (peer pipe + pickClaudeSession), `src/agentBus/claudeRelay.ts` (relay),
  `src/agentBus/agentBus.ts` (files, waitForReply, orphans, TTL 24 h),
  `src/agentBus/agentInbox.ts` (in-memory FIFO, cap 20),
  `src/backend/agentRoutes.ts` (`/agent/message`, `/agent/reply`, token).
- Spawn: `src/agents/cliProcess.ts` (spawnCliProcess wraps .cmd via
  `windowsCmdShim.ts`), `src/agents/resolveCliExecutable.ts` (THE FIX).
- `/status` crash count: `src/remote/RemoteRequestStore.ts` — `load()` flips
  running→unknown (lines ~69-73), `requestHealth()` counts globally (~118-124),
  `RETENTION_MS` 30 d (`RemoteStoreSchemas.ts:126`); shown at
  `src/vscode/remoteCommands.ts:71`. **Nothing resolves unknown→terminal.**
- Bus folder (real): `C:/Users/efso office/.forge/agent-bus/` (endpoint.json,
  forge.sh, README.md, inbox/, outbox/).

## House rules that apply to the implementation (when it starts)
- Plan doc needs Acceptance criteria + State×lifecycle ledger — DONE, keep them
  current as the plan changes.
- Commit straight to main (solo repo); run `npm run ci` first.
- `docs/*` gitignored — force-add new docs (`git add -f`).
- CHANGES.md is the release source of truth; CHANGELOG.md is generated.
- 500-LOC hard ceiling per file; OWNERS rows for new files.
- VSIX: `npm run package` in background (~3 min, 24 s this time); the check
  script refuses to overwrite an existing vsix of the same version.
- Install: `Code.exe` + `ELECTRON_RUN_AS_NODE=1` + `cli.js` (commit hash
  `7debcd0e2a` as of today), NO quotes around spaced paths.
