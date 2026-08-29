# Forge Remote Control — Architecture and Implementation Plan V3

Status: final architecture revision; awaiting two Codex sequencing clarifications
Branch: `feat/remote-control-plan`
Target: Forge VS Code extension; no daemon/service extraction in V1

This document incorporates the seven remaining blockers identified in `REMOTE_CONTROL_PLAN_V2.md` section 31.1. It is the authoritative implementation contract. V2 remains as design history; where V2 and V3 differ, V3 wins.

## 1. Product decisions that remain fixed

- Remote control is another Forge input/output surface, not another agent runtime.
- Normal remote prompts use the same canonical Forge send/agent path as local prompts.
- Remote origin never adds privileges.
- Forge-native providers keep Forge permissions, approvals, denylist, checkpoints and `FORGE.md` behavior.
- CLI providers are intentionally supported remotely with their existing local CLI security/tool semantics. The remote layer adds no shell/Git/filesystem API of its own.
- `/stop` uses conversation-scoped cancellation; `interrupt()` is reserved for future explicit steering.
- Busy remote input is durably queued per conversation.
- Telegram is the first transport; WhatsApp linked-device support remains an experimental later adapter.
- No Internet-facing Forge HTTP control API is introduced.

## 2. Canonical architecture

```text
VS Code Webview ───────────────────────┐
                                      │
Telegram ── RemoteChannel ─────────────┼── RemoteController ── RemoteForgeHost
                                      │                         │
WhatsApp ── RemoteChannel ─────────────┘                         ▼
                                                        shared turn admission
                                                                 │
                                                                 ▼
                                                        existing SendPipeline
                                                                 │
                                                                 ▼
                                                           existing AgentLoop
                                                                 │
                                                   native / CLI / cloud model
```

The remote controller authenticates, routes, queues, correlates and delivers. It never executes model/tool/workspace operations directly.

## 3. Correction 1 — addressed post-turn context evaluation

### Problem fixed

Current `SendPipeline.send()` can target an addressed conversation, but post-turn context publication/evaluation flows through `SidebarProvider.postTokenBudget(true)`, which currently resolves `this.getActive()`. Therefore a background remote turn created/restored with `activate:false` can accidentally evaluate or compact the visible local tab instead of its own conversation.

### Required architecture

Split **conversation-scoped context evaluation** from **active-tab UI publication**.

Introduce an addressed operation conceptually equivalent to:

```ts
interface ContextBudgetPublisher {
  evaluateConversation(conversationId: string, options?: { force?: boolean }): Promise<void>;
  publishActiveConversation(options?: { force?: boolean }): Promise<void>;
}
```

Exact names may differ, but semantics are mandatory:

- `SendPipeline` must call the addressed evaluation path with the actual completed `conversationId`.
- Compaction threshold evaluation must target that same conversation.
- Auto-compaction and any auto-resume launched from that evaluation must retain that same conversation ID and request-chain epoch.
- UI-only token-budget publication may still use the active tab, but it must not decide which conversation is compacted.
- Any context-warning/reset/threshold bookkeeping currently global or active-tab-derived must be audited and made conversation-scoped where correctness requires it.

This change applies to local addressed/background behavior as well as remote behavior; remote must not create a parallel budget path.

## 4. Correction 2 — one shared conversation-scoped turn admission primitive

### Problem fixed

A remote controller cannot safely do:

```text
check idle -> persist running -> acknowledge accepted -> call SendPipeline
```

because a local sidebar send may start in between. That creates a false accepted/running remote task that the canonical send path then rejects as overlapping.

### Required architecture

Create **one shared conversation-scoped admission primitive used by every user-originated send**, including sidebar, external API, and remote.

Conceptual contract:

```ts
type TurnAdmissionResult =
  | { kind: 'reserved'; reservation: TurnReservation }
  | { kind: 'busy'; conversationId: string };

interface TurnAdmission {
  reserve(conversationId: string, intent: UserIntent): TurnAdmissionResult;
  release(reservation: TurnReservation): void;
}
```

The implementation may live inside `SendPipeline`/`TurnLifecycle` rather than as a new standalone class, but there must be a single atomic conversation-scoped gate.

### Two-phase remote admission

Remote acceptance uses a two-phase reservation:

1. authenticate and validate the inbound event;
2. deduplicate by provider message ID;
3. resolve the bound conversation;
4. call the shared admission primitive;
5. if **busy**, persist the remote request as `queued`, advance the user-intent epoch as defined in section 5, then acknowledge `queued`;
6. if **reserved**, durably persist the request as `running` while holding the reservation;
7. only after the durable `running` transition succeeds, acknowledge `accepted`;
8. enter the canonical `SendPipeline` using that reservation;
9. release reservation only when the shared lifecycle says the request chain is settled/cancelled/failed according to the final implementation seam.

If durable persistence fails before acknowledgement, no model work begins and the provider event remains replayable.

Sidebar sends use the same admission gate but do not require remote durable request storage.

A remote-only mutex is explicitly forbidden because it does not serialize local sends.

## 5. Correction 3 — precise user-intent epoch and supersession semantics

### Problem fixed

V2 simultaneously said queued user prompts wait through auto-resume and that a new user prompt supersedes pending auto-resume. The creation point of the new intent epoch was undefined.

### Final rule

**A real user intent advances the conversation's user-intent epoch at admission time, including when that request must be queued.**

This rule applies identically to sidebar and remote user input.

Example:

```text
Epoch 41: active user turn
   ↓
turn finishes and compaction starts
   ↓
remote user message arrives while chain 41 is not settled
   ↓
message is durably queued and user-intent epoch becomes 42 immediately
   ↓
compaction for epoch 41 may finish
   ↓
resumeAfterCompaction(epoch 41) checks current intent epoch
   ↓
41 != 42 -> automatic resume is suppressed
   ↓
old chain 41 settles
   ↓
queued request 42 is admitted/runs
```

Required properties:

- current model generation is not implicitly interrupted merely because a new message queues;
- current compaction may finish safely;
- automatic continuation/resume for an older epoch must not begin once a newer real user intent exists;
- queue draining waits for the shortened older chain to settle;
- multiple queued user messages receive monotonically newer intent epochs and preserve FIFO execution order;
- local and remote user intents share the same epoch source;
- no queue implementation may use `isStreamingConv()` polling alone as the settlement test.

## 6. Correction 4 — awaitable inbound delivery disposition

### Problem fixed

A transport cannot safely advance Telegram `getUpdates` offset if `RemoteChannel.onEvent` is fire-and-forget. Cursor advancement must happen only after authentication/dedup/admission has reached a durable state.

### Required contract

Normalize provider events as before, but make event handling awaitable:

```ts
export type RemoteInboundDisposition =
  | { kind: 'durably-accepted'; requestId?: string }
  | { kind: 'durably-queued'; requestId: string }
  | { kind: 'handled-host-command' }
  | { kind: 'handled-pairing' }
  | { kind: 'duplicate'; requestId?: string }
  | { kind: 'rejected' }
  | { kind: 'retry' };

export interface RemoteChannel {
  readonly kind: 'telegram' | 'whatsapp';
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  send(message: RemoteOutboundMessage): Promise<RemoteDeliveryReceipt>;
  acknowledgeAction?(event: RemoteInboundEvent): Promise<void>;
  onEvent(
    handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>,
  ): Disposable;
}
```

Exact type names may differ, but semantics are mandatory.

### Provider cursor rule

For Telegram long polling:

- do not advance the durable/next update offset until the handler returns a disposition proving the event is safely handled or intentionally rejected;
- a thrown handler error or `{ kind: 'retry' }` leaves the update replayable;
- replay is safe because provider message/update identity is deduplicated durably;
- callback-query acknowledgement is transport UX and does not replace durable controller disposition;
- offset persistence and request persistence must be ordered so a crash cannot permanently skip an unrecorded task.

The same abstract rule applies to any provider-specific acknowledgement/cursor mechanism.

## 7. Correction 5 — pairing is the sole pre-authorization exception

### Default authorization rule

All normal inbound events are default-deny until the sender identity is already paired/authorized.

### Sole exception

`/pair <code>` is the only pre-authorization route and exists only while the local user has explicitly opened pairing mode.

Required checks, in order:

1. local pairing mode is currently active for this transport/account;
2. event is plain text, not an action callback;
3. chat type is exactly `private`;
4. text matches the exact pairing command grammar and nothing else;
5. pairing code exists and is unexpired;
6. rate limit for this transport/chat/IP-equivalent provider identity is not exceeded;
7. code matches in constant-time-equivalent comparison where practical;
8. persist the provider-stable owner identity in protected host storage;
9. invalidate the pairing code durably;
10. only then send pairing confirmation.

Pairing route must never:

- bind arbitrary sessions;
- run host commands other than pairing itself;
- call `SendPipeline` or the LLM;
- resolve approvals;
- reveal whether another owner identity is configured beyond a generic refusal;
- write the pairing code to logs/transcripts.

Pairing code is one-time, short-lived and generated locally with cryptographically secure randomness.

After success, all subsequent events use the normal authorized path.

## 8. Correction 6 — execution state and notification delivery are separate durable state machines

### Problem fixed

A completed task can otherwise be lost from the phone if Forge crashes after recording execution completion but before sending the final message. Retrying naively can also duplicate notifications.

### Execution record

Execution state remains independent:

```ts
type RemoteExecutionState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';
```

A request record stores execution identity/state and only the prompt text needed for definitely-queued recovery.

### Durable notification outbox

Add a separate durable outbox, conceptually:

```ts
type DeliveryState = 'pending' | 'sending' | 'delivered' | 'abandoned';

interface RemoteNotificationRecord {
  notificationId: string;
  requestId: string;
  channel: 'telegram' | 'whatsapp';
  chatId: string;
  kind: 'accepted' | 'queued' | 'final' | 'error' | 'notice';
  payload: string;
  deliveryState: DeliveryState;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  providerReceiptId?: string;
}
```

The final assistant payload must be bounded to a safe persisted size. If transport chunking is needed, either persist deterministic chunks or derive chunks deterministically from the bounded stored payload.

### Terminal ordering

When a request chain finishes:

1. obtain the typed final outcome;
2. durably transition execution to terminal state (`completed` / `failed` / `cancelled`);
3. in the same awaited persistence operation or an equivalent crash-safe ordering, create the corresponding pending final/error notification record containing the bounded payload;
4. only then attempt outbound delivery;
5. on provider receipt, mark the notification `delivered` and store receipt ID where available.

Delivery failure:

- increments attempts/backoff state;
- never changes execution back to `queued` or `running`;
- never invokes Forge/model execution again;
- is retried conservatively with a bounded policy;
- can become `abandoned` after policy exhaustion while preserving the completed execution record.

### Restart behavior

On restart:

- `running` execution -> `unknown`, never auto-replay;
- definitely `queued` execution may resume;
- pending/sending notification records are reconciled and retried conservatively;
- if provider supports stable receipt/idempotency metadata, use it;
- otherwise prefer possible duplicate notification over duplicate task execution, but minimize duplicate sends through stored attempt/receipt state;
- terminal execution outcome remains authoritative regardless of notification state.

`/status` should be able to distinguish task state from notification-delivery trouble.

## 9. Correction 7 — atomic remote transport ownership with fencing

### Problem fixed

Forge's current shared-runtime lease file is not a sufficient remote transport lock. It is an ordinary file write and process-liveness check and does not provide the exclusivity/fencing guarantees required for one Telegram/WhatsApp consumer per account.

### Required lock primitive

`RemoteTransportLease` must use true atomic exclusive acquisition, e.g. filesystem creation with `open(path, 'wx')` or an equivalent proven cross-process primitive.

Do not reuse `SharedRuntimeRegistry.acquireLease()` as the ownership implementation. Existing process-liveness helpers/test ideas may be reused where appropriate.

### Lock record

Conceptual record:

```ts
interface RemoteLeaseRecord {
  version: 1;
  transport: 'telegram' | 'whatsapp';
  accountKey: string;
  ownerToken: string;
  pid: number;
  processStartIdentity?: string;
  extensionInstanceId: string;
  workspaceIdentity: string;
  acquiredAt: number;
  heartbeatAt: number;
}
```

`ownerToken` is a cryptographically random fencing token unique to one acquisition.

### Acquisition/recovery rules

1. derive a non-secret stable lock key for transport/account;
2. atomically create lock file; success means ownership;
3. if it exists, read/validate record;
4. if owner is plausibly alive, refuse second consumer;
5. if stale/dead, recover conservatively using an atomic rename/remove-and-create protocol that cannot allow two simultaneous winners;
6. immediately verify the newly written record still contains this acquisition's `ownerToken`;
7. begin transport polling only after ownership verification.

### Runtime fencing

While running:

- heartbeat updates retain the same `ownerToken`;
- periodically re-read/verify the lock before/while continuing provider polling;
- if the file disappears, changes token, or cannot be proven owned, stop consuming immediately;
- disposal removes the lease only if the stored token still matches this process's token.

### PID reuse

A live PID alone is insufficient proof of ownership. Use the strongest portable process-start identity available; otherwise combine PID with owner token, extension instance identity, timestamps/heartbeat and conservative stale timeout. Ambiguity fails closed: do not start a second consumer.

## 10. Revised canonical remote request flow

### 10.1 New private-chat text event

```text
provider event
   ↓
await controller handler
   ↓
pre-auth pairing exception? ---- yes ---> bounded pairing path only
   ↓ no
authorize exact owner identity
   ↓
validate private chat + command/text size
   ↓
dedup durable provider identity
   ↓
resolve explicit conversation binding
   ↓
advance user-intent epoch
   ↓
shared conversation admission primitive
   ├─ busy ----> durable queued record ----> durable disposition ----> provider cursor advances
   │
   └─ reserved -> durable running record -> durable disposition/accepted ack -> canonical SendPipeline
                                                         ↓
                                                   AgentLoop / tools / CLI
                                                         ↓
                                            addressed context evaluation
                                                         ↓
                                         compaction/resume for same epoch
                                                         ↓
                                               request chain settled
                                                         ↓
                                            typed terminal execution result
                                                         ↓
                                 terminal state + durable notification outbox
                                                         ↓
                                            transport delivery attempt
```

### 10.2 Provider cursor and user-visible acknowledgement

Provider transport cursor advancement and the user-facing `accepted/queued` message are related but distinct:

- controller first reaches durable disposition;
- adapter may then safely advance provider cursor;
- user-facing ack is delivered through the normal outbound path;
- failure to send the ack does not roll back durable execution admission or replay the task;
- `/status` and dedup state let the owner recover visibility if the ack itself was lost.

## 11. Revised request-chain semantics

A request chain is identified by:

```text
conversationId + userIntentEpoch + optional remoteRequestId
```

For remote-originated requests, `remoteRequestId` is attached as host-side metadata only.

Chain settlement requires:

- no active model turn for that epoch;
- no pending/active compaction for that epoch;
- no automatic continuation eligible to start for that epoch;
- terminal cancellation/failure recognized;
- addressed context evaluation completed sufficiently to know whether compaction/resume is required.

A newer user-intent epoch makes older automatic resume ineligible but does not retroactively corrupt/abort a compaction that is already safely running.

## 12. Revised `SendPipeline` / host seam

Phase 1 should evolve the canonical path rather than build remote-specific behavior.

Conceptual target:

```ts
interface RemoteForgeHost {
  listSessions(): RemoteSessionSummary[];
  getStatus(conversationId: string): RemoteConversationStatus;
  submitUserIntent(
    conversationId: string,
    text: string,
    context: UserIntentContext,
  ): Promise<ForgeRequestOutcome>;
  cancel(conversationId: string): Promise<void>;
  createConversation(options: { activate: boolean }): Promise<string>;
  restoreConversation(id: string, options: { activate: boolean }): Promise<string>;
  resolveApproval(id: string, approved: boolean): void;
}
```

`submitUserIntent` must reuse the same admission/SendPipeline path as the sidebar. It is not permission to duplicate `send()`.

The typed outcome must carry the final assistant text or explicit failure/cancel state without scraping webview/session logs.

## 13. Approval architecture remains unchanged from V2

`ToolApprovalService` remains the one canonical queue/state machine. Presentation is decoupled into VS Code and remote sinks/events. Exact stored approval IDs are resolved; no command is reconstructed from remote text. First valid resolution wins.

CLI normal turns remain remotely supported. Forge does not invent an opaque generic approval relay for external CLI prompts it does not structurally own.

## 14. Transport lifecycle

Each adapter owns an `AbortController` covering polling, reconnect waits, socket waits and backoff timers.

Activation order:

1. initialize normal Forge runtime/sidebar collaborators;
2. load protected remote settings;
3. acquire and verify atomic transport lease;
4. create controller/host bridge;
5. recover durable request + outbox state;
6. start transport;
7. process provider events through awaitable disposition handler.

Shutdown/reload:

1. stop accepting new inbound events;
2. abort polling/reconnect/backoff;
3. stop adapter;
4. persist/reconcile request and outbox state;
5. remove listeners;
6. release lease only with matching fencing token;
7. never kill llama-server merely because remote transport stops.

## 15. Telegram implementation contract

Use official Bot API long polling initially. A third-party library is optional, not required.

Important ordering:

- fetch update;
- normalize event;
- await `RemoteController` disposition;
- advance `getUpdates` offset only after durable handled disposition;
- on retry/handler failure, leave update replayable;
- durable dedup guarantees replay cannot duplicate an accepted Forge task.

Also implement:

- SecretStorage token;
- private-chat enforcement;
- pairing exception path;
- owner authorization;
- safe message chunking/escaping;
- callback-query acknowledgement;
- inline Forge approval buttons where appropriate;
- reconnect/backoff tied to AbortSignal;
- transport lease fencing checks during polling.

## 16. WhatsApp implementation contract

Still deferred until Telegram validates the core. Target ordinary WhatsApp/WhatsApp Business linked-device operation through an isolated experimental adapter.

No WhatsApp library enters remote core. Library choice still requires maintenance/license/Node/esbuild/reconnect/auth-persistence review before implementation.

The same durable disposition, queue, request, outbox, auth and lease semantics apply.

## 17. Storage boundaries

### Workspace/session state

Keep existing Forge conversation/session state where it is today.

### Protected/global remote operational state

Store remotely sensitive operational data outside workspace-controlled files:

- paired owner identity;
- bindings;
- queued request records/prompt text;
- dedup records;
- terminal request outcomes as needed for recovery/status;
- notification outbox;
- transport account metadata;
- provider offsets/cursors where needed.

### SecretStorage

Use for access tokens and linked-device secret material where supported.

Never write secrets, pairing codes or linked-device credentials into session transcripts, `FORGE.md`, config YAML or normal logs.

## 18. Tests added by V3

In addition to V2 tests, Phase 1/2 must cover these seven blockers directly:

1. addressed remote/background turn performs context threshold evaluation on its own conversation, not the active tab;
2. simultaneous local + remote admission on one conversation yields exactly one reservation; the other is busy/queued, never false-running;
3. queued user intent advances epoch immediately and suppresses older `resumeAfterCompaction`;
4. adapter does not advance provider cursor until async controller returns durable disposition;
5. handler persistence failure leaves event replayable and later dedup-safe;
6. `/pair` is the only pre-auth route, private-only, expiry + one-time + rate-limit enforced;
7. owner identity is durably stored before pairing success reply;
8. task completion persists terminal execution + pending notification before outbound send;
9. crash between completion and send recovers the pending notification without rerunning Forge;
10. notification retry never changes execution state;
11. lease acquisition is atomic across competing extension-host/process instances;
12. stale lease recovery produces only one fencing-token winner;
13. consumer stops if runtime lock token no longer matches;
14. release cannot delete another owner's replacement lease.

## 19. Revised implementation phases

### Phase 0 — final yes/no Codex review

Review V3 only for unresolved blockers. Do not implement yet.

### Phase 1 — shared local core correctness seams

Implement before remote networking:

- shared conversation-scoped turn admission used by sidebar and future remote callers;
- user-intent epoch creation/supersession;
- request-chain settlement through compaction/auto-resume;
- addressed context threshold/compaction evaluation separated from active-tab UI publication;
- typed request/turn final outcome;
- non-activating create/restore;
- regression tests for existing sidebar behavior.

Exit: these seams are useful/correct for Forge itself and all existing tests stay green.

### Phase 2 — durable remote core + fake channel

- normalized async channel event/disposition contract;
- `RemoteForgeHost` facade;
- auth + exact pairing exception;
- durable request/dedup/queue store;
- durable notification outbox;
- per-conversation queue + crash rules;
- atomic fenced transport lease;
- fake-channel integration tests.

Exit: fake transport can safely accept/queue/complete/recover tasks with no network dependency.

### Phase 3 — Forge approval multi-sink

- decouple approval presentation from webview availability;
- keep one canonical approval queue;
- correlate Forge-owned approval to remote request;
- test first-resolution-wins and stale replay.

### Phase 4 — Telegram

- direct Bot API or justified library;
- long polling with awaitable durable disposition before offset advancement;
- SecretStorage setup;
- pairing;
- owner auth;
- action callbacks;
- message formatting/chunking;
- lease fencing;
- outbox delivery/retry;
- real phone end-to-end test.

### Phase 5 — hardening

- crash/restart matrix;
- notification-delivery failure matrix;
- stale bindings;
- queue overflow;
- config reload/disposal;
- multi-window lock competition;
- privacy/security docs.

### Phase 6 — WhatsApp experimental adapter

Only after core + Telegram are stable.

## 20. Final acceptance criteria

The feature is ready only when all V2 criteria still hold plus:

- post-turn context evaluation is addressed-conversation-scoped;
- remote/background turns cannot compact the wrong visible tab;
- local and remote sends share one atomic conversation admission gate;
- no remote task can be acknowledged `accepted` before durable running state is secured under a valid turn reservation;
- busy-at-admission becomes durable queued work rather than false running work;
- accepting any real user intent immediately advances the shared conversation intent epoch;
- older auto-resume cannot start after a newer queued/local user intent exists;
- transport event handling is awaitable;
- provider cursor/ack advancement happens only after durable handled disposition;
- pairing is the only pre-auth route and is tightly bounded/private/rate-limited/one-time;
- execution state and notification delivery state are durably separate;
- crash after execution completion but before final phone delivery can recover the notification without rerunning the task;
- transport ownership uses an atomic exclusive primitive and fencing token;
- a consumer that loses lease ownership stops consuming;
- remote CLI support remains enabled with existing local CLI semantics and no new remote privilege surface.

## 21. Final Codex review prompt

Use this exact review intent:

> Review `docs/plans/REMOTE_CONTROL_PLAN_V3.md` on branch `feat/remote-control-plan` against current Forge `main`, `REMOTE_CONTROL_PLAN.md` section 24.1, and `REMOTE_CONTROL_PLAN_V2.md` section 31.1. This V3 is intended to resolve all seven remaining blockers: addressed context evaluation, shared local/remote turn admission, precise user-intent epoch supersession, awaitable durable inbound disposition before provider cursor advancement, bounded pre-auth pairing, a separate durable notification outbox, and atomic fenced transport ownership. CLI providers remain intentionally supported remotely with their existing local security/tool semantics. Report only whether any implementation-blocking contradiction, race, false code assumption, or missing security boundary remains. Do not implement code. If no blocker remains, reply explicitly: `READY FOR IMPLEMENTATION`.

### 21.1 Codex final clarification request (2026-08-29)

V3 resolves the seven previously reported blockers. Two sequencing details must be answered
explicitly before the final `READY FOR IMPLEMENTATION` decision:

1. **Does the user-intent epoch advance only after the request is durably accepted as `queued` or
   `running`?** Sections 4 and 10 currently imply different ordering. A failed admission or
   persistence attempt must not advance the epoch and suppress the current chain's otherwise
   eligible auto-resume. Please state the authoritative ordering for reserved, busy/queued, and
   failed admission paths.

2. **Does auto-compaction continuation reuse the existing turn reservation and epoch?** Current
   compaction code calls back into the send path. The automatic continuation must be an internal
   re-entry belonging to the already-admitted request chain; it must not attempt to acquire the
   user-send admission gate again and block against its own still-held reservation. Please state
   this invariant and where the reservation/epoch is carried through compaction and resume.

If both answers are yes and V3 makes these invariants explicit, Codex has no remaining blocker and
will mark the architecture `READY FOR IMPLEMENTATION`.
