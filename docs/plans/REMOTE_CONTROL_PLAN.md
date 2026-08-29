# Forge Remote Control — Architecture and Implementation Plan

Status: design for Codex review before implementation
Branch: `feat/remote-control-plan`
Target: Forge VS Code extension; no daemon/service extraction in V1

## 1. Goal

Add a first-class remote-control surface to Forge so an authenticated owner can use a phone messaging client to interact with the same Forge conversations and agent runtime that the VS Code sidebar uses.

Primary scenarios:

- Send a normal task remotely: `update the README, run tests, stage and commit`.
- Receive final completion/failure notifications.
- Receive approval requests and approve/deny them remotely.
- Query status without spending an LLM turn.
- Stop an active turn remotely.
- Continue an existing Forge conversation from the phone and later continue the same conversation in VS Code.

Initial transports:

1. Telegram — reference/V1 transport because it has a stable official bot API and is easy to test.
2. WhatsApp Business App / ordinary WhatsApp account — optional adapter using a linked-device/Web transport such as Baileys. This is an unofficial integration and MUST remain isolated behind the transport interface. It must not be required for the remote-control core.

Meta WhatsApp Cloud API is deliberately not a V1 dependency.

## 2. Non-goals

V1 does NOT:

- turn Forge into a standalone OpenClaw/Hermes-style daemon;
- expose Forge's localhost ControlServer to the Internet;
- provide a remote shell;
- bypass Forge tools, permissions, approvals, checkpoints, or `FORGE.md`;
- grant remote prompts more authority than sidebar prompts;
- remotely modify Forge configuration;
- support arbitrary multiple remote users;
- support group-chat control;
- support voice, images, documents, or other attachments initially;
- promise operation after VS Code/Forge or the host machine has stopped;
- use the LLM to implement host commands such as status/stop/approval;
- change the native ToolCallingLoop simply because a prompt originated remotely.

## 3. Core design principle

Remote control is another Forge input/output surface, not another agent runtime.

```text
VS Code Webview ───────────────┐
                              │
Telegram ── RemoteChannel ────┼── RemoteController ── existing SendPipeline
                              │                         │
WhatsApp ── RemoteChannel ────┘                         ▼
                                                existing AgentLoop
                                                       │
                                             Qwen / CLI / cloud model
                                                       │
                                             existing Forge tools
                                                       │
                                      permissions / approvals / denylist
```

The phone must never execute filesystem, Git, terminal, model, or workspace actions directly. Normal text becomes a normal Forge user turn and enters the same `SendPipeline` / `AgentLoop` path used by the sidebar.

## 4. Existing Forge architecture to reuse

The implementation should deliberately reuse these existing boundaries instead of duplicating them.

### 4.1 `SendPipeline`

`src/sidebar/SendPipeline.ts` is already the canonical path from user input to a running turn. It:

- resolves a conversation;
- prevents overlapping turns on the same conversation;
- waits for cancellation cleanup;
- resolves `conv.active_model ?? config.active_model` through `resolveRequestModel`;
- preserves model/profile selection;
- emits `generationStarted`;
- invokes `AgentLoop.runTurn`;
- persists the session in `finally`;
- republishes session/context state;
- flushes the session log.

Remote normal messages MUST reuse `SendPipeline.send(...)`; they must not call providers or `AgentLoop.runTurn` through a parallel hand-built execution path.

`submitExternal()` is close but is tied to the active conversation and opens the Forge sidebar. The remote controller needs an addressed equivalent that can target a known open conversation without changing VS Code focus. Prefer a small public API on `SendPipeline`/`SidebarProvider` rather than duplicating `send()` logic.

### 4.2 `AgentLoop` and `TurnLifecycle`

`AgentLoop` already exposes the control operations needed by the remote layer:

- `isStreamingConv(id)`
- `getStreamingIds()`
- `cancel(id)`
- `interrupt(id)`
- `resolveConfirmation(id, approved)`
- `getSessionActiveMs(conv)`

`TurnLifecycle` is already per-conversation. Active, non-cancelled conversations are intentionally independent. Remote code must preserve that property.

No new global `busy` flag is allowed.

### 4.3 Conversations and persistence

`ConversationRuntime` already provides stable IDs, titles, timestamps, transcript, active model/profile, CLI session IDs, compaction state, task plan, display diffs and usage/timing state.

`SidebarProvider.getConversation(id)` already resolves open conversations and history. However, `SendPipeline.send` intentionally only targets open conversations. Remote execution must therefore target an OPEN conversation. Archived/history conversations may be listed, but must be explicitly restored before a new turn is sent to them.

Remote routing must not silently fall back to the currently active conversation when an explicitly selected conversation disappears.

### 4.4 `FORGE.md`

`ForgeInstructionsLoader` makes `FORGE.md` authoritative for Forge-native agents and uses `AGENTS.md` as compatibility fallback. It resolves repository scope, watches for changes, caps content at 15,000 bytes and feeds it into native prompts.

Remote turns use the same model path, so `FORGE.md` behavior remains unchanged. There must be no separate remote system prompt that can weaken or override project instructions.

### 4.5 Permissions and command denylist

Forge already resolves model-visible tool capabilities through `PermissionResolver`. Once a permissions block exists, sensitive capabilities such as terminal, headless execution, network access, delete and git-write are deny-by-default unless enabled.

The existing command denylist additionally rejects dangerous commands before terminal dispatch, including destructive Git operations, every `git push`, destructive PowerShell operations, PowerShell eval/encoded commands, disk formatting and other hazards.

Remote origin MUST NOT change these permissions. A remote request such as `force push main` is just a user prompt; it does not grant a transport-level Git operation.

### 4.6 Existing ControlServer

`src/backend/ControlServer.ts` is a localhost-only model lifecycle API for external orchestrators. It is intentionally bound to `127.0.0.1`.

Do not expose or tunnel it for this feature. Remote control concerns conversations, approvals and turns, whereas ControlServer currently concerns model lifecycle/discovery/chat proxying. Reuse ideas/contracts where useful, but keep the Internet-facing transport completely separate from this localhost server.

## 5. Proposed modules

```text
src/remote/
  RemoteChannel.ts
  RemoteController.ts
  RemoteCommandRouter.ts
  RemoteSessionRouter.ts
  RemoteApprovalBridge.ts
  RemoteEventBridge.ts
  RemoteTypes.ts
  RemoteAuth.ts
  RemoteDedup.ts

  telegram/
    TelegramChannel.ts
    TelegramApi.ts

  whatsapp/
    WhatsAppChannel.ts
    WhatsAppSession.ts
```

Transport adapters must contain provider-specific networking/auth/message formatting only. They must not know how to execute a Forge task.

## 6. Transport contract

Suggested conceptual interface (exact naming may change during implementation):

```ts
export interface RemoteChannel {
  readonly kind: 'telegram' | 'whatsapp';
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: RemoteOutboundMessage): Promise<RemoteDeliveryReceipt>;
  onMessage(handler: (message: RemoteInboundMessage) => void): Disposable;
}
```

Normalized inbound envelope should contain at least:

```ts
interface RemoteInboundMessage {
  channel: 'telegram' | 'whatsapp';
  messageId: string;
  senderId: string;
  chatId: string;
  text: string;
  receivedAt: number;
}
```

Provider message IDs are required for deduplication.

Outbound messages should support semantic kinds instead of transport-specific strings:

- `ack`
- `status`
- `approval`
- `final`
- `error`
- `notice`

Adapters decide whether an approval is represented by Telegram inline buttons, WhatsApp interactive facilities when available, or a text fallback.

## 7. Authentication and authorization

This is the primary security boundary of the transport layer.

V1 is single-owner / explicit allowlist.

Requirements:

- Default deny when no owner identity is configured.
- Authenticate on provider-stable sender/chat IDs, not display names or phone contact labels.
- Do authorization BEFORE command routing, session routing or LLM invocation.
- Never log access tokens, WhatsApp linked-device credentials or full secret payloads.
- Store Telegram tokens in VS Code `SecretStorage`.
- Store WhatsApp linked-device credentials outside the workspace and protect them as account credentials.
- Do not put credentials in `config.yaml`, `FORGE.md`, workspace files or session transcripts.
- Remote origin cannot elevate Forge tool permissions.
- Groups are rejected in V1 even if the authorized owner is present in the group.

A future pairing flow may simplify owner-ID setup, but it must end by persisting an exact allowlisted identity.

## 8. Session routing

Remote routing needs explicit state because the VS Code active tab is presentation state, not a safe remote target.

Maintain a small per-channel/chat binding:

```text
(channel, chatId) -> workspace identity + conversationId
```

For V1, one running VS Code workspace owns the channel configuration. Do not attempt machine-wide cross-window orchestration yet.

Default behavior after startup:

- If a persisted remote binding points to an existing OPEN conversation, use it.
- If it points to history, report that it is archived and require `/resume <id>`.
- If it points nowhere, do not guess. Ask the user to select a session or bind to the active open conversation through an explicit host command.

Suggested host commands:

- `/status`
- `/sessions`
- `/use <short-id>` — bind to an existing open conversation
- `/resume <short-id>` — restore archived conversation and bind it
- `/new` — create a conversation and bind it
- `/stop`
- `/approve <approval-id>`
- `/deny <approval-id>`
- `/help`

Do not implement file/Git/terminal operations as slash commands.

Conversation IDs shown remotely should use unambiguous short prefixes only when unique. Otherwise require more characters. Never guess between collisions.

## 9. Incoming message semantics

### 9.1 Idle conversation

Normal authenticated text:

1. deduplicate provider message ID;
2. resolve remote binding;
3. validate target is an open conversation;
4. send immediate `accepted` acknowledgement;
5. call the existing addressed send path;
6. publish final/error result through the origin channel.

### 9.2 Busy conversation

Do NOT automatically inject a second turn while the target conversation is streaming; `SendPipeline` correctly treats overlap as transcript corruption.

V1 behavior:

- host commands `/status`, `/stop`, `/approve`, `/deny` bypass the normal message queue and are handled immediately;
- ordinary text received while the bound conversation is streaming is stored in a bounded per-conversation remote inbox and acknowledged as `queued`;
- after the turn settles, process queued messages FIFO one at a time;
- cap queue length and text size; reject overflow explicitly;
- never silently discard a queued command;
- do not automatically reinterpret ordinary text as steering.

Future V2 may expose `/steer <text>`, implemented exactly like the existing webview steering path: `AgentLoop.interrupt(conversationId)` followed by `SendPipeline.send(...)`. Steering is deliberately explicit because it aborts the current model response.

### 9.3 Stop

`/stop` calls the same conversation-scoped cancellation path as Forge's Stop behavior. It must leave the loaded backend alive, preserving current warm-runtime semantics.

## 10. Approval architecture

This area needs a small refactor because `ToolApprovalService` currently owns correct queue/state semantics but also assumes a webview is available.

Preserve:

- one active approval plus queue;
- opaque unique approval ID;
- tool name/detail/dangerous flag;
- conversation ID;
- abort handling;
- timer pause/resume callbacks;
- `resolve(id, approved)` as the authoritative resolution operation.

Refactor presentation out of the approval service. Conceptually:

```text
ToolApprovalService
      │ approval requested
      ├──────── VS Code ApprovalSink
      └──────── RemoteApprovalSink
```

Do not create two approval queues.

The remote bridge receives the already-created approval object/ID and renders it. A remote `/approve ID` or button callback resolves that exact stored request. It MUST NOT reconstruct a command from message text.

Security rules:

- Only the authorized remote identity can resolve a remote approval.
- Approval IDs expire when resolved/cancelled/aborted.
- Stale/replayed approval callbacks return `expired` and do nothing.
- Dangerous actions remain dangerous; remote transport does not auto-approve them.
- Existing Clanker mode semantics remain unchanged.

Important design decision for Codex review: whether an approval should be broadcast to both the webview and remote channel, or whether presentation sinks have priority. Recommended V1: show in both when a remote channel is connected. First valid resolution wins; the other surface receives a resolved/dismissed event.

## 11. Turn/event bridge and responses

Do not scrape rendered webview messages to determine task completion.

Add explicit typed lifecycle events at an appropriate host boundary. Needed events:

- turn accepted/started;
- turn completed;
- turn failed;
- turn cancelled/interrupted;
- approval requested/resolved;
- optional meaningful status/progress events later.

The final remote response should come from the actual assistant turn result, not from an extra LLM summarization request.

If the existing event surface cannot provide final assistant content cleanly, add a typed completion result to `SendPipeline.send` or an event emitted after `AgentLoop.runTurn` settles. Do not parse session log files.

Suggested phone UX:

```text
✓ Accepted — Forge / <conversation title> / <model>

[only meaningful approval/status messages while running]

✓ Finished
<assistant final text, capped/formatted for transport>
```

Errors must distinguish:

- task failed inside Forge;
- task succeeded but outbound notification failed;
- transport disconnected;
- no valid session binding;
- busy/queue overflow;
- unauthorized sender (prefer silent drop + local audit log).

## 12. Delivery reliability and deduplication

Remote control can cause side effects, so duplicate inbound delivery must not duplicate agent turns.

Requirements:

- deduplicate inbound messages by `(channel, chatId, messageId)`;
- maintain a bounded recent-ID cache with persistence sufficient to survive a short extension restart/reconnect;
- only mark an inbound normal message accepted after it has passed auth/routing/queue validation;
- outbound send returns a receipt/failure;
- retry outbound notifications conservatively, but NEVER retry the underlying Forge turn because delivery of its final message failed;
- on reconnect, do not replay already-accepted inbound messages;
- maintain separate `task state` and `notification delivery state`.

Exactly-once execution cannot be guaranteed across every external provider failure, but Forge must provide at-most-once execution for provider message IDs it has recorded.

## 13. Origin metadata

It is useful to record where a user turn came from, but origin is informational and MUST NOT affect authority.

Prefer optional host-side metadata rather than injecting noisy text into the model prompt:

```ts
type PromptOrigin =
  | { kind: 'vscode' }
  | { kind: 'telegram'; chatId: string; messageId: string }
  | { kind: 'whatsapp'; chatId: string; messageId: string };
```

If origin is persisted, keep provider IDs out of model-facing content and consider privacy implications. The model normally does not need to know whether the user typed on a phone.

## 14. Checkpoints / Keep / Undo

Remote tasks must preserve Forge's existing checkpoint behavior.

V1 should NOT remotely expose raw checkpoint internals. Consider these host commands only after core operation is stable:

- `/keep`
- `/undo`

If added, they must call the same `SidebarProvider.keep()` / `undo()` operations and return affected paths/status. They must never be implemented by asking the model to run compensating shell commands.

For initial implementation, leaving Keep/Undo in VS Code is acceptable and reduces remote destructive surface.

## 15. Telegram V1

Telegram should be the first adapter used to validate the architecture.

Requirements:

- official Bot API;
- long polling is preferred initially so Forge needs no public inbound webhook;
- bot token in SecretStorage;
- owner chat/user ID allowlist;
- ignore/reject groups;
- inline approval buttons carrying opaque approval IDs;
- handle Telegram message length limits by safe chunking;
- escape/format model output safely;
- reconnect/backoff without blocking the extension host;
- transport stop/dispose integrated with extension disposal/config reload.

Do not make the Telegram adapter own conversation state or Forge execution logic.

## 16. WhatsApp Business App / regular-account adapter

WhatsApp support is intentionally secondary.

Target is the ordinary WhatsApp/WhatsApp Business App linked-device model, not Meta Cloud API.

A Baileys-style adapter is unofficial and carries account/platform-policy risk. Therefore:

- feature must be explicitly opt-in and labelled experimental;
- document that a dedicated/secondary number is safer than a business-critical account;
- never make WhatsApp a dependency of remote core or Telegram;
- QR/device pairing belongs to the adapter/setup UI;
- persist linked-device auth outside workspace;
- handle reconnect/logout/device-revocation cleanly;
- normalize messages into the same `RemoteInboundMessage` contract;
- ignore groups in V1;
- approval buttons are optional; `/approve ID` and `/deny ID` are required fallbacks;
- no code outside `src/remote/whatsapp` should import the WhatsApp library.

Before implementation, Codex should verify the selected WhatsApp library's current Node/runtime compatibility, licensing, maintenance status and bundling behavior with Forge/esbuild/VS Code. Do not lock a library in this architecture document without that check.

## 17. Configuration shape

Exact schema may change, but keep transport config separate from secrets.

Example:

```yaml
remote:
  enabled: false
  queue_limit: 5
  telegram:
    enabled: false
    owner_ids: []
  whatsapp:
    enabled: false
    owner_ids: []
```

Tokens/credentials are not YAML fields.

Configuration defaults MUST leave remote access disabled.

Consider a setup command rather than requiring manual IDs/secrets:

- `Forge: Configure Remote Control`
- enable Telegram;
- store bot token in SecretStorage;
- pair/verify owner identity;
- choose initial conversation-binding behavior;
- test outbound message;
- display security warning for WhatsApp experimental mode.

## 18. Multi-window/workspace behavior

This is the largest V1 boundary to keep explicit.

Forge sessions are per-workspace (`workspaceState`) and each VS Code extension host can have its own `SidebarProvider`. A messaging account cannot safely have multiple independent windows all consuming the same Telegram/WhatsApp inbound stream.

V1 options:

A. Recommended: remote transport is enabled for one Forge workspace/window at a time. Detect another owner/lease and refuse a second consumer.

B. More complex: create a machine-wide remote broker that routes to extension windows through the existing ControlServer registry or a new registry.

Choose A for V1. A machine-wide broker is effectively the first step toward the daemon architecture deliberately excluded from this feature.

Implement a lightweight global-storage lease/owner record if required. It should include enough identity/heartbeat information to prevent two windows from consuming the same bot account. Stale leases must be reclaimable after crashes.

## 19. Extension lifecycle

Remote transports live with the extension host in V1.

On activation when remote is enabled:

1. load config;
2. initialize `SidebarProvider` and normal Forge runtime first;
3. acquire remote transport lease;
4. load credentials from SecretStorage;
5. start enabled transport(s);
6. bind RemoteController to SidebarProvider/SendPipeline/AgentLoop public facade.

On dispose/reload:

- stop polling/sockets;
- stop accepting new inbound messages;
- preserve accepted-message dedup state;
- release transport lease;
- do not kill llama-server merely because remote transport stopped;
- do not leave unresolved remote approvals falsely marked approved.

## 20. Public facade instead of exposing internals

Do not make `AgentLoop`, `SendPipeline`, `ConversationTabs` public globally just for remote control.

Add a narrow Forge-host facade, likely owned by `SidebarProvider`, such as:

```ts
interface RemoteForgeHost {
  listSessions(): RemoteSessionSummary[];
  getStatus(conversationId: string): RemoteConversationStatus;
  send(conversationId: string, text: string, origin: PromptOrigin): Promise<RemoteTurnResult>;
  interrupt(conversationId: string): Promise<void>;
  createConversation(): Promise<string>;
  restoreConversation(id: string): Promise<void>;
  resolveApproval(id: string, approved: boolean): void;
}
```

The facade delegates to existing components. This is the main seam that keeps the feature maintainable and prevents transport code from depending on sidebar implementation details.

Codex should evaluate whether `RemoteForgeHost` belongs as methods on `SidebarProvider` or as a small class wired by `sidebarWiring.ts`. Prefer the smallest change that preserves testability.

## 21. Testing strategy

This feature is too side-effectful for manual-only testing.

### Unit tests

- authorization allow/deny;
- command parser exactness;
- session short-ID ambiguity;
- session missing/archived behavior;
- inbound dedup;
- queue ordering/cap;
- `/stop` bypasses queue;
- approvals resolve exact ID only;
- stale approval replay does nothing;
- outbound chunking/escaping;
- transport disconnect/reconnect state;
- no origin-based permission elevation.

### Integration tests with fake channel

Create `FakeRemoteChannel` and exercise:

1. remote message -> existing SendPipeline -> mocked model -> final reply;
2. model requests tool approval -> fake channel receives approval -> remote approve -> same turn continues;
3. busy turn -> second normal message queued -> first settles -> second starts;
4. busy turn -> `/stop` cancels immediately;
5. duplicate provider message -> exactly one Forge turn;
6. final notification fails -> Forge turn is NOT rerun;
7. conversation removed after binding -> explicit error, no fallback;
8. remote turn still observes normal tool permissions/denylist;
9. FORGE.md remains injected through the normal native model path;
10. two conversations may run independently when the existing backend/runtime configuration permits it.

### Regression tests

Existing sidebar behavior must remain unchanged with `remote.enabled: false`:

- send/steer/stop;
- approvals;
- model/profile pinning;
- session persistence;
- auto-compaction;
- checkpoints;
- shared runtime/backend survival;
- CLI warm sessions.

CI gate remains the existing `npm run ci` plus new remote tests.

## 22. Observability

Add structured, privacy-conscious logs:

- transport start/stop/reconnect;
- authorized inbound message ID + channel (not full text at info level);
- rejected unauthorized sender (hashed/redacted identity where appropriate);
- binding changes;
- queue depth;
- approval ID lifecycle;
- outbound delivery success/failure;
- remote task accepted/completed/failed.

Never log tokens, WhatsApp auth blobs or secret contents.

A `/status` response should be generated from host state, not the LLM, and include useful bounded data such as:

- workspace name;
- bound conversation title/short ID;
- model/profile;
- running/idle/cancelling;
- active time / context usage if cheaply available;
- queued remote message count;
- pending approval if applicable.

## 23. Implementation phases

### Phase 0 — Codex architecture review

Before code, review this document against current `main` and answer the review questions in section 24. Amend the plan first if any assumption is wrong.

### Phase 1 — Core remote abstraction, no network

- Add normalized types.
- Add `RemoteForgeHost` facade.
- Add `RemoteController`, auth, command router, session router, dedup and queue.
- Add `FakeRemoteChannel`.
- Add lifecycle/completion result/event seam.
- Tests only; no Telegram dependency yet.

Exit criterion: fake channel can drive a real Forge conversation path in tests without bypassing SendPipeline.

### Phase 2 — Approval decoupling

- Refactor `ToolApprovalService` presentation into sink/event mechanism without changing queue semantics.
- Preserve current webview behavior.
- Add remote approval bridge.
- Test first-valid-resolution-wins and cancellation/replay cases.

Exit criterion: sidebar approval regression tests pass and fake remote approval can continue a suspended turn.

### Phase 3 — Telegram

- Bot API long-poll adapter.
- SecretStorage setup.
- owner pairing/allowlist.
- status/session/stop/approval commands.
- final/error delivery.
- safe output chunking.
- reconnect/backoff.
- single-window transport lease.

Exit criterion: end-to-end phone -> Forge -> model/tools -> approval -> phone works while VS Code stays open.

### Phase 4 — Hardening

- crash/restart dedup behavior;
- queue limits;
- stale bindings;
- transport health/status;
- config reload/disposal;
- notification delivery failure cases;
- documentation/security notes.

### Phase 5 — WhatsApp experimental adapter

Only after the core and Telegram path are stable.

- verify current library choice/runtime compatibility;
- implement linked-device pairing and credential storage;
- map normalized inbound/outbound contract;
- enforce same auth/session rules;
- document unofficial-account risk clearly.

No core changes should be required to add WhatsApp. If WhatsApp implementation requires changes to agent/session semantics, stop and review the abstraction rather than leaking provider behavior into Forge core.

## 24. Mandatory Codex review questions before implementation

Codex should inspect current `main`, not just this document, and report on each item:

1. Is `SendPipeline.send` the correct canonical addressed-turn seam, or is there a lower/higher existing API that preserves all current guards/persistence more cleanly?
2. What is the smallest API change needed to return/capture the final assistant result for remote delivery without scraping the webview or transcript logs?
3. Can `ToolApprovalService` be made multi-sink without changing approval ordering, abort behavior, timer lifecycle or Clanker semantics?
4. Are any existing `post(...)` side effects required for correctness rather than UI only? Remote execution must not accidentally skip them.
5. Does an invisible/unresolved sidebar webview currently break any tool flow besides approval? Identify all `getView()` assumptions.
6. Confirm multiple conversations can run concurrently today and identify backend/slot constraints that are separate from conversation correctness.
7. Confirm the remote queue should be per conversation and that draining it after turn settlement cannot race auto-compaction resume.
8. How should remote input interact with auto-compaction and its automatic continuation chain? A queued user prompt must terminate auto-resume exactly as a sidebar user prompt does.
9. What is the correct way to create/restore a conversation without changing the user's visible active tab? Existing `ConversationTabs.create/restore` currently changes active state; remote behavior may need pure ops or an explicit decision to change the active tab.
10. Identify all session persistence calls required after remote binding/session changes and after remote turns.
11. Determine whether remote transport ownership can be safely enforced using VS Code `globalState`/global storage, or whether a file/lock/registry is needed across extension hosts.
12. Verify Telegram library/API choice against VS Code Node runtime and esbuild packaging before adding a dependency.
13. For WhatsApp, verify current Baileys-equivalent maintenance, license, Node compatibility, linked-device persistence and bundling before implementation.
14. Verify no remote code path can call terminal/Git/filesystem operations outside the existing ToolRegistry/ToolDispatch permission + denylist boundary.
15. Verify `FORGE.md`/`AGENTS.md` injection remains identical for remote native-agent turns.
16. Identify privacy-sensitive state that should not enter workspaceState/session transcripts/logs.
17. Check extension activation/disposal and config reload paths for transport lifecycle leaks.
18. Check whether an extension-host restart while a turn is active can produce a duplicate accepted remote command, and propose the narrowest durable-state rule.
19. Challenge the assumption that both Telegram and WhatsApp should share one `RemoteController`; identify any provider semantic that genuinely requires a core abstraction change.
20. Identify any existing tests/utilities that should be reused instead of creating parallel remote test scaffolding.

Codex should return blockers, architectural corrections and recommended plan edits BEFORE writing implementation code.

## 25. Acceptance criteria

The feature is complete when all of the following are true:

- Remote is disabled by default.
- Telegram can be configured without exposing secrets in YAML/workspace files.
- Only an explicitly authorized owner can control Forge.
- A remote normal message runs through the same `SendPipeline`/`AgentLoop` and tool security path as a sidebar message.
- The bound conversation and model/profile are deterministic.
- `FORGE.md` behavior is unchanged.
- Terminal/Git/filesystem restrictions are unchanged.
- Busy-conversation input cannot corrupt the transcript.
- `/stop` works immediately and does not unload the model.
- Tool approval can be completed from VS Code or the authenticated remote channel without duplicate queues.
- Duplicate inbound provider messages do not execute a task twice.
- Notification failure never reruns a completed task.
- Session and transcript persistence remains correct.
- Existing Forge behavior and tests remain green when remote is disabled.
- Telegram implementation does not require changes to core agent semantics.
- WhatsApp can be added behind the same channel interface without changing agent semantics.
- No Internet-facing Forge HTTP server is introduced.

## 26. Future extensions deliberately deferred

Once V1 proves the architecture:

- explicit `/steer`;
- `/keep` and `/undo`;
- attachments and voice;
- remote model selection;
- richer progress updates;
- web client;
- multiple authorized users with capabilities;
- machine-wide broker/daemon so Forge survives VS Code closing;
- cross-workspace routing;
- official WhatsApp Cloud API adapter if later desired.

These should extend the same RemoteChannel/RemoteForgeHost boundary rather than replace it.
