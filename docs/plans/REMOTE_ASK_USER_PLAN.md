# Remote ask_user Plan

Status: proposed — 2026-08-31

## Problem

`ask_user` talks straight to `vscode.window` (`uxTools.ts:66-80`). It has no
idea whether the turn it serves came from the sidebar or from Telegram, so a
remote turn raises an input box on a desktop nobody is looking at.

Before `ignoreFocusOut` was added, that box blur-dismissed within moments and
returned a cancellation, so a remote turn limped on with an unanswered
question. With `ignoreFocusOut` it now stays open indefinitely: the remote
turn blocks until someone at the machine answers or presses Escape. The
local fix made the remote path strictly worse, and `ask_user` has never
actually worked remotely.

## Design

`ask_user` stops owning presentation. A transport-neutral service owns the
question; the local input box and the remote chat both race to answer it.
This mirrors `RemoteApprovalBridge`, which already does exactly this for the
approval queue (`RemoteApprovalBridge.ts:89-99`).

### 1. `src/sidebar/UserQuestionService.ts` (new owner)

```ts
ask(request: { prompt; placeholder?; options?; conversationId?; signal? }): Promise<string | undefined>
answer(id, text): boolean
cancel(id): void
addSink(sink: { asked(event); answered(event) }): { dispose() }
```

The service raises the local prompt itself, so `ask_user` stays thin. It uses
`window.createInputBox()` / `createQuickPick()` rather than the `showInputBox`
convenience wrapper, because those can be **hidden programmatically** — when a
remote answer wins the race, the stale desktop box must disappear rather than
linger over an already-answered question.

Resolution is first-writer-wins and idempotent: local accept, local Escape (a
deliberate cancel by the person at the machine), remote reply, or an aborted
turn via `signal`. Every path hides the box and emits `answered` exactly once.

`ignoreFocusOut` stays on. It is right for the local case and now harmless for
the remote one, since a remote answer closes the box.

### 2. `src/remote/RemoteQuestionBridge.ts` (new)

Mirrors `RemoteApprovalBridge`. On `asked`, resolve `conversationId` to a
remote request chain and its chat exactly as the approval bridge does
(`RemoteApprovalBridge.ts:90-97`), then send the prompt — numbering `options`
when present. Records the pending question against that chat.

A question with no remote chain is local-only: the bridge stays silent and the
desktop box is the sole surface. Delivery is gated on `auth.canDeliver`, so an
expired session cannot leak a question to Telegram.

### 3. Routing the reply (`RemoteController.handle`)

A free-text answer cannot arrive as a callback button the way an approval
does, so the next text message in that chat is the answer. When a question is
outstanding for the chat, a non-`/` text routes to
`RemoteQuestionBridge.answerText()` instead of `admitRemotePrompt`.

Placement: after the auth gate and the rate limiter, before prompt admission.
`/`-prefixed commands still run as commands, so `/status` and `/lock` keep
working while a question waits — otherwise a pending question would strand the
chat with no way out.

When `options` were supplied, a bare index (`2`) selects that option; anything
else is passed through verbatim.

### 4. Wiring

`ForgeHostFacade` gains `addQuestionSink` and `answerQuestion`, alongside the
existing `addApprovalSink` / `resolveApproval` (`ForgeHostFacade.ts:41-42`).
`SidebarProvider` supplies them from the service. `RemoteController`
constructs the bridge next to `this.approvals` (`RemoteController.ts:72`).
`registerAllTools` passes the service to `makeAskUserTool`.

`ToolHandlerContext` already carries `conversationId`
(`ToolRegistry.ts:33-39`), which is the only new input the tool needs.

## Non-goals

Persisting an unanswered question across a window reload. Approvals do not
survive one either, and a question outlives its turn no better than the turn
outlives the process.

## Verification

Unit tests:

1. Local only (no remote chain) — box answers, nothing sent to the channel.
2. Remote turn — question reaches the chat; the next text answers it; the tool
   returns that text; the local box is hidden.
3. Remote answer wins a race against an open local box, and the reverse.
4. A `/command` during a pending question runs as a command, not an answer.
5. Numeric selection against `options`.
6. Abort signal cancels a pending question and hides the box.
7. An expired session is not sent the question.
8. Double answer resolves once.

Then `npm run ci` and `npm run package`.
