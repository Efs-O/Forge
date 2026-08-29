# Forge Remote Control — Architecture and Implementation Plan V2

Status: revised after Codex architecture review; ready for blocker-only re-review
Branch: `feat/remote-control-plan`
Target: Forge VS Code extension; no daemon/service extraction in V1

This document supersedes the first revision for implementation decisions. The original `REMOTE_CONTROL_PLAN.md` remains as the review trail.

## 1. Goal

Add a first-class remote-control surface to Forge so an authenticated owner can use a phone messaging client to interact with the same Forge conversations and agent runtime that the VS Code sidebar uses.

Primary scenarios:

- Send a normal task remotely: `update the README, run tests, stage and commit`.
- Continue the same Forge conversation from phone and VS Code.
- Receive final completion/failure notifications.
- Receive Forge-owned approval requests and approve/deny them remotely.
- Query status without spending an LLM turn.
- Stop an active turn remotely.
- Queue follow-up user requests while a conversation is busy without corrupting the transcript.

Initial transports:

1. Telegram — first implementation and reference transport.
2. WhatsApp Business App / ordinary WhatsApp account — optional experimental linked-device adapter after Telegram is stable.

Meta WhatsApp Cloud API is not a V1 dependency.

## 2. Fixed design decisions

The following are resolved and are no longer open implementation questions.

1. **Remote control is another Forge input/output surface, not another agent runtime.**
2. **Normal remote prompts use the existing `SendPipeline` / `AgentLoop` execution path.**
3. **Remote origin never grants additional execution authority.**
4. **Forge-native providers keep Forge tool permissions, approvals, checkpoints, `FORGE.md`, and denylist behavior unchanged.**
5. **CLI providers are allowed remotely.** They keep exactly their existing local CLI security/tool semantics. Remote origin neither elevates nor reduces their capabilities.
6. **The remote layer itself never exposes generic shell, Git, filesystem, or configuration commands.**
7. **`/stop` uses normal conversation-scoped cancellation.** `interrupt()` is reserved for future explicit steering.
8. **Busy-conversation input is durably queued per conversation rather than rejected.**
9. **A user request chain includes its turn plus any automatic compaction/resume continuation.** Queue draining occurs only after the full request chain settles.
10. **Accepted remote work is tracked durably before acknowledgement/execution.** A task found in `running` state after a crash is never automatically replayed.
11. **Cross-window transport ownership requires an atomic OS/filesystem lock, not VS Code `globalState` alone.**
12. **Create/restore operations used by remote control must support `activate: false`.**
13. **Transport input is a discriminated event: ordinary text vs provider action/button callback.**
14. **Every accepted remote request gets a Forge-side request ID used to correlate completion, queue state, and approvals.**
15. **One `RemoteController` serves all transports; provider-specific behavior remains in adapters.**
16. **Telegram is implemented first; WhatsApp cannot force changes to the core agent/session architecture.**

## 3. Core architecture

```text
VS Code Webview ───────────────────────┐
                                      │
Telegram ── RemoteChannel ─────────────┼── RemoteController ── RemoteForgeHost
                                      │                         │
WhatsApp ── RemoteChannel ─────────────┘                         ▼
                                                        existing SendPipeline
                                                                 │
                                                                 ▼
                                                           existing AgentLoop
                                                                 │
                                                  native model / CLI / cloud
                                                                 │
                                                   existing execution semantics
```

The remote controller is orchestration only. It authenticates, routes, queues, correlates, and delivers messages. It never implements an alternate tool-execution path.

## 4. Existing Forge architecture to reuse

### 4.1 `SendPipeline`

`src/sidebar/SendPipeline.ts` remains the canonical addressed-turn layer. It already handles:

- open-conversation lookup;
- same-conversation overlap protection;
- cancellation cleanup;
- request-time model/profile resolution;
- `generationStarted` UI state;
- `AgentLoop.runTurn(...)`;
- failure-tracker reset;
- session persistence;
- session synchronization;
- context-budget evaluation;
- session logging.

Remote code must not duplicate this logic.

Add a non-UI, addressed API that preserves the same path. `submitExternal()` is not appropriate because it targets the active conversation and reveals the sidebar.

### 4.2 `AgentLoop` / `TurnLifecycle`

Keep the existing per-conversation lifecycle model. Independent conversations may run concurrently subject to backend/VRAM/provider capacity.

Reuse existing controls:

- `isStreamingConv(id)`
- `getStreamingIds()`
- `cancel(id)`
- `interrupt(id)`
- `resolveConfirmation(id, approved)`
- session timing/status accessors

Do not add a global remote `busy` flag.

### 4.3 Conversation/session state

`ConversationRuntime` stays the source of truth for transcript, model/profile, plans, usage, CLI sessions, compaction and timing state.

Remote control must target an **open** conversation. Archived history can be listed, but must be restored before sending.

Never fall back silently to the active VS Code tab when an explicitly bound remote conversation disappears.

### 4.4 `FORGE.md`

For Forge-native models, remote turns continue through the existing prompt assembly, so `FORGE.md` remains authoritative with `AGENTS.md` fallback exactly as today.

Do not add a remote-specific system prompt that could weaken project instructions.

For `provider: cli`, keep the existing CLI adapter behavior. Do not claim Forge-native instruction injection semantics where the external CLI owns its own instruction loading.

### 4.5 Execution security semantics

Remote origin is transport metadata only.

For Forge-native providers:

```text
remote prompt
  -> SendPipeline
  -> AgentLoop
  -> ToolRegistry / ToolDispatch
  -> Forge permission gates
  -> Forge approvals
  -> Forge denylist
```

For CLI providers:

```text
remote prompt
  -> SendPipeline
  -> AgentLoop CLI path
  -> existing Codex/Claude CLI session
  -> existing CLI permissions/sandbox/tool behavior
```

The remote layer does not introduce `exec`, `git`, `write_file`, `powershell`, or similar host commands.

### 4.6 ControlServer

The localhost `ControlServer` remains bound to `127.0.0.1` and is not exposed/tunneled for remote messaging. This feature does not create an Internet-facing Forge HTTP control server.

## 5. New modules

```text
src/remote/
  RemoteTypes.ts
  RemoteChannel.ts
  RemoteController.ts
  RemoteForgeHost.ts
  RemoteCommandRouter.ts
  RemoteSessionRouter.ts
  RemoteRequestStore.ts
  RemoteQueue.ts
  RemoteAuth.ts
  RemoteDedup.ts
  RemoteTransportLease.ts
  RemoteApprovalBridge.ts
  RemoteRequestLifecycle.ts

  telegram/
    TelegramChannel.ts
    TelegramApi.ts
    TelegramFormatting.ts

  whatsapp/
    WhatsAppChannel.ts
    WhatsAppSession.ts
```

Provider-specific libraries/imports stay inside their adapter subtree.

## 6. Remote channel contract

Use normalized provider events.

```ts
export type RemoteInboundEvent =
  | {
      kind: 'text';
      channel: 'telegram' | 'whatsapp';
      messageId: string;
      senderId: string;
      chatId: string;
      chatType: 'private' | 'group' | 'channel' | 'unknown';
      text: string;
      receivedAt: number;
    }
  | {
      kind: 'action';
      channel: 'telegram' | 'whatsapp';
      messageId: string;
      senderId: string;
      chatId: string;
      chatType: 'private' | 'group' | 'channel' | 'unknown';
      actionId: string;
      payload: string;
      receivedAt: number;
    };
```

Suggested channel interface:

```ts
export interface RemoteChannel {
  readonly kind: 'telegram' | 'whatsapp';
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  send(message: RemoteOutboundMessage): Promise<RemoteDeliveryReceipt>;
  acknowledgeAction?(event: RemoteInboundEvent): Promise<void>;
  onEvent(handler: (event: RemoteInboundEvent) => void): Disposable;
}
```

Outbound semantic kinds:

- `accepted`
- `queued`
- `status`
- `approval`
- `final`
- `error`
- `notice`

Formatting, message-size limits and buttons remain adapter concerns.

## 7. Authentication, pairing and secrets

V1 is single-owner per configured transport account.

Requirements:

- remote disabled by default;
- default deny when no owner identity is configured;
- authorize on provider-stable IDs, never display names;
- reject non-private chats in V1;
- perform authorization before command/session routing or LLM invocation;
- do not place owner IDs, phone/JID values, access tokens or linked-device auth in workspace YAML;
- tokens/auth material use VS Code `SecretStorage` or protected global host storage as appropriate;
- logs redact/hash identities;
- provider IDs never enter model-facing prompt text.

### 7.1 Pairing

Prefer a local short-lived pairing code rather than requiring the user to discover raw provider IDs manually.

Example Telegram setup:

1. User runs `Forge: Configure Remote Control` locally.
2. Forge stores the bot token in `SecretStorage`.
3. Forge displays a random short-lived pairing code locally.
4. User sends `/pair <code>` to the bot from the desired private account.
5. Forge validates the code, stores that provider identity in protected host storage, and invalidates the code.
6. Forge sends a confirmation.

Pairing codes:

- high enough entropy for the short validity window;
- one-time use;
- expire quickly;
- never written to logs/transcripts;
- accepted only while local pairing mode is explicitly active.

## 8. Remote session binding

Maintain a per-chat binding:

```text
(channel, chatId) -> workspace identity + conversationId
```

Binding is presentation/routing state, separate from conversation transcript state.

Startup behavior:

- valid binding to open conversation -> use it;
- binding to archived conversation -> report archived, require `/resume`;
- stale/missing binding -> require `/use`, `/resume`, or `/new`;
- never guess the active tab.

Host commands:

- `/status`
- `/sessions`
- `/use <short-id>`
- `/resume <short-id>`
- `/new`
- `/stop`
- `/approve <approval-id>`
- `/deny <approval-id>`
- `/help`

No remote generic execution commands.

## 9. Non-activating conversation operations

Current create/restore behavior changes `activeConversationId`, which is undesirable for a background remote surface.

Add canonical operations supporting explicit activation semantics:

```ts
createConversation({ activate: false }): ConversationRuntime
restoreConversation(id, { activate: false }): ConversationRuntime
```

These operations must perform all required persistence/state bookkeeping without switching the user's visible VS Code tab or global model picker state.

Do not implement restore by activating and then switching back.

## 10. Remote request identity and durable state machine

Every accepted normal remote prompt receives a Forge-side request ID independent of provider message ID.

Example:

```ts
type RemoteRequestState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';
```

Persist at minimum:

```ts
interface RemoteRequestRecord {
  requestId: string;
  channel: 'telegram' | 'whatsapp';
  chatId: string;
  providerMessageId: string;
  conversationId: string;
  state: RemoteRequestState;
  createdAt: number;
  updatedAt: number;
  text: string; // only when needed to resume definitely-queued work
}
```

If prompt text is persisted for queued recovery, store it in protected/global host state rather than workspace-controlled files and document the privacy implication.

### 10.1 Acceptance ordering

For an idle conversation:

1. authenticate;
2. reject unsupported chat types;
3. deduplicate provider message ID;
4. resolve conversation binding;
5. validate request size/state;
6. create/persist request record;
7. mark `running` durably;
8. acknowledge `accepted`;
9. enter canonical Forge send path.

For a busy conversation:

1. same validation/dedup steps;
2. create/persist request as `queued`;
3. enqueue persistently;
4. acknowledge `queued`.

Durable state must exist before Forge tells the user it accepted/queued the task.

### 10.2 Crash rules

On extension restart:

- `completed`, `failed`, `cancelled` stay terminal;
- a definitely `queued` request may resume FIFO after transport/session recovery;
- a `running` request becomes `unknown` and is **never auto-replayed**;
- tell the user that outcome is unknown and require an explicit new instruction if needed;
- provider redelivery of a recorded message ID never starts a second task.

This intentionally prefers possible manual follow-up over duplicate side effects.

## 11. Deduplication

Deduplicate by:

```text
(channel, chatId, providerMessageId)
```

The durable request record is the authoritative dedup source. A bounded recent-ID index may optimize lookup but must not be the only crash-surviving source.

Provider redelivery must return/reflect existing state rather than re-execute.

Outbound notification failure never changes execution state back to queued/running and never causes task replay.

## 12. Busy queue semantics

Queue is **per conversation**, FIFO, bounded, and durable.

Each queue item retains:

- Forge request ID;
- origin channel/chat;
- provider message ID;
- prompt text;
- created timestamp.

Host commands `/status`, `/stop`, `/approve`, `/deny` bypass the normal user-message queue.

Ordinary text while busy:

- persists as `queued`;
- receives a `queued` acknowledgement;
- starts only after the current request chain is fully settled;
- never becomes implicit steering.

Queue limits:

- configurable max item count;
- max prompt size;
- explicit overflow error;
- no silent eviction.

## 13. Full request-chain settlement

A critical V2 correction: `SendPipeline.send()` returning is not automatically the correct queue-drain boundary because context threshold evaluation can trigger asynchronous auto-compaction and automatic resume.

Treat the following as one logical request chain:

```text
user prompt
   ↓
normal agent turn
   ↓ optional
context compaction
   ↓ optional
automatic continuation/resume
   ↓
REQUEST CHAIN SETTLED
```

Add a conversation-scoped chain/epoch abstraction owned close to existing send/compaction orchestration.

Required properties:

- each user-originated request increments/creates a conversation intent epoch;
- auto-compaction/resume belongs to that same epoch;
- a new real user prompt supersedes pending automatic continuation for the prior epoch;
- remote queue drain waits for chain settlement, not merely temporary non-streaming state;
- sidebar user input and remote user input use the same supersession semantics;
- compaction cannot race a queued remote turn into the transcript.

Do not implement the remote queue by polling `isStreamingConv()` alone.

## 14. Typed turn/request result

Remote delivery requires a real completion contract.

Change the canonical addressed send path to return a typed result rather than requiring callers to scrape UI/transcript/logs.

Suggested shape:

```ts
export type ForgeTurnOutcome =
  | { kind: 'completed'; finalText: string; incompleteReason?: undefined }
  | { kind: 'failed'; error: string; finalText?: string }
  | { kind: 'cancelled'; finalText?: string; incompleteReason?: string }
  | { kind: 'interrupted'; finalText?: string; incompleteReason?: string };
```

The exact location may be `AgentLoop.runTurn()` -> `SendPipeline` or a typed result assembled by `SendPipeline`, but the contract must be explicit.

Requirements:

- final assistant text comes from the actual turn result;
- no extra summarization LLM call;
- no parsing the webview;
- no reading session log files;
- result is correlated with the Forge remote request ID;
- full request-chain final delivery happens only after any auto-continuation for that same request finishes.

## 15. Remote completion correlation

Local sidebar turns and unrelated conversations must never trigger remote completion messages accidentally.

Maintain explicit correlation:

```text
remote requestId
  -> conversationId
  -> chain/epoch
  -> final outcome
  -> origin channel/chat
```

Only a chain created from that remote request may send that remote request's final notification.

A local user turn in the same conversation after the remote chain finishes is unrelated and must not inherit its remote origin.

## 16. Approval architecture

Keep `ToolApprovalService` as the single source of approval truth.

Preserve:

- one active approval plus queue;
- opaque approval ID;
- tool name/detail/dangerous flag;
- conversation association;
- abort/cancellation behavior;
- Clanker behavior;
- approval timer lifecycle;
- exact-ID `resolve` behavior.

Refactor only presentation coupling:

```text
ToolApprovalService
        │
        ├─ VS Code ApprovalSink
        └─ RemoteApprovalSink
```

Approval events should include enough correlation to associate an approval with the active remote request when one exists.

Security:

- only authorized remote identity may resolve;
- button callback or `/approve ID` resolves the existing stored approval only;
- no command reconstruction from text;
- resolved/cancelled/aborted IDs expire;
- replay returns expired/no-op;
- first valid resolution wins;
- losing surface receives a resolution/dismiss event.

### 16.1 CLI approvals

Remote normal prompts to CLI providers are allowed.

Do **not** invent a generic Forge approval proxy for external CLI prompts that Forge does not already structurally own. If a CLI integration later exposes a stable structured approval protocol, it can receive a dedicated bridge after separate review.

This does not block remote use of the CLI itself; it only prevents Forge from pretending it can safely approve opaque external prompts it does not control.

## 17. `/stop` and future `/steer`

`/stop` calls the same conversation-scoped `cancel()` semantics as Forge's Stop UI. It must not unload the backend merely to stop generation.

Future `/steer <text>` may explicitly:

1. `interrupt(conversationId)`;
2. wait for cancellation cleanup;
3. send the replacement prompt through the canonical addressed path.

Do not conflate stop and steer in V1.

## 18. `RemoteForgeHost` facade

Do not expose sidebar internals directly to transport adapters.

Add a narrow facade around current Forge behavior:

```ts
interface RemoteForgeHost {
  listSessions(): RemoteSessionSummary[];
  getStatus(conversationId: string): RemoteConversationStatus;
  send(
    conversationId: string,
    text: string,
    request: RemoteRequestContext,
  ): Promise<RemoteRequestOutcome>;
  cancel(conversationId: string): Promise<void>;
  createConversation(options: { activate: boolean }): Promise<string>;
  restoreConversation(id: string, options: { activate: boolean }): Promise<string>;
  resolveApproval(id: string, approved: boolean): void;
}
```

It should delegate to existing `SendPipeline`, `AgentLoop`, `ConversationTabs`/ops and session persistence rather than reimplementing them.

Preferred location is a small class wired beside the existing sidebar collaborators if that produces cleaner tests; methods directly on `SidebarProvider` are acceptable if they remain narrow.

## 19. Status host command

`/status` is deterministic host state, not an LLM request.

Return bounded information such as:

- workspace name;
- bound conversation title/short ID;
- model/profile;
- running / idle / cancelling / compacting / queued;
- current remote request ID/state;
- queue depth;
- pending Forge approval if any;
- active session time;
- context usage when cheaply available;
- transport health.

Do not expose secrets, full filesystem paths unless deliberately useful, or provider authentication data.

## 20. Transport ownership across VS Code windows

V1 permits one active consumer for a given transport/account identity.

VS Code `globalState` alone is not sufficient because it cannot atomically compare-and-set between extension hosts.

Use an atomic OS/filesystem primitive, for example:

- exclusive creation of a lock file in Forge global storage, or
- an equivalent lock library with proven cross-process semantics.

Lock identity should include transport/account identity.

Lock record may contain:

- pid;
- extension host/window instance ID;
- workspace identity;
- acquired timestamp;
- heartbeat timestamp.

Requirements:

- atomic acquisition;
- no second poller/socket for the same account;
- stale-owner recovery after crash;
- PID-reuse considerations similar to Forge shared-runtime leases;
- release on clean disposal;
- conservative failure: if ownership cannot be proven, do not start a second consumer.

A descriptive `globalState` record may accompany the lock for UI, but is not the lock.

## 21. Remote persistence

Separate remote operational state from Forge conversation persistence.

Conversation/session data remains in existing workspace session state.

Remote operational state includes:

- owner identities;
- chat/session bindings;
- durable request records;
- queue order;
- dedup metadata;
- transport setup/account metadata;
- lease metadata where appropriate.

Sensitive data stays outside workspace-controlled files.

Use awaited persistence for acceptance/queue state transitions. Do not fire-and-forget the durable write that is supposed to prevent duplicate execution.

## 22. Extension lifecycle

Each transport runtime owns an `AbortController` covering:

- long polling;
- reconnect loops;
- backoff timers;
- provider network waits.

Activation:

1. load Forge config/runtime;
2. initialize sidebar/agent collaborators;
3. if remote disabled, do nothing else;
4. load protected remote settings;
5. acquire atomic transport lease;
6. initialize `RemoteController` and host facade;
7. start transport with AbortSignal;
8. recover durable queue/request state under crash rules.

Disposal/config reload:

1. stop accepting new inbound events immediately;
2. abort polling/reconnect/backoff;
3. detach listeners;
4. wait for transport stop as lifecycle permits;
5. persist final remote operational state;
6. release lease;
7. do not kill llama-server just because remote transport stops.

Config reload must replace a consumer, never start another beside it.

## 23. Telegram V1

Telegram is the first real adapter.

Prefer direct official Bot API HTTPS calls using Forge's existing Node HTTP/fetch capabilities unless a library demonstrates clear value.

Required behavior:

- long polling (`getUpdates`) initially; no public webhook;
- clean AbortSignal cancellation;
- retry/backoff for transient failures;
- correct update offset management;
- private-chat enforcement;
- pairing flow;
- send message;
- safe chunking within Telegram limits;
- safe formatting/escaping;
- inline approval buttons where appropriate;
- action callback acknowledgement;
- stable provider message/action IDs;
- no blocking of VS Code extension host event loop.

Before dependency introduction, verify current VS Code Node runtime, proxy handling, bundling and license.

## 24. WhatsApp Business App / ordinary-account adapter

WhatsApp is Phase 5, after Telegram validates the architecture.

Target: linked-device model compatible with the normal WhatsApp/WhatsApp Business App account, not Meta Cloud API.

This integration is unofficial and should be clearly marked experimental.

Requirements:

- opt-in only;
- recommend a dedicated/secondary number rather than a business-critical account;
- verify library maintenance/license/Node compatibility/reconnect/auth persistence/esbuild behavior at implementation time;
- QR/pairing isolated to adapter/setup UI;
- linked-device credentials stored outside workspace;
- normalize all inbound events into the shared channel contract;
- groups rejected in V1;
- `/approve ID` and `/deny ID` text fallback required even if buttons/actions are unavailable;
- no WhatsApp-specific import outside its adapter subtree.

If WhatsApp requires modifying agent/session semantics, stop and review the abstraction rather than leaking provider quirks into core.

## 25. Configuration

Keep non-secret feature behavior in normal config, but not owner IDs/tokens/auth blobs.

Example:

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

Sensitive identities and credentials are configured through setup and protected host storage.

Suggested command:

`Forge: Configure Remote Control`

Setup can:

- enable transport;
- store token or initiate linked-device setup;
- enter pairing mode;
- verify owner;
- choose/bind initial conversation;
- send test notification;
- show WhatsApp experimental warning.

## 26. Privacy model

Document clearly that:

- accepted remote prompt text enters the Forge conversation transcript exactly like local user text;
- final answers and Forge approval details are transmitted through the selected messaging provider;
- remote operational metadata is stored by Forge to provide deduplication/recovery;
- access tokens, linked-device credentials and pairing codes are never stored in transcripts or workspace files;
- provider identity values are redacted/hashed in normal logs.

## 27. Observability

Structured logs should cover:

- transport start/stop/reconnect;
- lease acquisition/rejection/recovery;
- authorized inbound message ID/channel;
- rejected unauthorized event without leaking identity;
- request ID state transitions;
- session binding changes;
- queue depth/drain;
- approval lifecycle;
- outbound delivery success/failure;
- crash recovery decisions (`running -> unknown`, queued resumed, etc.).

Do not log tokens, auth blobs, pairing codes, full approval payloads or full prompt text at normal info level.

## 28. Testing strategy

### 28.1 Core unit tests

- owner authorization allow/deny;
- pairing-code expiry/one-time semantics;
- group rejection;
- command parser exactness;
- short session ID ambiguity;
- stale/archived binding behavior;
- create/restore `activate:false` leaves visible active tab unchanged;
- provider message dedup;
- durable request state transitions;
- crash `running -> unknown` and no replay;
- queued recovery;
- queue FIFO/cap/overflow;
- `/stop` bypasses queue and calls cancel, not interrupt;
- callback action parsing/ack handling;
- approval exact-ID resolution/replay no-op;
- request/completion correlation;
- no remote-origin permission changes;
- CLI conversation accepted remotely with existing CLI path unchanged.

### 28.2 Request-chain tests

- normal turn settles -> queue drains;
- turn triggers auto-compaction -> queue does not drain early;
- compaction auto-resumes -> queued request waits until resume settles;
- queued real user request supersedes any still-pending automatic continuation according to shared epoch semantics;
- local sidebar prompt and remote prompt use the same intent supersession rules.

### 28.3 Fake transport integration tests

Use `FakeRemoteChannel` with existing fake backend/model infrastructure.

Test:

1. remote text -> canonical SendPipeline -> model -> final reply;
2. remote request gets unique request ID and correlated final;
3. local turn in same conversation does not send remote final;
4. Forge-native tool approval -> remote approval -> same turn continues;
5. VS Code approval wins -> remote approval UI dismissed;
6. duplicate provider event -> exactly one turn;
7. final notification failure -> no rerun;
8. busy follow-up persists/queues/drains FIFO;
9. crash while running -> unknown, no replay;
10. stale bound conversation -> explicit error, no active-tab fallback;
11. `FORGE.md` still present through native model path;
12. native permissions/denylist unchanged;
13. CLI provider follows existing CLI execution path and remote adds no host shell API;
14. two conversations remain independently runnable where backend capacity permits.

### 28.4 Lease tests

Use multiple simulated/process instances if feasible:

- first owner acquires;
- second denied;
- clean release allows next;
- stale/dead owner recoverable;
- malformed lock conservative handling;
- PID-reuse defense documented/tested where practical.

### 28.5 Regression suite

With remote disabled, all existing behavior remains unchanged:

- sidebar send/steer/stop;
- approvals;
- model/profile pinning;
- persistence;
- compaction;
- checkpoints;
- shared runtime/backend lifetime;
- CLI warm sessions;
- tool permissions/denylist.

CI: existing `npm run ci` plus remote tests.

## 29. Implementation phases

### Phase 0 — blocker-only Codex re-review

Codex checks this V2 against current `main` and the prior review. It should report only:

- remaining architectural contradictions;
- security blockers;
- race conditions not resolved here;
- places where this plan still duplicates or bypasses existing Forge behavior;
- implementation assumptions that are false in current code.

No implementation yet.

### Phase 1 — core host seams, typed results and request-chain lifecycle

- typed addressed-turn result;
- request/chain correlation ID;
- chain/epoch settlement across compaction/resume;
- `RemoteForgeHost` facade;
- non-activating create/restore;
- regression tests for existing sidebar path.

Exit: core APIs exist without any network adapter and existing UI behavior remains green.

### Phase 2 — durable remote core with fake channel

- normalized event/channel types;
- auth/pairing state abstraction;
- command/session router;
- durable request store/dedup;
- per-conversation queue;
- crash recovery rules;
- transport lease abstraction;
- fake transport integration tests.

Exit: fake channel can safely drive/queue/stop real Forge turns and survive simulated restart semantics.

### Phase 3 — approval decoupling

- replace webview availability precondition with multi-sink/event presentation;
- preserve single `ToolApprovalService` queue;
- remote approval correlation;
- first-resolution-wins UI dismissal;
- approval regression tests.

Exit: VS Code approvals behave identically and remote Forge-owned approvals work.

### Phase 4 — Telegram

- Bot API transport;
- long polling + cancellation/backoff;
- SecretStorage token;
- local pairing;
- owner auth;
- action callbacks/buttons;
- message chunking/formatting;
- atomic transport lock integration;
- end-to-end phone test.

Exit: phone -> Forge -> native or CLI model -> tools/turn -> completion works reliably while VS Code remains open.

### Phase 5 — hardening

- restart/recovery testing;
- delivery-failure testing;
- queue overflow/stale binding;
- transport health/status;
- config reload/disposal;
- privacy/security docs.

### Phase 6 — WhatsApp experimental adapter

- library/runtime ADR/spike;
- linked-device auth/persistence;
- adapter implementation behind existing contract;
- same auth/session/queue semantics;
- explicit experimental warning.

Core architecture must not change for WhatsApp.

## 30. Acceptance criteria

Implementation is complete only when:

- remote is off by default;
- owner setup does not place secrets/identities in workspace YAML;
- only the paired/authorized private identity can control Forge;
- remote normal text uses canonical Forge send/agent behavior;
- Forge-native security semantics are unchanged;
- CLI remote turns are supported with their existing local CLI semantics and no new remote host execution API;
- `FORGE.md` behavior remains unchanged for Forge-native agents;
- busy remote input is durable and cannot corrupt transcript order;
- request-chain settlement prevents queue/auto-compaction races;
- duplicate provider messages cannot execute the same recorded request twice;
- crash during running never auto-replays the task;
- notification failure never reruns execution;
- `/stop` cancels the correct conversation without unloading the backend;
- non-activating create/restore does not move the user's visible VS Code conversation;
- approvals retain one canonical Forge queue and can be resolved from VS Code or authorized remote where Forge owns the approval;
- remote completion is correlated to the correct remote request only;
- cross-window transport ownership is atomic;
- session/transcript persistence remains correct;
- existing Forge tests remain green when remote is disabled;
- Telegram requires no Internet-facing webhook/server;
- WhatsApp can be added without changing core agent/session semantics;
- no Internet-facing Forge HTTP control API is introduced.

## 31. Final blocker-only review prompt for Codex

Use exactly this intent before implementation:

> Review `docs/plans/REMOTE_CONTROL_PLAN_V2.md` on branch `feat/remote-control-plan` against current Forge `main` and your previous architecture review in `REMOTE_CONTROL_PLAN.md` section 24.1. Verify that every required correction is actually resolved. CLI providers are intentionally supported remotely with their existing local CLI security semantics; remote origin adds no privilege and the remote layer exposes no generic shell/Git/filesystem API. Report only remaining blockers, contradictions, race conditions, false assumptions, or necessary plan corrections. Do not implement code. If there are no blockers, say explicitly that the plan is ready for implementation.
