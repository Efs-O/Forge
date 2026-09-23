# Mid-turn messages: Send reaches the running turn

## Problem

While Forge works, the user has three ways to reach it, and none of them is
"tell it something without stopping it":

- **Queue.** Sidebar: `webview-ui/src/App.tsx` holds prompts typed during
  streaming in React state (`queuedPrompts`) and posts them after `done`.
  Telegram: the durable `RemoteRequestStore` queue.
  A correction such as "use the other file" arrives only after the turn has
  finished the wrong thing.
- **Steer.** Sidebar `{type:'steer'}` and Telegram `/steer` both go through
  `interruptForSteering` and then `send`. This throws away the in-flight round
  and restarts, so the user pays a whole turn to add one sentence.
- **Stop.** Ends the turn.

Claude Code accepts a message mid-turn and shows it to the agent at the next
gap between tool calls, without interrupting. The user wants the same in
Forge, with fewer controls: **Send and Stop, nothing else.**

## Design

**Send while a turn runs = "tell".**

- The message is held in a per-conversation inbox.
- At the next gap between tool rounds, it is appended to the transcript as a
  user message, and the next model request sees it.
- If the turn ends before a gap comes, the message runs as the next turn.
  The queue survives only as this internal fallback. It is not a mode the
  user picks.
- **Stop** ends the turn. Undelivered tells go back into the composer, so
  nothing is silently lost or silently run.

### Where the injection happens

In `runToolCallingLoop`, a new option:

```ts
drainTells?: () => ChatMessage[];
```

It is called once per tool round, after `dispatchToolCalls` and
`loopGuard.afterRound`, just before `continue`:

- The drained messages are pushed onto `options.messages`.
- `onMessagesChanged` then fires.
- Nothing else in the loop changes. A turn that ends without a tool round never
  calls it, which is what makes "runs as the next turn" the fallback.

**The gap is the only safe point.**

- Mid-stream: the request is already sent.
- Between a `tool_calls` turn and its tool results: providers reject a
  `tool_call_id` with no answer.

### What the model sees

The message is stored as `{ role: 'user', content: <text>, midTurn: true }`.
The label is added at wire time, in the same place `internal` is handled
before a request is sent (grep `internal` in `src/llm/`), and nowhere else:

> [Sent by the user while you were working. If it changes the task, adjust; otherwise acknowledge it in one line and continue.]

The label is not stored in the transcript. That keeps the webview rendering
exactly what the user typed, and it means the wording can change without
rewriting history.

`midTurn` is a new persisted field on `ChatMessage`:

- It needs a row in the session persistence schema. The strict compaction
  schema taught this: a missing row drops the record on reload.
- It needs a `copy*` passthrough wherever messages are cloned for persistence
  (`sessionPersistence.ts`).

### Owner

`src/agent/MidTurnInbox.ts` (new; add its row to `docs/OWNERS.md`). It is
per-conversation and in memory, with three methods:

- `add(conversationId, { id, text })`
- `drain(conversationId): { id, text }[]` — used by `drainTells`.
- `takeUndelivered(conversationId): { id, text }[]` — used at the end of a
  turn.

Every door (sidebar and Telegram) feeds the model through this one owner.
Telegram items reach `drainTells` through a provider callback (see Phase 3),
not a second inbox.

### Sidebar routing

- The webview keeps posting `{type:'send'}`.
- It no longer queues client-side while streaming.
- The host decides: in `SidebarProvider`'s `send` route, if the conversation
  has a running turn and the message has **no attachments**, it goes to
  `MidTurnInbox.add`. Otherwise it goes to `send.send` as today.
- A message with attachments sent mid-turn waits for the turn to end. Images
  in a mid-turn user message are a later, separate decision.
- Not in `SendPipeline`'s busy check: `RemoteQueueDrain` relies on
  `CONVERSATION_BUSY_ERROR` from there.
- The webview shows the typed text as a pending row at the bottom, marked
  "will reach Forge at its next step". When the session sync brings back the
  `midTurn` message, the pending row is replaced by the real one, at the
  position where it was injected.

### Turn end

`SendPipeline` is the single place every turn settles. After the turn settles:

- **Finished normally or failed:** `takeUndelivered`. If non-empty, run the
  messages as the next turn, joined with blank lines, through the existing
  `send` path.
- **Stopped by the user:** `takeUndelivered`, then post the text back to the
  composer. Reuse the existing prefill message if one fits; grep `prefill` in
  `messageBridge.ts` before adding a type.

### Telegram

- A plain text message while busy is already durably enqueued
  (`request_queued`).
- `drainTells` also claims that conversation's queued, normal-priority,
  text-only requests whose chat `auth.canDeliver`. For each one:
  1. `markRunning`
  2. inject
  3. `onMessagesChanged` (persists the session)
  4. `store.finish(id, 'completed', { notification: 'Seen by the running turn.' })`
- Anything not claimed stays queued, and `RemoteQueueDrain` runs it as the
  next turn exactly as today. The Telegram fallback already exists.
- `/queue` and `/drop` stay.

### Removed in the last phase, only after Qwen passes

- The sidebar steer button, `steerQueuedPrompt`, `steeringConversationIds`,
  and the `steer` webview→host member in `messageBridge.ts`.
- Telegram `/steer` (help text, `parseSteer`, and promotion in
  `RemotePromptAdmission.ts`).
- Telegram keeps its stop command. Verify its name in `remoteHelpText.ts`; if
  there is none, `/stop` is added as an alias of the existing cancel.
- **Kept:** `forge.sh steer` and `priority=steer` in `agentRoutes.ts`. CLI
  agents (Claude, Codex) still need to interrupt each other.
- **Kept:** `AgentLoop.interrupt`. The mesh uses it.

### File-size constraints (real, measured)

These three files are at exactly 500 lines, the eslint hard stop:
`src/agent/ToolCallingLoop.ts`, `webview-ui/src/App.tsx` and
`src/sidebar/messageBridge.ts`.

- **`ToolCallingLoop.ts`:** move `sanitizeText` and `streamOnce` (the
  single-request stream helpers, about 35 lines, a real seam) to
  `src/agent/toolCallingStream.ts` before adding the hook.
- **`App.tsx`:** Phase 1 replaces the enqueue branch (`postPrompt` caller,
  around line 254) rather than adding beside it. Phase 4 deletes the steer
  code.
- **`messageBridge.ts`:** Phase 1 adds no member, because `send` is reused.
  Anything a phase needs must be paid for in the same commit.

## Phases

Each phase ends with `npm run ci` green and one commit on main, staging files
by name.

**Phase 0: template gate (no code).**

- Against the running Qwen llama-server, `POST /apply-template` with:
  `[user, assistant{reasoning_content, tool_calls}, tool, user(tell)]`.
- Record two things:
  1. It renders without error.
  2. Whether the earlier assistant's reasoning survives the new user message.
- Qwen3-family templates drop `reasoning_content` before the last real user
  message unless `preserve_thinking` is on. If the reasoning is dropped, the
  turn loses its thinking and the prefix changes, costing a re-prefill from
  that point.
- Record the result in this file under **Phase 0 result**. If reasoning is
  dropped and cannot be preserved, stop and report: the design needs a
  different message shape (for example, the tell appended to the last tool
  result).

## Phase 0 result

The local llama-server was reachable at `127.0.0.1:8091`: `/health` returned
HTTP 200 `{"status":"ok"}` and `/props` reported
`N:\QWEN GGUF\Qwen3.8-27B\Qwen3.8-27B-UD-Q4_K_XL.gguf`, a Qwen3.8-27B Q4_K
model. Its template advertises `supports_preserve_reasoning: true`.

`POST /apply-template` rendered the required sequence successfully:

```text
[user, assistant{reasoning_content=EARLIER_REASONING_SENTINEL, tool_calls}, tool, user(tell)]
```

With the server's default template kwargs, the output contained the earlier
reasoning. An explicit `chat_template_kwargs: { preserve_thinking: true }`
also preserved it; `preserve_thinking: false` removed it. Therefore this live
Qwen template does not reproduce the plan's warning that the default drops the
reasoning, and the message shape is viable. Forge already carries this kwarg
through `SamplingMerge` when configured, and `RequestNormalizer` forwards it
for llama.cpp; the running template's default is currently sufficient.

**Phase 1: host inbox and loop hook, sidebar.**

- The stream-helper split.
- `MidTurnInbox`.
- `drainTells` wiring in `ModelTurn.ts`.
- `midTurn` on `ChatMessage`, with its persistence row and wire-time label.
- `SidebarProvider` routing.
- The webview pending row.
- Turn-end fallback and Stop-returns-to-composer in `SendPipeline`.
- Unit tests:
  - A tool round drains, and the message lands after the tool results.
  - A no-tool turn does not drain.
  - `takeUndelivered` after a normal end, and after a stop.
  - The `midTurn` persistence round trip.
- The old queue list stays, for attachment-carrying messages only.

**Phase 2: Qwen validation (driven live, not unit-testable).**

In a real sidebar turn on the local Qwen, send a tell during a long tool
sequence, in four cases:

- (a) an addition: "also update CHANGES.md".
- (b) an irrelevant note: "fyi I'll be away".
- (c) a contradiction: "don't touch X, do Y instead".
- (d) a tell while `ask_user` is waiting.

Pass means all of:

- It acknowledges or acts in the next round.
- It does not restart the task.
- It does not treat (b) as a new task.
- For (c), it stops the old direction.
- llama-server's log shows the round after injection reusing the cached
  prefix. Tokens evaluated should be roughly the new tail, not the whole
  context.

Record the results here under **Phase 2 result**. **If it fails, revert
Phase 1 and stop:** the queue and steer stay.

## Phase 2 result

Run 2026-09-23. Model: Qwopus3.8-27B-Flash-V2 (MTP Q5_K_M), llama.cpp b11095,
131K ctx. Build 0.16.37. Session `0f5ea2e1`. The task was the Phase 4
inventory below, 53 tool calls in one turn. Tells were sent from Telegram.

| Case | Tell | Row | Verdict |
|---|---|---|---|
| (a) addition | "also update CHANGES.md" | 95 | **Pass.** It acknowledged the tell in the next round, kept searching and listed CHANGES.md as a Phase 4 follow-up. It did not restart. |
| (d) during `ask_user` | "quick note: keep the table short" | 108 | **Pass, with a design note.** The tell became the `ask_user` answer through the existing remote routing. The model saw that no filename had been chosen, took the default and kept the table short. The user's real answer then arrived as a tell (row 115), and the model acknowledged it. |
| (b) irrelevant | "fyi I'll be away for a bit" | 122 | **Pass.** Not treated as a task. |
| (c) contradiction | "don't create a new file — put it in MID_TURN_TELL_PLAN.md instead" | 123 | **Pass.** It dropped the earlier filename decision, appended the inventory here and deleted `docs/mid-turn-phase4-inventory.md`. |

Behaviour passes on all four cases. **Prefix reuse failed, and the cause was
Forge's, not the template's.**

The rounds after each injection re-evaluated:

- 45815 tokens (51 s) after (a);
- 3770 after row 115;
- 909 after (b) and (c).

An ordinary round re-evaluates about 1000.

`/apply-template` on the running server shows the template is not the cause:
it keeps the earlier reasoning after a tell, and the rendered prompt diverges
only at the tail. The cause is `injectTurnContext` (`src/sidebar/turnContext.ts`),
which folds the turn-context block into the *last* user message. A tell is a
user message, so the block moved off the request that opened the turn, and
llama-server re-evaluated everything from that request onward. Each later tell
moved it again, at a smaller cost.

**Fixed** in the same commit as this result: the fold target skips `midTurn`
messages. A regression test in `test/unit/promptPrefixStability.test.ts` fails
without the fix.

Not explained: one later round, with no tell, re-evaluated from about 31K
tokens (llama-server `f_keep = 0.627`). Watch for it in the Phase 4 run.

Design notes for Phase 4:

- **During `ask_user`, a tell and an answer look the same.** Telegram text
  sent while `ask_user` waits is taken as the answer. The model coped, but the
  user cannot choose which one they are sending.
- **Telegram's reply is still the old wording:** "queued at position 1 … Send
  /steer 1". It tells the user to steer a message that will arrive mid-turn
  anyway. Phase 4 replaces it.

**Phase 3: Telegram.**

- `drainTells` claims queued remote requests as described above.
- A unit test with a fake store:
  - The claimed item finishes as `completed` after injection.
  - An attachment item is left queued.
  - An item from a chat that `canDeliver` refuses is left queued.

**Phase 4: remove steer and the queue UI.**

- Remove the pieces listed under "Removed in the last phase".
- Remove the `QueuedPromptRow` steer action.
- Remove the list itself once attachments are the only thing it holds. It
  then becomes a single pending row that reads "sends when this turn ends".
- Update `remoteHelpText.ts`, `CHANGES.md` and `docs/OWNERS.md`.

## Implementation notes

- The current `SendPipeline` is the single settle point. Undelivered tells are
  taken immediately after its `runTurn` cleanup/persistence block, before
  post-turn continuation or compaction evaluation. Normal and failed outcomes
  run the joined tells through the existing chain; cancelled/interrupted
  outcomes use the existing `setInput` prefill message.
- The current sidebar queue is shared by attachment prompts and pending tells,
  so Phase 1 marks text-only entries with an internal `tell` flag. Attachment
  entries retain the existing queue/Steer/Cancel behavior. The webview now
  renders Send alongside Stop while a turn runs; the plan's old composer hint
  and text-only queue path were therefore replaced.
- `internal` is stripped in `OpenAIClient.toWireMessage`, while Ollama has a
  separate native serializer. The wire-time tell label is owned by the shared
  OpenAI wire helper and used by both serializers; `midTurn` is omitted from
  both payloads and never added to stored content.
- The inbox is constructed in `sidebarWiring`; `AgentLoop` exposes a setter so
  the already-built turn services can hand its drain callback to `ModelTurn`.
  This keeps one per-conversation inbox without adding another message-bridge
  variant or a second send path.
- Sidebar Send admission checks `RequestChainLifecycle.isReserved`, not only
  provider streaming, so tells remain routable while post-turn evaluation or
  auto-compaction is still running. `SendPipeline` drains after evaluation and
  again after the reservation releases; a tell that missed the tool-round gap
  becomes a new addressed send, while stopped/failed chains return it to the
  conversation's composer. The fallback echoes `userPrompt` and includes the
  conversation id on `setInput`, so the webview clears only that conversation's
  pending tell rows.
- The webview queue and tell reconciliation now live in
  `webview-ui/src/usePendingPrompts.ts`, with its ownership recorded in
  `docs/OWNERS.md`. This keeps the restored App comments beside the host-message
  bridge and leaves attachment prompts and steering on their existing path.

### Phase 3 notes

- **One composer, two doors.** `MidTurnTellDrain` (new, `src/agent/MidTurnTellDrain.ts`)
  composes the sidebar inbox and the remote queue into a single drain at each
  tool-round gap. The sidebar inbox registers first (`'sidebar'`), so its tells
  drain ahead of any remote claim; the remote source registers in `extension.ts`
  (`'remote'`) once the `RemoteRuntime`'s store and auth exist. This keeps the
  plan's "single owner of the sidebar tells" rule — `MidTurnInbox` is unchanged
  and still owns the sidebar tells — while letting the remote queue feed the
  running turn through a provider callback into the existing drain, not a
  second inbox.
- **`drainTells` is now async and returns `{ messages, settle? }`.** The loop
  pushes the messages, calls `onMessagesChanged` (persist), and only then runs
  `settle`. The remote transport uses `settle` to finish the claimed request
  `completed` once the injected message is durable; the sidebar tells carry no
  settle. If the persist throws, `settle` is never reached, so the record stays
  `running` and the store's restart recovery handles it.
- **The claim is atomic against `RemoteQueueDrain`.** `claimMidTurnTell`
  (new, `RemoteRequestStore`) re-checks that the record is still `queued` inside
  the store's serialized mutation, so a request the drain already took is
  skipped rather than double-injected. The draft helper
  `claimMidTurnTellInDraft` (new, `remoteQueueOrdering.ts`) deliberately does
  not stop at a running conversation — the tell is injected into the turn that
  is already running, so the drain's guard would reject every claim.
- **Claim rules (new, `src/remote/RemoteMidTurnTells.ts`).** The claim walks the
  conversation's queued requests in `compareQueuedRequests` order and claims
  **every** one that is normal-priority (not `steer`), text-only (no
  attachments), and whose chat `canDeliver` — so three quick Telegram messages
  reach the running turn in one tool round, not three. Anything else is left
  `queued` for the next turn, as today. The returned `settle` finishes each
  claimed record, in order. `RemoteRuntime.claimMidTurnTell` keeps `store` and
  `auth` private and hands the caller only the claim and its settle step.
- **A failing source cannot be silenced.** The loop runs `settle` unconditionally
  (not only when messages were drained), so a tell source that throws — and
  therefore yields no messages — still rethrows its error from `settle` instead
  of swallowing it. A source that fails mid-drain contributes no messages, but
  the messages an earlier source already drained still reach the turn.
- **Test note.** The loop's "settles after persist" unit test drives a tool
  round (a no-tool turn never reaches the drain branch) and asserts the
  invariant directly — by the time `settle` runs, the injected message is on
  the transcript — rather than hardcoding the exact persist sequence, which
  also includes the loop's own assistant/tool-result persists.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Pending tell in `MidTurnInbox` (memory) | Sidebar Send while that conversation's turn runs, with no attachments | `drain` at a tool-round gap, or `takeUndelivered` when the turn settles | Stop: `takeUndelivered` returns the text to the composer; never dropped silently | In-memory only, so there is no partial write; the webview pending row is not persisted either, which matches today's React queue | Extension host death kills the turn and the inbox together; the text is lost, as it is today; no worse, and documented | At most one turn: every settle path calls `takeUndelivered` |
| Injected `midTurn` user message (session transcript) | `drainTells` push at the gap, then `onMessagesChanged` persists it | Only with its conversation (existing delete) | N/A: it is ordinary history once injected | The existing session-persistence write path; the strict schema must carry a `midTurn` row, or the record is dropped on reload | Persisted before the next model request, so a death after that leaves it in history and the resumed turn sees it | Conversation lifetime; compaction folds it into `userMessages` like any user message |
| Remote request absorbed as a tell (`RemoteRequestStore` record) | Existing `enqueue` (`request_queued`), then `markRunning` when claimed | Existing retention for `completed` records | Chat refused by `auth.canDeliver`, or the message has an attachment: left `queued` and runs as the next turn | Order is markRunning, inject, persist session, finish; a crash between them leaves `running`, which `load()` already converts on restart and reports to the chat; the transcript may hold the message once, and it is never requeued | Same as crash: the existing `running` recovery in `RemoteRequestStore.load()` | Existing store retention; unclaimed items follow the queue's rules |

CI-enforced row: the injected `midTurn` message. `test/unit/sessionTypes.test.ts`
round-trips a message carrying `midTurn: true` through persistence. This is
the cheapest row, and its failure mode is silent.

## Acceptance criteria

- Sending while a sidebar turn runs does not stop it. The text appears as a
  user message at the point after the next tool round, and the model's next
  request contains it with the label.
- The label is never shown in the sidebar and never stored in the transcript.
- A turn that ends without another tool round runs the pending text as the
  next turn. Stop puts it back in the composer instead.
- A message with attachments sent mid-turn runs as the next turn.
- A Telegram text message sent while busy reaches the running turn at its
  next gap, and the chat is told it was seen. Attachments and unauthorised
  chats still queue.
- Phase 0 and Phase 2 results are recorded in this file. Phase 4 lands only
  if Phase 2 passed.
- After Phase 4: no steer button, no `steer` webview message and no Telegram
  `/steer`. `forge.sh steer` still interrupts a CLI agent.
- No source file exceeds 500 lines. `npm run ci` is green after every phase.

## Phase 4 inventory: removing steer and the queue UI

Read-only research for Phase 4. No source changed. Each row: what it is, where
it lives, what calls it, and the tests that cover it.

### Items to remove

| Item | File(s) | Lines | What it does | Called by | Tests |
|---|---|---|---|---|---|
| `SteerMsg` webview→host member | `src/sidebar/messageBridge.ts` | 410–414, 479 | The `{type:'steer'}` message type and its slot in the `WebviewToHost` union | `webviewMessageRouter.ts` `case 'steer'`; `usePendingPrompts.ts` posts it | — |
| `steer` route in the router | `src/sidebar/webviewMessageRouter.ts` | 28–30, 77–79 | `actions.steer` callback + the `case 'steer'` dispatch | `SidebarProvider.handleMessage` supplies `actions.steer` | — |
| `steer` action + `interruptForSteering` | `src/sidebar/SidebarProvider.ts` | 425–428, 456–461 | `interruptForSteering` marks the chain cancelling and interrupts; the `steer` action calls it then `send.send` | Router `case 'steer'` | — |
| `steerQueuedPrompt` hook | `webview-ui/src/usePendingPrompts.ts` | 27, 112–129 | Finds the queued prompt, dispatches `USER_SEND`, posts `{type:'steer'}` | `App.tsx` → `TranscriptPanes` → `MessageList` → `QueuedPromptRow` `onSteer` | — |
| `steeringConversationIds` ref | `webview-ui/src/usePendingPrompts.ts` | 42, 99, 118, 141–148 | Tracks which conversations are mid-steer; gates the flush effect; `clearSteering`/`isSteering` | `usePendingPrompts` internal | — |
| `QueuedPromptRow` steer action | `webview-ui/src/components/QueuedPromptRow.tsx` | 8, 17, 33–36 | `onSteer` prop + the **Steer** button (hidden for `tell` rows) | `MessageList.tsx` passes `onSteer` | `test/webview/QueuedPromptRow.dom.test.ts` (asserts `['Steer','Cancel']` buttons) |
| `onSteerQueuedPrompt` prop chain | `webview-ui/src/App.tsx`, `TranscriptPanes.tsx`, `MessageList.tsx` | App 74, 386; TranscriptPanes 12, 38; MessageList 58, 89 | Threads the steer callback down to the row | `App.tsx` wires `steerQueuedPrompt` | — |
| Telegram `/steer` parser | `src/remote/RemotePromptAdmission.ts` | 44–66 | `parseSteerCommand` recognises `/steer <n-or-prompt>` | `admitRemoteText` (line 190); `isRemoteCommand` (line 71) | `test/unit/RemoteCommandCleanup.test.ts:361`, `RemoteHeldPrompt.test.ts:208`, `RemoteCore.test.ts:100`, `RemoteMidTurnTells.test.ts:130`, `RemoteRichText.test.ts:101` |
| `/steer` promotion + priority | `src/remote/RemotePromptAdmission.ts` | 186–260 | `admitRemoteText` routes `/steer`; `promoteQueuedPrompt` runs a queued prompt now; `admitRemotePrompt` sets `priority:'steer'` and interrupts | `admitRemoteText` → `promoteQueuedPrompt` / `admitRemotePrompt` | `RemoteCore.test.ts:100`, `RemoteMidTurnTells.test.ts:130` |
| `/steer` help text | `src/remote/remoteHelpText.ts` | 28, 44 | The `Queue:` line lists `/steer`; the note explains it is the only way to cut a turn | `/help` command | `RemoteRichText.test.ts:101,116` (asserts `/steer` is implemented) |

### Items to keep (do NOT remove)

| Item | File | Why it stays |
|---|---|---|
| `forge.sh steer` + `priority=steer` | `src/agentMesh/agentRoutes.ts` | CLI agents (Claude, Codex) still interrupt each other |
| `AgentLoop.interrupt` | `src/agent/AgentLoop.ts` | The mesh uses it |
| `AgentMesh` steer verb | `src/agentMesh/meshCommands.ts`, `meshOrchestrator.ts` | Bus steer, separate from remote `/steer` |
| `AgentInbox` steer | `src/agentMesh/agentInbox.ts` | Bus queue priority, separate concern |

### Risks Phase 4 could break (not in the plan)

1. **`isRemoteCommand` depends on `parseSteerCommand`.** Removing
   `parseSteerCommand` without updating `isRemoteCommand` (line 71) would make
   `/steer` text fall through to the command handler and be rejected.
2. **`RemoteMidTurnTells` claim rules skip `priority === 'steer'`.** The Phase 3
   drain (`RemoteMidTurnTells.ts`) deliberately skips steer-priority requests.
   After Phase 4 no new steer-priority requests are created, but existing queued
   steer records (from before the removal) would still be skipped by the drain
   and run as the next turn — a behaviour change worth a test.
3. **`RemoteRichText.test.ts` asserts `/steer` is in the implemented set.**
   Removing `/steer` from `remoteHelpText.ts` without updating this test will
   fail CI.
4. **`QueuedPromptRow.dom.test.ts` asserts `['Steer','Cancel']` buttons.**
   Removing the Steer button without updating this test will fail CI.
5. **`steeringConversationIds` gates the flush effect.** The flush effect
   (line 97–99) skips flushing when a conversation is steering. Removing the ref
   without removing the guard would let attachment prompts flush during a steer
   interrupt — a race the ref was protecting against.
6. **`CHANGES.md` and `docs/OWNERS.md` need updating** (already in the plan's
   Phase 4 list, but easy to forget).

### Verified risks (1, 2, 5)

**Risk 1 — CONFIRMED.** `src/remote/RemotePromptAdmission.ts:70-71`:

```ts
export function isRemoteCommand(text: string): boolean {
  return text.trim().startsWith('/') && !parseSteerCommand(text).matched;
}
```

`isRemoteCommand` calls `parseSteerCommand` directly. Removing the parser
without a replacement breaks this function — `/steer`-prefixed text would no
longer be excluded from the command path.

**Risk 2 — CONFIRMED.** `src/remote/RemoteMidTurnTells.ts` (claim loop):

```ts
for (const candidate of candidates) {
  if (candidate.priority === 'steer') continue;
  if (candidate.attachments?.length) continue;
  if (!(await canDeliver(candidate.channel, candidate.chatId))) continue;
```

The drain skips `priority === 'steer'`. After Phase 4 no new steer records are
created, but any steer record already queued before the removal is still skipped
here and runs as the next turn instead of being injected mid-turn.

**Risk 5 — CONFIRMED.** `webview-ui/src/usePendingPrompts.ts:94-100`:

```ts
useEffect(() => {
  const nextIndex = queuedPrompts.findIndex(
    (prompt) =>
      !prompt.tell &&
      !streamingIds.has(prompt.conversationId) &&
      !steeringConversationIds.current.has(prompt.conversationId),
  );
```

The flush effect reads `steeringConversationIds.current`. Removing the ref
without removing this guard reintroduces the flush-during-steer race the ref
was protecting against.
