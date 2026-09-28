# Copilot as a Forge-owned agent-mesh peer

**Status:** P0 transport GO; P1, P2, P3 implemented and verified; P4 live-validated (items 1–6 + the non-reload close); remaining: the user-driven VS Code reload for the resume/close cycle and the A11 terminal-state notifications (the running host predates `4f53b0d`)\
**Date:** 2026-09-27  
**Builds on:** [AGENT_MESH_PLAN.md](AGENT_MESH_PLAN.md) and
[AGENT_MESSAGING_PLAN.md](AGENT_MESSAGING_PLAN.md)

## Goal

Add GitHub Copilot CLI as the third first-class Forge agent-mesh peer, alongside
Claude Code and Codex.

Forge must be able to:

- create or resume one Forge-owned Copilot CLI session under the stable
  `copilot` alias;
- use `ask_live_session`, `tell_live_session`, and mesh `steer` with Copilot;
- relay Claude, Codex, Copilot, and Forge messages through the existing hub;
- show Copilot truthfully in `forge.sh who`, the mesh board, Forge UI, and
  Telegram `/status` and `/queue` projections;
- send the same bounded lifecycle, completion, failure, crash, and recovery
  notifications to the user-facing surfaces that already report Claude/Codex;
- preserve Copilot context across normal turns and extension-host reloads when
  the supported Copilot CLI exposes a resumable session identity.

Copilot runs as a coding agent with its own native tools and authenticated
subscription, matching the existing Codex CLI policy: Forge does not inject a
second tool loop into the Copilot process. The Copilot launch must grant the
same intended workspace capability as the owned Codex path, while remaining
explicit about the exact flags and approval policy the installed Copilot CLI
actually supports.

Within Forge's own tool catalog, Copilot must be a valid target anywhere Claude
or Codex is a valid mesh target. A Forge model therefore uses the same
`ask_live_session`, `tell_live_session`, lifecycle commands, FIFO, exchange
log, and permission gate for Copilot; no Copilot-only duplicate tools are
introduced.

## Scope boundary

The required transport is a **Forge-owned GitHub Copilot CLI session**. It is
not an attempt to inject text into, scrape, or interrupt an arbitrary existing
GitHub Copilot Chat tab in VS Code.

The existing owned Claude and Codex integrations establish the correct
comparison:

- owned Claude is a Forge-spawned streaming CLI process;
- owned Codex is a Forge-spawned app-server process;
- optional user-opened transports are separate, non-observing adapters.

If a future supported Copilot API exposes a user-opened session, that can be a
separate adapter. It is not required for this plan and must not block the owned
CLI peer.

This plan does not add a VS Code `languageModelTools` contribution and does not
make Copilot the supervisor of a hidden Forge conversation. That is a different
feature and was not requested.

## Current baseline and cleanup

The committed mesh already owns the reusable machinery:

- `src/agentMesh/meshAdapter.ts`: observing/non-observing transport contract;
- `src/agentMesh/sessionProvider.ts`: alias resolution, creation, resume,
  ownership, park/wake/close, and idle release;
- `src/agentMesh/aliasFifo.ts`: one turn per alias and priority steer;
- `src/agentMesh/meshOrchestrator.ts`: ask/tell/steer/relay and board events;
- `src/agentMesh/ownership.ts` and `aliasRegistry.ts`: durable identity;
- `src/agentMesh/boardView.ts` and `meshWho.ts`: UI/Telegram projections;
- `src/tools/liveSessionTool.ts` and `tellLiveSessionTool.ts`: Forge tool
  surface;
- `src/remote/RemoteSessionCommands.ts`: Telegram status and queue views;
- `src/vscode/agentMeshSetup.ts`: activation, notifications, recovery, and
  lifecycle maintenance;
- `src/agents/CliAgentDriver.ts` and adapters: reusable one-shot CLI parsing
  patterns, if the Copilot protocol matches them.

The current uncommitted Copilot slice implements the reverse direction:
Copilot Agent Mode invokes `forge_list_models` and `forge_delegate_task`, which
creates a hidden Forge conversation and returns its result to Copilot. It adds
no Copilot mesh alias, adapter, session, ownership, ask/tell/steer support, or
Telegram presence.

Unless the owner separately asks to retain that inbound-delegation feature,
remove all of that uncommitted slice before the first implementation commit:

- remove `src/vscode/copilotDelegationTools.ts`;
- remove `test/unit/CopilotDelegationTools.test.ts`;
- remove its registration from `src/vscode/agentMessagingSetup.ts`;
- remove its `languageModelTools` manifest contribution;
- remove test-only VS Code language-model stubs used solely by that slice;
- restore the previous `engines.vscode` floor unless the real Copilot CLI mesh
  requires a newer API for an independently verified reason;
- replace or remove `docs/reports/COPILOT_TRANSPORT_SPIKE.md`, whose conclusion
  concerns exact Copilot Chat UI injection rather than the required CLI peer.

Do not discard unrelated user changes. Stage only the files named by each
phase.

## Non-negotiable invariants

1. **One mesh, no parallel implementation.** Extend `AgentKind`,
   `MeshAdapter`, `MeshSessionProvider`, `MeshOrchestrator`, and their existing
   projections. Do not build a Copilot-specific queue, board, or inbox.
2. **Transport truth.** Only an observing owned transport may report
   `started`, `completed`, `busy`, or `idle`. A process start or stdin write is
   not completion.
3. **One turn at a time.** Every Copilot ask/tell/relay/steer goes through the
   existing per-alias FIFO.
4. **Durable acceptance before interruption.** A steer is recorded and
   accepted before the active Copilot turn is interrupted, then runs next.
5. **Owned-process boundary.** Forge may terminate only the Copilot process it
   owns. It must never kill an unrelated Copilot or VS Code process.
6. **Context is explicit.** Resume a confirmed Copilot session id when the CLI
   supports it. If resume fails, report `context_lost`; do not silently start a
   fresh session and claim continuity.
7. **Tools and permissions are explicit.** Copilot uses its native coding tools
   with a documented, tested launch policy equivalent in intent to owned
   Codex. No hidden approval fallback, no interactive prompt that can deadlock
   a headless turn, and no invented command-line flags.
8. **Existing Forge permission gate remains.** Invoking a CLI peer still
   requires the existing `delegate` permission/confirmation policy. Copilot's
   internal tool policy does not bypass Forge's decision to start the turn.
9. **Telegram remains a projection, not a second mesh.** `/status`, `/queue`,
   lifecycle notices, and completion/failure notifications consume the same
   board, ownership, and FIFO state as the sidebar and `forge.sh`.
10. **No private Copilot Chat state.** Do not read VS Code databases, scrape
    webviews, patch GitHub Copilot Chat, or call undocumented private endpoints.
11. **No secret persistence.** Copilot authentication remains owned by the
    official CLI. Forge stores no Copilot token in config or git.
12. **No silent fallback.** Missing CLI, signed-out state, unsupported protocol,
    quota failure, or missing resume/interrupt capability is reported plainly.

## P0 — Copilot CLI transport spike and cleanup

Transport investigation is complete. The live result and selected ACP stdio
design are recorded in
[`COPILOT_CLI_TRANSPORT_SPIKE.md`](../reports/COPILOT_CLI_TRANSPORT_SPIKE.md).
The decision is **GO** on GitHub Copilot CLI 1.0.88. Cleanup of the mistaken
inbound-delegation slice remains part of the first implementation commit.

Before production code, run a repeatable spike against the exact installed
Copilot CLI version. Record the evidence in
`docs/reports/COPILOT_CLI_TRANSPORT_SPIKE.md`.

The spike must establish:

1. How the executable is installed and resolved on Windows. A broken VS Code
   wrapper that cannot find its payload is not a usable CLI.
2. The documented non-interactive invocation and its exact version/help text.
3. Whether output is machine-readable and how text, native tool activity,
   terminal success, terminal failure, and protocol errors are represented.
4. Whether a stable session id is emitted and can be resumed in a second
   process or turn without replaying the entire transcript.
5. How the CLI selects the workspace and how it is granted the intended native
   coding tools without an unanswerable interactive approval prompt.
6. How cancellation works. If there is no interrupt RPC, prove that terminating
   only the Forge-owned process settles the turn, retains any confirmed session
   id, and permits the queued steer to resume next.
7. Behavior for missing authentication, quota/rate limits, malformed output,
   process crash, timeout, and resume failure.
8. Whether one long-lived process or one process per resumable turn is the
   supported design. Choose the simpler supported shape; do not imitate Claude
   or Codex mechanically.

P0 may add hermetic fixtures and a small probe script, but no production
adapter is accepted until the protocol evidence is recorded. If the CLI has no
machine-readable terminal result or no safe headless tool policy, stop and
report the exact blocker rather than substituting Copilot Chat UI automation.

The same phase removes the mistaken inbound-delegation slice listed above, so
later diffs contain only the requested feature.

**Exit criteria:** the report contains commands, version, redacted example
frames, session/resume result, cancellation result, and a GO/NO-GO decision for
an observing owned adapter. `npm run ci` is green after cleanup and fixtures.

## P1 — Copilot CLI driver and session lifecycle

Implement the narrow protocol owner under `src/agents/`:

- add `copilot` to `CliAgentName` and make executable inference reject ambiguity
  instead of treating every non-Codex executable as Claude;
- add a Copilot adapter/parser for the P0-proven machine-readable protocol;
- add `CopilotOwnedSession` if the protocol needs persistent state beyond the
  reusable one-shot `CliAgentDriver` shape;
- resolve `agent_bus.copilot_cli` explicitly, defaulting only to the documented
  executable name;
- capture the confirmed Copilot session id and expose it through the existing
  `CliAgentRunResult`/owned-session contract;
- stream concise native tool activity as status events and the final answer as
  `finalText`;
- implement AbortSignal cancellation, timeout, dispose, and process-tree
  termination using the existing safe CLI process helpers;
- launch in the workspace and with the P0-proven full coding capability. Forge
  does not inject its own ToolRegistry into the Copilot process.

Tests use a fake Copilot CLI fixture and cover first turn, resume, tool status,
failure, malformed output, cancellation before start, cancellation in flight,
timeout, missing session id, and dispose. No live CLI is required for CI.

**Exit criteria:** the session produces honest `TurnResult` outcomes, never
runs two turns concurrently, resumes only a confirmed id, and terminates only
its own child process. `npm run ci` is green.

**Implementation evidence (2026-09-27):** P1 shipped in `057a590`, with
post-review lifecycle cleanup in `b43c137`. The focused P1 suites pass 60/60;
the final repository gate passes 3,282 tests with 36 skipped, plus type-check,
lint, production build, and bundle-load smoke.

## P2 — Mesh integration

Extend the canonical mesh owners:

- `AgentKind` accepts `copilot`; alias and ownership readers migrate older
  records unchanged and validate Copilot records;
- `AgentBusConfigSchema` accepts `copilot_cli`; example config documents it;
- add `CopilotOwnedAdapter` with `observesTurns: true` and an `interrupt()`
  backed by the P1 cancellation behavior;
- `MeshSessionProvider` resolves `copilot` to an existing in-memory session,
  resumes a durable confirmed session id, or creates one under the existing
  creation lease and one-time consent path;
- use the same ownership, idle TTL, park/wake/close, reload recovery,
  `context_lost`, and FIFO behavior as the other owned peers;
- `knownAliasesForMesh`, sender validation, mesh commands, relay validation,
  and `forge.sh` usage accept `copilot` without weakening unknown-sender checks;
- `ask_live_session.target` and `tell_live_session.target` accept
  `claude | codex | copilot`; update error/help text and tests;
- creation prompts tell the Copilot agent how to communicate through the
  current `forge.sh` header and identify itself as `copilot`, without hardcoding
  a stale command list;
- any generic CLI-provider path that enumerates Claude/Codex is extended only
  where needed for Copilot to behave like Codex as a Forge coding agent. Do not
  broaden unrelated paths speculatively.

Tests cover FIFO serialization, concurrent creation, alias persistence,
resume, reload, park/wake/close, idle release, ask/tell, relay in both
directions, steer ordering, cancellation, context loss, process crash, and a
Copilot sender attempting an unauthorized alias.

**Exit criteria:** Forge, Claude, Codex, and Copilot can participate in the same
hub-and-spoke mesh; Copilot runs its native tools on an owned turn; and every
state shown on the board is supported by an observed event. `npm run ci` is
green.

**Implementation evidence (2026-09-28):** P2 shipped in the single Copilot
mesh-integration commit (the one that adds `copilotOwned.ts`,
`ownedSessionFactory.ts`, and the three `AgentMesh*Copilot*` test suites). The
focused P2 suites pass 33/33 (provider 17, adapter 7, orchestrator 9),
alongside the unchanged Claude provider, orchestrator, zero-config, and P1
Copilot session suites (112 tests in the focused set); the final repository
gate passes 3,315 tests with 36 skipped, plus type-check, lint, production
build, and bundle-load smoke. Residual: `CliAgentSession.test.ts` (a
pre-existing, non-Copilot suite) documents a load-dependent timeout race and
can flake under full-suite load; it passed in the gate run above and in
isolation.

## P3 — Telegram, sidebar, notifications, and operator surfaces

**Implementation evidence (2026-09-28):** P3 shipped in the operator-surfaces
commit, with the A11 notification bridge added in a focused follow-up. The
projection and notification owners (`boardView.projectLiveSessions`,
`meshWho.projectWho`, `RemoteSessionCommands` `/status` + `/queue`,
`agentMeshSetup` crash/context-lost/stand-in/idle-TTL events, and the
lifecycle-command dispatcher in `meshOrchestrator.handleCommand`) are
agent-agnostic and carry `copilot` through the same paths as Claude/Codex.
The A11 bridge is a pure notification policy
(`agentMesh/meshNotificationPolicy.ts`) that the single `onEvent` owner calls:
it phrases only the bounded terminal/lifecycle states (completion,
failure/cancellation, crash, recovery, context-loss, idle-TTL timeout) as
`[agent mesh <id>] <alias> <state>`, names the alias + exchange/state, never
includes the prompt or a `state` event's detail (which can be the turn's
answer), and preserves the exchange's conversation scope so the host-activity
path reaches the bound Telegram chat/sidebar. One terminal event emits exactly
one host activity (the stand-in's separate `emitHostActivity` was removed to
avoid a duplicate); retry/dedup remains the outbox's job. The focused P3 suite
(`AgentMeshCopilotSurfaces.test.ts`) passes 30/30, covering the `forge.sh who`
projection (owned+idle/busy/parked/dead, peer+unknown for a foreign live
owner, absent for an unknown alias), the sidebar board projection (live/parked/
dead/none, agent field, no codex default), the Telegram `/status` Sessions line
(live/parked/dead/none), unbound remote chat (no board line, no bus =
undefined), Telegram `/queue` (agent-bus label + management note), unavailable
Copilot CLI (resolveAdapter undefined, tell reports no-live-session, no
fallback), outbox retry/dedup (failed send retries the same item, delivers
exactly once), the notification policy (every terminal state notifies, no
prompt/answer leak, accepted and non-terminal states never notify, conversation
scope preserved), and an integration test that a crashed owned copilot emits
exactly one host activity naming alias + state through the real `onEvent`
wiring. The final repository gate passes 3,351 tests with 36 skipped, plus
type-check, lint, production build, and bundle-load smoke.

Copilot must appear everywhere the user already observes the mesh:

- `forge.sh who` lists `copilot` with truthful attachment/activity and queue
  detail;
- sidebar live-session and board projections render Copilot without defaulting
  unknown agents to Codex;
- Telegram `/status` includes `copilot live|parked|dead` on the Sessions line;
- Telegram `/queue` includes pending Copilot FIFO items with the existing
  agent-bus label and management note;
- Telegram and sidebar receive the existing bounded turn-finished,
  failed/cancelled, crash, recovery, context-lost, and stand-in/availability
  notifications where those event classes already notify for Claude/Codex;
- notifications name the alias and exchange, do not expose prompts/secrets, and
  do not claim that `accepted` means processed;
- lifecycle commands `status`, `board`, `peers`, `queue`, `standby`, `wake`,
  `handoff`, and `close` work for Copilot under the same ownership rules;
- help/config docs describe setup, authentication ownership, recovery, and the
  distinction between an owned Copilot CLI session and Copilot Chat UI.

Tests assert both the data projection and the Telegram-rendered text. Include
multi-window ownership, a remote chat without a bound Forge conversation,
notifications pending/retry behavior, and unavailable Copilot CLI behavior.

**Exit criteria:** the sidebar, `forge.sh`, and Telegram agree on Copilot state
and delivery; notification retries do not duplicate an exchange or wake a peer
twice. `npm run ci` is green.

## P4 — Live validation, packaging, and release

Run a real authenticated Copilot CLI validation:

1. `ask_live_session(target: "copilot")` performs a read-only repository task
   and returns the observed final answer.
2. Copilot performs a small workspace edit with its native tools; Forge's
   existing checkpoint/Keep/Undo boundary behaves as documented for CLI
   agents.
3. A second ask resumes the same Copilot session and demonstrates retained
   context.
4. `tell` during an active Copilot turn queues without starting a concurrent
   turn.
5. `steer` is durably accepted, stops the owned active turn, and runs next.
6. Copilot sends or replies through the Forge mesh as `copilot`; Claude/Codex
   can relay to it and it can relay back through Forge.
7. Telegram `/status` and `/queue` show the same state as `forge.sh who` and the
   sidebar. Completion, cancellation, and one induced recoverable failure
   produce the expected user notification.
8. Reload VS Code, resume the Copilot alias, then close it; only the Forge-owned
   process is stopped and its resumable identity follows the documented policy.

After the last source, test, plan, changelog, or version edit run:

```bash
npm run ci
npm run package
git diff --check
git status --short
```

Update `CHANGES.md` with the matching version if `package.json` changes. Report
unit-test counts separately from the live Copilot validation.

**Implementation evidence (2026-09-28):** P4 live validation ran against the
installed Copilot CLI 1.0.88 (authenticated), on the live mesh (owned copilot
session `27d658f0-…`, owner host pid 37124). Durable exchange-log and outbox
evidence:

1. `ask_live_session(target: "copilot")` performed a read-only `git log` task
   and returned the three most recent commits correctly.
2. Copilot created `test/p4-validation.txt` with the requested content using
   its native file tools (file verified on disk, then cleaned up).
3. A second ask in the same session correctly recalled the file path and
   content from the previous turn, demonstrating retained context.
4. **Nonblocking tell queues without concurrency** — two FIFO pairs:
   `806ec064`→`5c023099` and `2bcdac40`→`4b2486fc`; each second tell was
   `accepted` while the first was `started` and `started` only after the first
   `completed`.
5. **Steer durably accepted, cancels the active turn, runs next** —
   `bad7374e` (audit) `started`; steer `91ed96a3` `accepted` 75.3 s later,
   `bad7374e` `cancelled` 8 ms after acceptance, the steer `started` 68 ms
   after the cancel, and it `completed` 4.2 s later.
6. **Bidirectional relay with correlation** — Forge→Copilot `f5d79584`
   (accepted→started→completed); Copilot→codex true M6 relay `0ef61d0c` (two
   hop events share one id: `copilot→forge relay accepted`, `forge→codex relay
   accepted`), and the send-mirror `[agent mesh 0ef61d0c-…] copilot says to
   codex: …` was delivered to the bound Telegram chat (outbox, att=1).
7. **Projections agree; send-mirror delivers** — `forge.sh who` showed
   `copilot owned idle` (matching the sidebar board and the Telegram
   `/status` Sessions line), then truthfully `copilot owned dead` after the
   close test. The send-mirror notifications (`forge says to copilot`,
   `forge steers copilot`, `copilot says to codex`) are all in the delivered
   outbox. **Live-host boundary:** the running extension host predates
   `4f53b0d` (the A11 bridge commit), so the A11 *terminal-state*
   notifications (completion/cancellation/failure as `[agent mesh <id>]`
   `<alias> <state>`) are not emitted by it and are absent from the outbox;
   they are proven by the 30-test P3 suite and become live-validatable only
   after a reload on a build containing `4f53b0d`. A live induced recoverable
   failure was therefore not observable on this host.
8. **Close (non-reload part) verified** — `close copilot` stopped only the
   Forge-owned process (no `copilot` process remained; `owner_host` cleared to
   null) and preserved the resumable identity (`session_id 27d658f0-…`
   retained). **Reload boundary:** the actual VS Code reload → resume → close
   cycle is irreducibly user-driven; it is the remaining step before item 8 /
   P4 can be marked fully live-complete.

Packaging: the final `forge-llm-0.16.57.vsix` is built after the last P3/P4
edit and contains `4f53b0d` plus all P4 corrections; the final gate results
are recorded in the corrective commit.

**Exit criteria:** every acceptance item below has code-path and live evidence,
the final gates pass, and the packaged VSIX is smoke-tested.

## State × lifecycle ledger

This feature extends existing durable mesh artifacts rather than introducing a
parallel store.

| Artifact | Create | Delete | Disable | Crash mid-write | Owner-process death | TTL/expiry |
| --- | --- | --- | --- | --- | --- | --- |
| `aliases.json` Copilot record | Register `copilot` only after a confirmed owned session identity exists; serialize with the existing alias lock | Explicit unpair/forget removes it; ordinary process release keeps resumable identity according to the selected P0 protocol | Stop resolution and creation while the agent bus is disabled; retain the record for re-enable | Existing tmp+rename and lock preserve the prior table; a torn temp is not visible | Recovery checks the ownership record; never selects or kills an unrelated Copilot process | No age-only expiry; explicit forget removes identity |
| `ownership/copilot.json` | Write under the existing creation lease with agent `copilot`, owner host, workspace, timestamps, and only a confirmed resumable id | `close` or idle release clears live ownership according to existing policy and stops only this host's child; explicit forget may remove the record | Do not spawn, resume, reap, or rewrite while disabled | Existing atomic tmp+rename keeps the prior record; malformed ownership is unknown, never proof of death | Reap only when the recorded owner host is proven dead; preserve a resumable id and emit crash/recovery state, or mark context lost when resume is unsupported | Reuse the mesh idle TTL; parked sessions are exempt; process release must not silently erase resumable identity |
| `exchanges.jsonl` events involving Copilot | Existing orchestrator appends created/accepted before dispatch, then observed/started/terminal only from supported transport evidence | Existing whole-terminal-exchange compaction; never delete one Copilot event independently | No new events while disabled; existing events remain readable | Existing locked append and torn-last-line recovery; retry uses the same exchange semantics | Accepted-but-not-started work owned by a dead host becomes timeout; ambiguous in-flight work is failed/unknown according to observed protocol, never blindly replayed | Existing non-terminal deadline and terminal compaction policy |
| Copilot CLI authentication/cache outside Forge | Created and owned only by the official Copilot CLI/login flow; Forge neither creates nor copies credentials | Removed only by the official CLI/user, never by Forge cleanup | Forge stops invoking the CLI; credentials remain under the CLI's policy | Managed by the official CLI; Forge reports authentication failure | A Forge process death does not mutate credentials | Governed by the official CLI, not Forge |

## Acceptance criteria

- [x] **A1 — correct direction.** Copilot is a Forge mesh peer. No
  `forge_delegate_task` or hidden Forge-conversation implementation is shipped
  as a substitute.
- [x] **A2 — supported CLI contract.** The exact Copilot CLI version,
  machine-readable protocol, native-tool policy, session identity, resume, and
  cancellation behavior are recorded and live-tested.
- [x] **A3 — full native coding capability.** An owned Copilot turn can read,
  edit, and run workspace commands through Copilot's native tools under the
  explicit launch policy, matching the intended owned Codex capability.
- [x] **A4 — canonical mesh reuse.** Copilot uses the existing adapter,
  provider, FIFO, ownership, exchange log, and orchestrator. No duplicate
  queue, board, or tool surface exists.
- [x] **A5 — Forge tools.** `ask_live_session` and `tell_live_session` accept
  `target: copilot`; mesh `steer`, lifecycle commands, and relays accept the
  `copilot` alias under the existing delegate gate.
- [x] **A6 — observed answers.** An ask returns Copilot's correlated final
  answer. Failures, cancellation, empty answers, and timeouts are distinct.
- [x] **A7 — ordered steer.** Acceptance is durable before interruption; the
  current turn settles, then the steer runs at the head of the same FIFO.
- [x] **A8 — context and recovery.** Confirmed session identity survives normal
  turns and reload when supported. Resume failure emits `context_lost`; no
  silent fresh-session substitution occurs.
- [x] **A9 — process safety.** Close, timeout, cancellation, reload recovery,
  and idle TTL affect only the Forge-owned Copilot child process.
- [x] **A10 — truthful visibility.** `forge.sh who`, sidebar board/live
  sessions, Telegram `/status`, and Telegram `/queue` agree. Unobserved states
  remain unknown/accepted rather than idle/completed.
- [x] **A11 — notifications.** Completion, failure, cancellation, crash,
  recovery, and context-loss messages reach the same user-facing notification
  paths as Claude/Codex, with retry/dedup behavior covered.
- [x] **A12 — relay.** Forge, Claude, Codex, and Copilot can address one another
  through the Forge hub with shared exchange correlation and sender validation.
- [x] **A13 — disabled and unavailable behavior.** Disabled bus, missing CLI,
  signed-out CLI, quota failure, unsupported version, and malformed protocol
  are actionable errors with no fallback agent or session.
- [x] **A14 — old data compatibility.** Existing Claude/Codex aliases,
  ownership files, config, and exchange events parse unchanged.
- [x] **A15 — cleanup.** All unneeded inbound Copilot delegation code, tests,
  manifest entries, mocks, and obsolete report claims are removed; unrelated
  worktree changes are preserved.
- [x] **A16 — final gates.** `npm run ci`, `npm run package`, and
  `git diff --check` pass after the final edit, and live Copilot tests are
  reported separately.
