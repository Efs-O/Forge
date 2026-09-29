# Sidebar: cancel a message sent mid-turn

## Problem

When the user types a text-only message into the sidebar while a turn is running, it becomes a "tell"
(`MID_TURN_TELL_PLAN.md`). The webview shows it as a queued chip that says "Will reach Forge at its next step".
On the host side, the message already sits in `MidTurnInbox`. The chip has no Cancel button. `QueuedPromptRow`
hides it on purpose, because removing the chip would not remove the host copy, and the model would still read
the message. Telegram does have a cancel for its own queue (`/drop`). The sidebar does not.

## Design

The webview's chip id becomes the host tell id, which gives both sides one id to cancel by.

- `SendMsg` gains an optional `tellId`. `usePendingPrompts` sends the chip's id with a tell.
  `routeSidebarPrompt` passes it to `addTell`, and the host uses it instead of a fresh `randomUUID()`.
- `MidTurnInbox.remove(conversationId, id): boolean` is added. It returns true only if the tell was still
  undelivered.
- A new message, `{ type: 'cancelTell', conversationId, tellId }`, goes through
  `SidebarPromptRouter.cancelTell`, which calls `midTurnInbox.remove`.
- The webview removes the chip optimistically. If `remove` returns false, the tell was already drained into the
  turn. The bubble is (or soon will be) on screen through the existing `userPrompt midTurn` post, and the host
  posts an error: "that message had already reached the running turn". So there is no silent lie.
- `QueuedPromptRow` shows Cancel for tells as well.

Races:
- A drain that happens before the click wins, and the user sees the notice.
- A click that happens before the drain wins, and the message never reaches the model.
- A turn that ends first: `takeUndelivered` already moved the tell into the next turn, so `remove` returns false
  and the same notice applies.

## Files

- `src/agent/MidTurnInbox.ts`: add `remove` (~8 lines).
- `src/sidebar/backgroundExitNotice.ts`: thread `tellId` and add `cancelTell` to the router (~10 lines).
- `src/sidebar/sidebarWiring.ts`: wire `addTell`'s id and `removeTell` (~3 lines).
- `src/sidebar/messageBridge.ts`: add `tellId` and `CancelTellMsg` (~8 lines).
- `src/sidebar/webviewMessageRouter.ts`, `SidebarProvider.ts`: one action (~6 lines; SidebarProvider is at 494
  lines, so keep it to 2).
- `webview-ui/src/usePendingPrompts.ts` and `QueuedPromptRow.tsx`: send `tellId`, post `cancelTell`, show the
  button.

## Test plan

- `MidTurnInbox.remove`: removes only the named tell, returns false once it has been drained.
- `routeSidebarPrompt`: passes `tellId` through to `addTell`.
- `routeWebviewMessage`: `cancelTell` that returns false posts the "already reached" error.

## Out of scope

- Editing a tell in place.
- Cancelling an attachment prompt. That prompt is local-only and already has Cancel.

## State × lifecycle ledger

No durable state. `MidTurnInbox` is volatile and in-memory, a window reload already drops it, and this change
adds no file, config field or store record.

## Acceptance criteria

- A text message typed mid-turn shows a Cancel button. Clicking it before the next tool-round gap means the
  model never sees the message.
- Clicking after the message was delivered shows an error saying so. The message bubble stays in the transcript.
- Targeted unit tests pass. Full CI runs when the user allows it.
