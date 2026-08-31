# `notify_user` — agent-initiated message to the chat that started the turn

**Status:** planned, not implemented. Written 2026-08-31.

**Goal:** let the agent send the user a one-way message mid-turn that reaches
whichever surface started the turn — the VS Code window, or the Telegram /
WhatsApp chat it was driven from. Today the agent's only outbound signal is
`show_notification`, a VS Code desktop toast, so a user who walked away from
the machine gets nothing.

**Scope discipline (no complexity):** one new tiny service, one facade method,
one runtime subscription, one tool, one slash command. **Fire-and-forget only.**
No waiting for a reply, no scheduler, no heartbeat, no polling, no wake — an
agent that wants an answer already has `ask_user`, which is bounded by the
session timeout. Nothing in this plan runs when VS Code is closed, and nothing
in it starts a turn on its own.

---

## Why this shape

The whole path already exists and is proven in production for one case:
auto-compaction progress. `CompactionService` emits a `CompactionEvent`
carrying a `conversationId`; `RemoteRuntime` subscribes through the host facade
and routes it to `RemoteController.enqueueHostNotification(conversationId, text)`,
which resolves the conversation to its bound chats and queues to the durable
outbox. We are adding a second producer to that same road.

Existing landmarks (read these before editing):

| Concern | File | Notes |
|---|---|---|
| Host→remote push | `src/remote/RemoteController.ts:159` | `enqueueHostNotification` — conversation → bindings → outbox → `kick()` |
| Runtime subscription pattern | `src/remote/RemoteRuntime.ts:302`, `:405` | `onCompactionEvent` subscribe + `onCompactionEvent()` policy handler |
| Facade seam | `src/sidebar/ForgeHostFacade.ts:73`, `:115`, `:225` | `onCompactionEvent` declared in interface, deps, and impl — mirror all three |
| Transport-neutral tool service | `src/sidebar/UserQuestionService.ts` | the `ask_user` precedent; **read its class doc comment** |
| Tool context carries the id | `src/tools/ToolRegistry.ts:39` | `conversationId?: string` already on `ToolContext` |
| Tool shape to copy | `src/tools/uxTools.ts:40` (`makeAskUserTool`) | note how it passes `context?.conversationId` |
| Delivery gate | `RemoteAuth.canDeliver(channel, chatId)` | an expired session must not be handed content |
| Session command handlers | `src/remote/RemoteSessionCommands.ts` | `/status`, `/stop`, `/queue`, `/drop` live here |
| Native command menu | `src/remote/TelegramChannel.ts:58` | `TELEGRAM_BOT_COMMANDS`, **alphabetical — keep it so** |

`ask_user` is *not* the right thing to extend: it is a request/response with a
pending map and text routing (`RemoteQuestionBridge`). Notification is stateless.
Reusing the question machinery would drag a pending-answer lifecycle into a path
that has no answer.

---

## Design

### 1. `src/sidebar/UserNotificationService.ts` (new, ~45 LOC)

Transport-neutral fan-out, mirroring `UserQuestionService` but with no pending
state. One method:

```ts
export interface UserNotificationEvent {
  conversationId?: string;
  text: string;
}
/** Returns the number of remote chats the message was queued to. */
export type UserNotificationSink = (event: UserNotificationEvent) => Promise<number>;

export class UserNotificationService {
  addSink(sink: UserNotificationSink): { dispose(): void }
  /** Fans out to every sink; resolves to the total chats queued. */
  async notify(event: UserNotificationEvent): Promise<number>
}
```

**The return count is load-bearing, not decoration.** It is what lets the tool
tell the model the truth about whether the message went anywhere. `ask_user`
shipped returning a bare `(cancelled)` that the model read as a real answer, and
it produced a usable result once in sixteen calls across 13 sessions. A
`notify_user` that says "sent" into a void would repeat that exact failure with
a longer fuse — the agent would report "I've notified you" and the user's phone
would stay silent. See the *Agent-Ergonomics Traps* section of `CLAUDE.md`.

A sink that throws must not break the tool: catch per-sink, count 0, and surface
the error through the runtime's existing `notifyLocal` path.

### 2. `RemoteController.enqueueHostNotification` — return a count

Change the signature from `Promise<void>` to `Promise<number>`, returning
`bindings.length` after the loop (0 when nothing is bound). The existing
compaction caller at `RemoteRuntime.ts:416` ignores the value — no behaviour
change there.

### 3. `ForgeHostFacade` — add `onUserNotification`

Mirror `onCompactionEvent` in all three places (interface `:73`, deps `:115`,
impl `:225`). Optional, exactly as compaction is, so tests and any partial host
keep compiling.

### 4. `RemoteRuntime.startTransport` — subscribe

Alongside the existing `compactionSubscription` (`:302`), add a notification
subscription that routes to `controller.enqueueHostNotification(...)` and
returns its count. Dispose it in the same places the compaction subscription is
disposed (`:312`, `:394`) — **check both, they are separate paths.**

Unlike compaction there is **no trigger filter**: every `notify_user` call is
explicitly agent-authored and intended for the user.

> `RemoteRuntime.ts` is 433 lines against a 500 hard stop. This adds ~15. If it
> pushes past, the seam to cut is the two `onXEvent` policy handlers into a
> `RemoteHostEvents.ts` — not an arbitrary split.

### 5. `src/tools/uxTools.ts` — `makeNotifyUserTool` (~40 LOC)

File is 221 lines; this keeps it under the 350 soft threshold.

```
name: notify_user
description: Send the user a short message that reaches whichever surface
             started the turn -- the VS Code window, and the chat it was driven
             from remotely if there is one. Fire-and-forget: it does NOT wait
             for a reply and does NOT pause your work. Use it for something
             worth knowing now that should not stop the task -- a long build
             finishing, or the first real failure in a long sweep. To ask a
             question and wait, use ask_user instead.
params: { message: string }   // required, additionalProperties: false
permission: 'read'
```

Handler:
1. Always raise the local VS Code toast (`vscode.window.showInformationMessage`)
   — the desktop surface must work with remote disabled, and the local user
   should see the same message.
2. `const chats = await notifications.notify({ conversationId: context?.conversationId, text: message })`.
3. Return a **truthful** string:
   - `chats > 0` → `Message delivered to the VS Code window and N remote chat(s).`
   - `chats === 0` → `Shown in the VS Code window only. No remote chat is bound to this conversation, so the user did NOT receive it on their phone. Do not claim you notified them remotely.`

**Per-turn cap.** A tool loop can call this 40 times (`max_tool_rounds`). Cap at
**5 notifications per conversation per turn**; beyond that return
`Notification limit reached for this turn (5). The message was not sent -- put it in your final reply instead.`
Keep the counter in `UserNotificationService`, keyed by conversationId.

**Resolved on the re-read (the plan previously hedged here).** There is no
turn-*end* hook, but there is a turn-*start* one, and it is the better anchor:
`SidebarProviderEvents.onGenerationStarted(modelName, conversationId?)`
(`src/sidebar/providerEvents.ts:9`) fires at the top of every conversation-bearing
turn — `ProviderTurn.ts:106` and `:197`, and `CliTurn.ts:131`. Reset the counter
there, via `notifications.resetTurn(conversationId)`.

Turn-start beats turn-end on three counts: it cannot leak a counter when a turn
throws or is cancelled, it is idempotent, and it needs no new lifecycle concept.
**The 10-minute sliding-reset fallback is dropped — do not implement it.**

The wrapping pattern is already established by `wireSessionTimer`
(`src/sidebar/sessionTimerWiring.ts:41`), which decorates this exact event for
session timing. Mirror it: capture the original, call it after your own work.
`PromptRun.ts:133` fires the event with **no** conversationId (a `/compact`
summary is not a user turn) — skip those, exactly as `wireSessionTimer` does.

### 6. `registerAllTools` — wire it

`src/tools/registerAllTools.ts` takes `questions: UserQuestionService` at `:88`.
Add `notifications: UserNotificationService` beside it and construct the tool.
Instantiate in `src/extension.ts` next to `userQuestions` (`:140`), pass to
`registerAllTools` (`:149`) and into the facade deps (`:236`).

### 7. `/notify on|off|status` — session-scoped mute

Add to `src/remote/RemoteSessionCommands.ts` beside `/stop` and `/queue`, and a
row to `TELEGRAM_BOT_COMMANDS` (`TelegramChannel.ts:58`, alphabetical — it goes
between `/new` and `/queue`).

- **Default: on.** Pairing is already the consent record, and auto-compaction
  notices *already* push to a paired chat unprompted with no toggle. Making
  `notify_user` default-off would be inconsistent with shipped behaviour and
  would make the feature look broken during smoke testing.
- Scope is **per chat** — the recipient is the chat, so the mute belongs where
  the address lives.
- **Resolved on the re-read: the mute is in-memory on `RemoteController`, not
  persisted.** Persisting it would mean adding a field to `BindingSchema`
  (`src/remote/RemoteStoreSchemas.ts:48`) plus a `LegacyBindingSchema` migration
  — a stored-format change for a toggle, against this plan's scope discipline.
  `/clanker on|off` already sets the precedent for an owner-authenticated switch
  that lasts until the window reloads. Say so in the reply text, as `/clanker`
  does, so the lifetime is never a surprise.
- `RemoteCommandContext` (`src/remote/RemoteCommandHandler.ts:8`) carries no
  controller handle, so add a small `notifyMute` accessor pair to the context and
  populate it where the context is built (`RemoteController.ts:279`), beside
  `workspaceAliases`.
- When muted, `enqueueHostNotification` skips that binding; the tool's returned
  count therefore drops, and the model is told honestly it did not reach them.

---

## Explicitly out of scope

- Any wake / resume-after-turn-end. Requires a live process; VS Code closed
  means dead. Decided 2026-08-24 and unchanged.
- Any heartbeat, cron, or polling loop.
- A standalone daemon.
- Read receipts. **The Telegram Bot API does not expose them** — `sendMessage`
  returns a `message_id` meaning Telegram accepted the message, nothing more.
  Do not add a "the user saw it" claim anywhere in the tool's return string.
  (If a real ack is ever wanted, the only honest source is an inline-keyboard
  callback — `TelegramChannel.ts:158`/`:289` already handle that shape.)

---

## Adjacent, deliberately not now: ACP

`notify_user` is Forge reaching **out** from inside the editor. The industry is
converging on the inverse — the agent runs as its own process and projects
**into** the editor over **ACP (Agent Client Protocol)**: an LSP-shaped standard
where the editor is the client and the agent is a subprocess, and chat, tool
activity, file diffs, and terminal output render natively in VS Code, Zed, or
JetBrains. Hermes Agent ships ACP support today; OpenClaw documents ACP agents
as a backend type. That is how they can be always-on *and* still show diffs in
your editor — their brain was never inside it to begin with.

Forge is the opposite shape: brain and UI fused in one extension. That is a real
advantage — language-server tools, per-turn checkpoints with editor decorations,
and the confirmation gate wired to live editor state are all things a protocol
surface does not hand you (Hermes' equivalent is a coarser working-directory
snapshot plus `/rollback`). **Nothing here should be traded away for reach.**

Recorded only as a pointer. Do **not** act on it as part of this plan.

- **Why it might matter later:** ACP is the smaller, standards-track answer to
  "reachable when VS Code is closed" — much less than a bespoke Forge daemon,
  which would create a second writer for `config.yaml`, the session JSONL, the
  llama-server process, and the working tree, against the Single Point of Truth
  rule.
- **What it would cost:** splitting brain from UI, which is the one thing that
  currently makes Forge better than the alternatives. Adopting it is an identity
  decision, not a refactor.
- **What would justify revisiting:** evidence from living with `notify_user`
  that the user genuinely needs Forge reachable with the editor closed. If the
  machine is awake anyway for the GPU, leaving VS Code open costs zero lines and
  gets the same result — check that first.

---

## Tests

- **`UserNotificationService`** unit: fan-out sums counts across sinks; a
  throwing sink counts 0 and does not reject; per-turn cap trips at 6.
- **`RemoteController.enqueueHostNotification`** returns `bindings.length`;
  returns 0 with no bindings; still queues + kicks.
- **`notify_user` handler**: returns the "remote chats" string on `chats > 0`;
  returns the explicit "did NOT receive it on their phone" string on 0; returns
  the cap string on the 6th call.
- **`/notify off`** suppresses delivery to that chat only; a second bound chat
  still receives it, and the returned count reflects the drop.
- **Turn reset**: two calls, a simulated turn start, then a third — the third
  must send, proving the counter cleared. An `onGenerationStarted` with **no**
  conversationId must not reset anything.
- **Inventory counts — three hardcoded numbers must be bumped**
  (`test/unit/RegisterAllTools.test.ts:126` test *name* and `:141` → 61→62;
  `test/unit/ToolHarness.test.ts:69` test *name*, `:80`, `:105` → 63→64).
  Two of them are in test names, which no compiler will catch.

## Ship steps

1. `npm run ci` — type-check, lint, tests, production build.
2. `git status`, stage **by name** — never `git add -A`. The tree was cleaned
   before implementation started (`FORGE.md` committed as `4705f4e`, a stray
   blank line in `src/config/schema.ts` reverted, `report.jpg` deleted), so the
   only expected changes are this plan plus the files below.
3. Commit to `main` (solo repo, direct push, protection bypassed — so CI must be
   green *before* the commit, not after).
4. `npm run package` → VSIX.
5. Hand to user for real-time testing. **A new VSIX needs a full window reload**
   — an exthost auto-restart reloads the old build.

## Smoke test the user should run

1. Pair Telegram, then from the sidebar: *"run `npm run ci` in the background and
   notify me when it finishes."* Walk away. Phone should buzz with the result.
2. `/notify off` in Telegram, repeat — phone silent, VS Code toast still appears,
   and the agent's transcript should say it did **not** reach you remotely.
3. Unpaired/remote-disabled: tool must still work locally and say so honestly.

---

## Decisions (answered by the user, 2026-08-31 — do not re-ask)

1. **`/notify on|off|status` is IN this pass.** Not deferred.
2. **Default is ON** for a paired chat. Pairing is the consent record, and
   auto-compaction notices already push unprompted with no toggle.
3. **Per-turn cap stays 5.** Accepted as a reasonable guess; revisit only if
   real usage shows it is wrong.

## Workflow agreed with the user

Plan written → user compacts → **re-read this plan and check for gaps before
writing code** → implement → `npm run ci` → stage by name → commit to `main` →
`npm run package` (VSIX) → hand to the user for real-time testing.
