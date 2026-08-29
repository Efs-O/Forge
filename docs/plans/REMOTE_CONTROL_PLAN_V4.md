# Forge Remote Control — Consolidated Architecture and Implementation Plan V4

Status: Phase 0 complete; READY FOR IMPLEMENTATION
Branch: `feat/remote-control-plan`
Target: Forge VS Code extension; Telegram V1, optional experimental WhatsApp later
Date: 2026-08-29

This document is the single authoritative implementation contract. It consolidates and
supersedes, for implementation decisions:

- `REMOTE_CONTROL_PLAN.md`;
- `REMOTE_CONTROL_PLAN_V2.md`;
- `REMOTE_CONTROL_PLAN_V3.md`;
- `REMOTE_CONTROL_PLAN_V3_FINAL_CLARIFICATIONS.md`;
- `REMOTE_CONTROL_PLAN_V3_REVIEW_FINDINGS.md`.

The older files remain the review trail. Where they differ from V4, V4 wins.

## 1. Goal

Add an authenticated phone messaging surface to the same Forge conversations and agent runtime
used by the VS Code sidebar.

V1 must support:

- sending a normal user task to an explicitly bound open Forge conversation;
- continuing that conversation later from either phone or VS Code;
- durable FIFO follow-up queuing while the conversation is busy;
- final completion/failure notification;
- Forge-owned tool approval from VS Code or the authorized remote owner;
- deterministic `/status`, `/sessions`, `/use`, `/resume`, `/new`, `/stop`, `/approve`,
  `/deny`, and `/help` host commands;
- deduplication, crash recovery, and single-consumer transport ownership.

Telegram is the V1 reference transport. WhatsApp linked-device support is a later, explicitly
experimental adapter.

## 2. Non-goals

V1 does not:

- turn Forge into a standalone daemon or operate after VS Code/the host has stopped;
- expose or tunnel `ControlServer` to the Internet;
- expose remote shell, Git, filesystem, tool-dispatch, or configuration commands;
- bypass existing model, permission, approval, checkpoint, or instruction behavior;
- support groups, multiple remote owners, attachments, voice, `/steer`, Keep, or Undo;
- add a generic approval proxy for opaque external CLI prompts Forge does not own;
- make WhatsApp a dependency of remote core or Telegram.

## 3. Fixed product and security decisions

1. Remote control is another Forge input/output surface, not another agent runtime.
2. User prompts use one canonical Forge user-intent/admission/send path shared with the sidebar.
3. Remote origin is host metadata and never changes model-facing authority.
4. Forge-native providers retain ToolRegistry/ToolDispatch permissions, denylist, approvals,
   checkpoints, and `FORGE.md`/`AGENTS.md` behavior.
5. CLI providers are intentionally reachable remotely with their existing local CLI permissions,
   sandbox, tools, sessions, and instruction semantics.
6. Enabling remote access to a CLI conversation means an authenticated phone user can cause that
   already-configured CLI to act without a person at the keyboard. Setup documentation and UI must
   state this plainly; it is not described merely as “no new API privilege.”
7. `/stop` uses conversation-scoped cancellation. `interrupt()` remains reserved for future
   explicit steering.
8. Remote is disabled and default-deny until a private owner identity is paired.
9. Accepted work is durable before acknowledgement. A crash-found `running` task is never replayed.
10. Execution state and notification delivery are separate durable state machines.
11. One transport/account has one fenced consumer across VS Code extension hosts.

## 4. Current-code ground truth Phase 1 must change

The implementation must be based on these actual properties, not the older plans’ shorthand.

### 4.1 Send validation and completion

`src/sidebar/SendPipeline.ts` currently:

- resolves an open conversation;
- validates attachments;
- performs a same-conversation streaming check;
- awaits global cancellation cleanup and checks again;
- validates active model selection and resolves the request model;
- runs `AgentLoop.runTurn()`;
- returns `Promise<void>`;
- calls a void `postTokenBudget(true)` from `finally`.

Conversation lookup, attachment validation, model presence, and model resolution can all reject a
request. A user-intent epoch must not advance until every validation gate has passed and admission
has accepted the request.

`AgentLoop.runTurn()` also rejects image input for a model without static vision capability before
starting a provider turn. That compatibility check belongs in canonical preflight as well; leaving
it after admission would let a rejected image send advance the epoch.

### 4.2 Context publication and threshold evaluation

The existing `ContextBudgetPublisher` is the single owner and must be extended, not duplicated.
Its current `publish(conv, evaluateThresholds)` returns immediately when `conv` is not the active
tab. Threshold evaluation occurs after that return. Therefore:

- a non-active conversation is never threshold-evaluated and cannot auto-compact;
- `SidebarProvider.postTokenBudget()` instead passes the active tab, so completion of a background
  turn can spuriously evaluate the visible tab.

The `activeConversationId` guard must continue to gate UI/HalluMeter publication, but must not gate
addressed post-turn threshold evaluation.

### 4.3 Compaction is also active-tab/global today

Fixing threshold selection alone is insufficient. Current `runCompaction()`:

- obtains the conversation through `getActiveConv()`;
- refuses compaction through a global `isStreaming()` predicate;
- invalidates and republishes token state through active-conversation callbacks.

Automatic/background compaction must become addressed by conversation ID and use a target-specific
busy check. Manual `/compact` remains an active-tab wrapper around that addressed operation.

`AgentLoop` also currently stores one `promptRunCtrl`/`promptRunConversationId` for every out-of-band
prompt. Once compaction is conversation-addressed, two conversations may summarize concurrently
subject to backend capacity. Prompt-run cancellation ownership must become conversation-keyed (with
separate handling for genuinely unowned prompt runs); one compaction must not overwrite another's
controller.

### 4.4 Compaction/resume is detached

Threshold evaluation launches `autoCompact` with `void`; `SendPipeline.send()` returns while the
compaction/resume chain may still be running. Resume calls back into the current user send path.
There is no present object whose lifetime owns admission from initial turn through compaction and
resume. Phase 1 must create that awaited owner.

### 4.5 Global state that must become conversation/chain scoped

The audit definition of done includes:

- `SidebarProvider.autoContinues` — currently one counter for every conversation;
- `ContextBudgetPublisher.warningShown` — currently one warning cycle globally;
- `ContextBudgetPublisher.lastTickAt`, `tickTimer`, and `pendingTickConvId` — background activity can
  displace active-tab UI throttling;
- any active-derived exact-budget invalidation/publication used after addressed compaction.

Auto-continue count belongs to one request chain. Warning state belongs to one conversation.
Mid-turn UI throttling must ignore background conversations before mutating its active-tab throttle,
or use independent per-conversation state.

### 4.6 Approval and CLI facts

`ToolApprovalService` owns one active approval plus a global queue and currently rejects approval
requests when no webview exists. That presentation coupling is removed in Phase 3 without creating
a second approval queue.

CLI turns do not pass through Forge ToolRegistry/ToolDispatch. Remote CLI support therefore keeps
existing CLI authority rather than claiming Forge-native permission/approval semantics.

### 4.7 Existing lease helpers are not the transport lock

`SharedRuntimeRegistry.acquireLease()` writes an ordinary file and stale cleanup primarily checks
PID liveness. It is not an atomic exclusive, fenced lock and is not reused as remote ownership.
Process-liveness helpers and test patterns may be reused.

### 4.8 Extension lifecycle and persistence are currently fire-and-forget in places

`extension.ts` owns `globalStorageUri`, SecretStorage, config reload, activation subscriptions, and
deactivation. `SidebarProvider` disposal is currently invoked through a void disposable, and normal
session persistence intentionally fires `workspaceState.update` without awaiting it. Those patterns
must not be copied for remote acceptance/outbox durability or transport shutdown. Remote runtime
ownership belongs at extension activation/deactivation scope and its durable transitions are awaited.

## 5. Canonical architecture

```text
VS Code webview ──────────────────────┐
                                     │
Telegram ── RemoteChannel ────────────┼── RemoteController ── RemoteForgeHost
                                     │                         │
WhatsApp ── RemoteChannel ────────────┘                         ▼
                                                       shared user admission
                                                                 │
                                                                 ▼
                                                        existing SendPipeline
                                                                 │
                                                                 ▼
                                                          existing AgentLoop
                                                                 │
                                                native / CLI / cloud semantics
```

Remote adapters normalize provider I/O. They do not know how to run a Forge task.

## 6. Canonical ownership and no-duplication rules

| Concern | Canonical owner/change |
| --- | --- |
| User validation/model resolution | `SendPipeline` preflight extracted/reused once |
| Intent admission, epoch, reservation, chain settlement | one new composed `RequestChainLifecycle` (exact name may differ) |
| Individual model-turn streaming/cancel state | existing `TurnLifecycle` |
| Agent/provider execution | existing `AgentLoop` and provider runners |
| Context calculation/publication/evaluation | existing `ContextBudgetPublisher` |
| Transcript compaction | existing `CompactionService`, made addressed |
| Auto-resume policy | existing `compactionPolicy`/`CompactionService`, using chain context |
| Session state transitions | existing `ConversationOps`/`ConversationTabs` |
| Approval queue | existing `ToolApprovalService` |
| Remote orchestration | `RemoteController` |
| Durable request/dedup/outbox state | `RemoteRequestStore` |
| Transport exclusivity | `RemoteTransportLease` |

`RequestChainLifecycle` composes with `TurnLifecycle`; it does not duplicate model-turn cancellation
or streaming maps. Source files should remain near the 350 LOC project guideline and split by
these ownership boundaries.

## 7. Authoritative user-intent admission ordering

### 7.1 Preflight

Before admission, synchronously validate/re-resolve:

- explicitly addressed open conversation exists;
- attachments are valid;
- an active model selection exists;
- `resolveRequestModel` succeeds;
- attachment/model capability compatibility succeeds, including image/vision checks currently in
  `AgentLoop.runTurn()`;
- origin/request bounds are valid.

Cancellation cleanup that requires awaiting must complete before the final preflight/re-resolution
and atomic reservation. No awaited gap may exist between the final state check and reservation.

### 7.2 Local accepted path

```text
final preflight succeeds
  -> atomically reserve conversation
  -> local intent is accepted
  -> advance conversation user-intent epoch exactly once
  -> bind reservation + epoch into RequestChainContext
  -> enter canonical SendPipeline execution
```

A missing conversation, invalid attachment, missing/invalid model, busy rejection, or other failed
preflight/admission does not advance the epoch.

### 7.3 Remote idle path

```text
auth/private/dedup/binding/bounds
  -> final Forge preflight succeeds
  -> atomically reserve conversation
  -> compute candidate next epoch without publishing it
  -> persist RUNNING with candidate epoch while reservation is held
  -> persistence succeeds
  -> publish candidate as accepted epoch exactly once
  -> bind reservation + epoch + remoteRequestId
  -> register managed execution promise
  -> return durable-accepted disposition
  -> canonical execution continues
```

If persistence fails, release the provisional reservation, do not advance the epoch, start no model
work, and leave the provider event replayable.

### 7.4 Remote busy path

```text
auth/private/dedup/binding/bounds + preflight
  -> admission reports busy
  -> compute candidate next epoch without publishing it
  -> persist QUEUED with candidate epoch
  -> persistence succeeds
  -> publish candidate as accepted epoch exactly once
  -> return durable-queued disposition
```

If queued persistence fails, no epoch advances and the provider event remains replayable. A newer
accepted queued epoch suppresses older automatic resume but does not interrupt current generation or
already-running safe compaction. Multiple queued requests retain FIFO order even though their epochs
increase monotonically.

Candidate computation, durable write, and live epoch publication execute under one conversation-
scoped admission transaction. Remote events for the same conversation serialize through it. The
transaction does not remain held for model execution; the reservation owns that lifetime. Local
admission cannot slip between candidate persistence and publication. A crash after durable write but
before publication is recovered from the stored request state: `running` becomes `unknown`, while a
queued record retains FIFO position and is assigned/reconciled before drain without duplicating the
original provider request.

At FIFO drain, re-run current Forge preflight before acquiring the execution reservation because the
conversation/model/config may have changed while queued. A drain-time validation failure transitions
that already-accepted request to terminal `failed` and creates its notification; it does not advance
the epoch a second time and does not block later queue entries.

## 8. Request-chain context, lifetime, and recovery

Conceptual internal context:

```ts
interface RequestChainContext {
  conversationId: string;
  userIntentEpoch: number;
  reservation: TurnReservation;
  autoContinueCount: number;
  remoteRequestId?: string;
}
```

It is host metadata and never injected into model prompt text.

The chain owner remains alive and awaited across:

1. initial `AgentLoop` turn;
2. addressed post-turn context evaluation;
3. optional addressed compaction;
4. optional internal automatic resume using the same reservation/epoch;
5. repeated bounded compaction/resume if needed;
6. terminal result/outbox persistence for a remote request;
7. cancellation/failure cleanup;
8. canonical settlement and reservation release.

`SendPipeline` must not fire-and-forget post-turn evaluation. The chain owner awaits it. Automatic
resume is an internal continuation entry point, not a new user send: it verifies the accepted epoch,
reuses the same reservation, and never calls user admission again.

Every exit uses `try/finally` settlement. Cancellation aborts model work and compaction/background
work, awaits cleanup, then releases. Reservation recovery must never rely on elapsed time alone:

- expose `reserved`, `compacting`, `cancelling`, and settlement detail in host `/status`;
- reconcile/release only when AgentLoop, background-compaction state, and managed chain promise all
  prove no work remains;
- ambiguous state fails closed and instructs the local user to Stop or reload the extension host;
- no recovery action may release while model/tool/compaction work is plausibly active.

An extension-host restart clears in-memory reservations; durable remote `running` becomes `unknown`
and is never replayed.

## 9. Addressed context evaluation and compaction

Extend the existing `ContextBudgetPublisher` with two explicit responsibilities (exact names may
differ):

```ts
publishActiveConversation(): void;
evaluateConversation(conversationId: string, chain: RequestChainContext): Promise<void>;
```

Required behavior:

- UI token bar and HalluMeter bridge remain active-tab-only;
- the active-tab guard is applied only to UI publication;
- addressed evaluation computes model, used tokens, max tokens, warning and thresholds for the
  supplied conversation;
- `SendPipeline` awaits addressed evaluation for the conversation that just ran;
- warning reset is addressed to that conversation;
- auto-compaction receives the same conversation ID and chain context.

Threshold state and presentation are separate. A background conversation must not open an active-tab
VS Code warning whose action compacts the wrong tab. An interactive VS Code warning captures and
revalidates its target conversation ID; a correlated remote chain receives an appropriate remote
notice. Any manual compact action calls the addressed operation explicitly.

Make `CompactionService` addressed:

```ts
runCompaction(deps, conversationId, options, chainContext?): Promise<CompactionOutcome>;
```

It must:

- resolve the specified open conversation rather than `getActiveConv()`;
- use a target-conversation busy/background check, not global `isStreaming()`;
- invalidate exact token data for that conversation;
- persist and synchronize the addressed conversation;
- publish UI budget only if that conversation is active;
- return an awaited outcome to the chain owner.

Refactor the current single out-of-band prompt controller into conversation-keyed controller state so
targeted Stop cancels the correct compaction summary and concurrent summaries cannot overwrite each
other's controller. Unowned prompt runs remain cancellable by global disposal/cancel-all. Backend pool
capacity remains the independent concurrency limiter.

Manual `/compact` captures the active conversation ID and calls this addressed operation. Automatic
compaction calls it with the existing chain context. `resumeAfterCompaction` checks the current epoch:

- mismatch: suppress resume and settle the older chain;
- match: continue internally with the same reservation/epoch and increment that chain’s bounded
  `autoContinueCount`.

## 10. Typed request result

The canonical chain returns an explicit result, not webview/log scraping:

```ts
type ForgeRequestOutcome =
  | { kind: 'completed'; finalText: string }
  | { kind: 'failed'; error: string; finalText?: string }
  | { kind: 'cancelled'; finalText?: string; incompleteReason?: string }
  | { kind: 'interrupted'; finalText?: string; incompleteReason?: string };
```

Provider runners/`AgentLoop.runTurn` may return a lower-level typed turn outcome that the chain owner
combines across internal continuation rounds. Final remote text is the actual final assistant result;
there is no summarization call.

## 11. Non-activating conversation operations

Add canonical create/restore operations with `{ activate: false }`. They must preserve all session
bookkeeping and persistence without changing:

- visible active tab;
- global/visible model picker;
- unrelated backend residency decisions.

Do not activate and switch back. Remote sends target only open conversations; archived conversations
require explicit `/resume`.

## 12. Remote transport contract

Use discriminated, validated inbound events (`text` versus provider `action`) containing stable
channel/message/sender/chat IDs, chat type, and received time. Reject non-private chats.

The handler is awaitable:

```ts
onEvent(
  handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>,
): Disposable;
```

Dispositions distinguish durable accepted/queued, handled host command/pairing, duplicate, rejected,
and retry. Provider cursor advancement occurs only after a durable handled disposition. Handler
failure/retry leaves the event replayable.

The handler returns after durable admission and registration of a managed execution promise; it does
not await the entire model task and block polling. The controller owns/catches those managed promises.

## 13. Authentication and pairing

- remote disabled/default-deny;
- exact provider-stable owner identity, never display name;
- owner identity and tokens outside workspace-controlled files;
- token/linked-device secrets in SecretStorage;
- redacted/hashed identities in normal logs.

`/pair <code>` is the sole pre-auth exception. It is available only during explicit local pairing
mode, private text only, exact grammar, cryptographically random, short-lived, one-time, rate-limited,
and invokes neither host commands nor the LLM. Persist owner identity and invalidate the code before
confirming success.

### 13.1 Configuration boundary

Extend the canonical Zod schema in `src/config/schema.ts`, generated/types boundary, and user-facing
config example with non-secret behavior only, conceptually:

```yaml
remote:
  enabled: false
  queue_limit: 5
  max_message_chars: 12000
  telegram:
    enabled: false
  whatsapp:
    enabled: false
```

Owner IDs, tokens, pairing codes, and linked-device credentials are not YAML fields. Config reload
serially stops/reconfigures/restarts the remote runtime under the same fenced lease; it must never
start a second consumer beside the old one. Invalid remote config is surfaced through normal config
validation and does not silently fall back.

## 14. Durable request, dedup, queue, and outbox state

Execution states: `queued`, `running`, `completed`, `failed`, `cancelled`, `unknown`.

Deduplicate by `(channel, chatId, providerMessageId)` using durable request state. Queued prompt text
is persisted only as needed for recovery, outside workspace files, with documented retention/privacy.

`RemoteRequestStore` has one serialized mutation owner across transports/accounts. Durable state lives
under Forge global storage, never the workspace, and uses a versioned validated format plus an atomic
snapshot/transaction mechanism. The terminal-execution + pending-notification transition must be one
atomic store mutation. Provider cursor persistence is ordered after request/disposition persistence so
a crash may replay safely but cannot permanently skip an unrecorded task.

Crash rules:

- queued may resume FIFO;
- running becomes unknown and never auto-replays;
- terminal remains terminal;
- provider redelivery returns existing state;
- records and indexes use bounded retention/garbage collection appropriate to provider replay windows.

Notification delivery has a separate durable outbox: pending, sending, delivered, abandoned. Terminal
execution state and bounded final/error payload are persisted with a pending notification before send.
Retry never changes execution state or invokes Forge. Pending/sending records are reconciled on restart.

## 15. Remote commands and binding

Binding is `(channel, chatId) -> workspace identity + conversationId`, separate from transcripts.
Stale/archived targets produce explicit errors and never fall back to the active tab.

Host commands bypass the normal user queue where appropriate. `/stop` cancels the current chain only;
queued requests remain queued and this behavior is stated in `/help`/the response. No generic remote
execution commands are added.

`/status` reports bounded workspace/session/model state, request and queue state, pending Forge-owned
approval, active time/context when available, transport/outbox health, and reservation/compaction/
cancellation state without exposing secrets or unnecessary paths.

## 16. Approval architecture

Keep one `ToolApprovalService` queue. Refactor presentation into typed requested/resolved events or
sinks. Preserve exact ID, ordering, abort, timer pause/resume, dangerous flag, cancellation, and
Clanker behavior.

Show Forge-owned approvals in VS Code and the correlated authorized remote channel. First valid
resolution wins; stale/replayed resolutions are no-ops and the losing surface receives dismissal.
Do not fabricate approval support for external CLI prompts Forge does not structurally own.

## 17. Atomic transport lease

Use atomic exclusive creation and a cryptographically random fencing token. The lock lives in a
Forge-controlled filesystem location local to the extension host, never in the workspace. If local
atomic filesystem semantics cannot be established, fail closed.

The record includes transport/account key, token, PID/process-start evidence when available,
extension instance, workspace identity, and heartbeat. Stale recovery must permit only one winner.
The consumer periodically verifies its token and stops immediately on mismatch/loss. Release deletes
only a matching token.

Lease refusal, ambiguous ownership, stale-recovery failure, and runtime fencing loss must produce a
clear local user-visible notice; remote unreachability must not be silent.

## 18. Lifecycle and privacy

Transports use AbortController for polling, reconnect, backoff, and provider waits. Config reload
replaces rather than duplicates a consumer. Shutdown stops inbound acceptance, aborts transport,
reconciles durable state, removes listeners, and releases only the owned lease. It never unloads the
model merely because remote transport stops.

The remote runtime is owned at extension scope. Activation supplies `globalStorageUri`, SecretStorage,
workspace identity, the host facade, and config. Disposal immediately closes admission and returns an
awaitable shutdown promise; extension deactivation awaits that promise rather than relying only on a
`void` disposable callback.

Document that remote prompts enter Forge transcripts and final answers/approval details travel through
the provider. Never store secrets, pairing codes, or linked-device credentials in transcripts, config
YAML, workspace files, or normal logs.

## 19. Implementation phases

### Phase 0 — consolidated architecture gate (this phase)

- create V4 from all prior reviews;
- verify every current-code claim against source;
- resolve findings rather than deferring them to implementation guesswork;
- run `npm run ci` and `npm run package`;
- commit/push documentation only.

Exit: V4 is the one authoritative contract and receives a code-grounded
`READY FOR IMPLEMENTATION` decision.

### Phase 1A — preflight, admission, and epochs

- extract/reuse canonical preflight without duplicating `SendPipeline` logic;
- add shared conversation admission for sidebar/external/future remote callers;
- add accepted-intent epoch semantics;
- prove failed validation/admission never advances epoch;
- retain current sidebar errors and overlap behavior.

### Phase 1B — chain owner and typed outcomes

- add `RequestChainLifecycle`/context;
- hold reservation through complete chain;
- return typed turn/request outcomes;
- add managed cancellation, settlement, reconciliation, and status;
- ensure internal continuation never reacquires user admission.

### Phase 1C — addressed budget, compaction, and resume

- extend existing `ContextBudgetPublisher` with separated active UI/addressed evaluation;
- make warning/throttle bookkeeping correctly scoped;
- make `CompactionService` addressed and target-busy-aware;
- make out-of-band prompt controllers conversation-keyed;
- await evaluation/compaction/resume in the chain owner;
- move auto-continue count into chain scope;
- preserve manual `/compact` through an active-tab wrapper.

### Phase 1D — session operations and regressions

- typed addressed host facade seam;
- non-activating create/restore;
- session persistence/synchronization;
- full existing sidebar/compaction/concurrency regressions.

Phase 1 exit: local Forge has correct reusable seams, no remote networking, and all existing behavior
is green.

### Phase 2 — durable remote core with fake channel

- remote types/channel/disposition;
- controller and host facade;
- remote config schema/example and serialized config-reload lifecycle;
- auth/pairing abstraction;
- durable request/dedup/queue/outbox stores;
- fenced local transport lease;
- fake channel integration and crash recovery tests.

Phase 2 completion tests are limited to no-approval or auto-approved turns. Approval-required remote
completion is explicitly a Phase 3 exit criterion.

### Phase 3 — Forge approval multi-sink

- decouple approval presentation from webview availability;
- add VS Code/remote sinks and request correlation;
- first-resolution-wins, cancellation, timer, replay, and Clanker regressions.

### Phase 4 — Telegram

- official Bot API long polling (direct fetch unless a dependency is justified);
- SecretStorage setup and local pairing;
- `Forge: Configure Remote Control` command and local setup/status UX;
- private owner auth;
- awaitable disposition before update offset advancement;
- outbox delivery, chunking/escaping, callback acknowledgement/buttons;
- lease fencing and user-visible transport health;
- real phone end-to-end validation.

### Phase 5 — hardening

- crash/restart/dedup/outbox matrix;
- queue/compaction/local-send races;
- multi-window lock competition and fencing loss;
- config reload/disposal;
- stale bindings, overflow, status, retention, privacy/security docs.

### Phase 6 — optional WhatsApp experimental adapter

- separate current library/license/Node/esbuild/auth-persistence ADR;
- opt-in linked-device pairing and isolated adapter;
- same core auth/queue/outbox/lease semantics;
- no core agent/session change.

Telegram V1 may ship before Phase 6. WhatsApp requires a separate go decision.

## 20. Required tests

Phase 1 must directly cover:

- non-active turn evaluates its own threshold and never the active tab’s;
- background auto-compaction compacts the addressed conversation;
- another conversation streaming does not incorrectly block target compaction;
- active-tab guard still protects UI/HalluMeter only;
- missing conversation, invalid attachment, missing model, invalid model, and busy rejection do not
  advance epoch;
- image input rejected for missing vision capability does not advance epoch;
- simultaneous local/remote admission yields one reservation;
- durable queued/running acceptance advances once; persistence failure advances zero times;
- queued newer intent suppresses older auto-resume;
- internal resume reuses reservation/epoch;
- queued drain revalidates without advancing its accepted epoch again;
- chain reservation survives awaited compaction and releases on every terminal/cancel path;
- recovery never releases plausibly active work;
- auto-continue count and warning/throttle state do not bleed between conversations;
- concurrent compaction summaries retain distinct cancellation controllers and targeted Stop behavior;
- non-activating create/restore leaves visible state unchanged.

Later phases must cover authorization/pairing, durable disposition and cursor ordering, dedup, queue
FIFO/cap/recovery, running-to-unknown, outbox recovery without rerun, approval correlation, lease
competition/fencing, Telegram formatting/chunking, and remote-disabled regressions.

Reuse existing `SendPipeline`, `ContextBudgetPublisher`, compaction, `ToolApprovalService`,
`PermissionResolver`, conversation/session, `TurnLifecycle`, fake backend, and shared-runtime
multi-window test infrastructure. Do not create a parallel agent harness.

## 21. Quality and commit gates

At every phase/subphase:

1. targeted tests for the changed invariant;
2. `npm run ci`;
3. `npm run package`;
4. diff review for unrelated/user changes;
5. focused commit and push on `feat/remote-control-plan`;
6. update the plan’s implementation record before moving on.

No secrets or real transport credentials enter Git or test fixtures.

## 22. Final acceptance criteria

The implementation is complete when:

- remote is disabled/default-deny;
- only the paired private owner controls Forge;
- all user sends share validated atomic admission;
- failed sends never mutate intent epoch;
- one request reservation owns initial turn through awaited addressed evaluation/compaction/resume;
- automatic continuation reuses reservation/epoch and cannot self-deadlock;
- background turns compact only themselves and cannot disturb active-tab budget UI/state;
- reservations release on all safe terminal/cancel paths and stuck state is visible/recoverable without
  unsafe timeout release;
- native provider security and project instructions are unchanged;
- CLI remote authority is accurately disclosed and unchanged from local CLI behavior;
- busy input is durable FIFO and cannot corrupt transcript order;
- duplicate/replayed provider events do not duplicate execution;
- crash-found running work is unknown and never replayed;
- execution and notification delivery remain independent;
- `/stop` cancels the addressed chain without unloading its backend;
- non-activating session operations do not move the visible tab/model picker;
- Forge-owned approval retains one queue and can resolve from either authorized surface;
- transport cursor advances only after durable disposition;
- lease ownership is atomic, fenced, local-filesystem-backed, and visibly fails closed;
- existing Forge behavior remains green with remote disabled;
- Telegram uses no public webhook/server and no Internet-facing Forge control API exists;
- WhatsApp, if implemented, requires no core agent/session semantic changes.

## 23. Phase 0 final review question

Review this V4 against current source and report only an implementation-blocking contradiction,
false code assumption, missing security boundary, or duplicated canonical owner. If none remains,
the required decision is exactly:

`READY FOR IMPLEMENTATION`

## 24. Phase 0 code-grounded review record

Review completed against the cited current source seams. Disposition:

- review finding 1 confirmed: V4 sections 4.2 and 9 explicitly move the active-tab guard to UI-only
  publication and keep threshold evaluation addressed;
- duplicate-owner concern confirmed: V4 extends the existing `ContextBudgetPublisher`;
- review finding 2 confirmed: V4 section 7 requires all validation, including image/vision
  compatibility, before accepted epoch mutation;
- review finding 3 confirmed: V4 section 8 introduces an awaited chain owner and section 9 makes
  compaction/resume part of that lifetime;
- reservation recovery refined: V4 forbids unsafe elapsed-time-only force release and requires
  lifecycle-proven reconciliation/status;
- global auto-continue/warning/throttle finding confirmed and named in sections 4.5, 8, and 9;
- Phase 2 approval scope clarified to no-approval/auto-approved turns until Phase 3;
- lease location, visible ownership failure, and CLI unattended-authority disclosure are explicit;
- additional source review found active-only `runCompaction` and the singleton prompt-run controller;
  both are explicit Phase 1C work with regression tests;
- remote durable epoch publication is serialized through a conversation-scoped admission transaction.

No implementation-blocking contradiction, false code assumption, missing security boundary, or
duplicate canonical owner remains in the Phase 0 contract.

`READY FOR IMPLEMENTATION`
