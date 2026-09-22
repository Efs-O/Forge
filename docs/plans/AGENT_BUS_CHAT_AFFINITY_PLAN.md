# Agent-bus chat affinity and titles

## Problem

Observed 2026-09-22 during the 0.16.34 release run.

1. **A bus message without `--new` lands in whichever tab is active**
   (`agentMessagingSetup.ts` submit → `status().activeConversationId`). After a
   window reload, a tab switch, or a `--new` from another sender, "active" is not
   the chat the sender was talking in, so its follow-up opens a new thread of
   work somewhere else. Codex had been told "same chat, no `--new`" and could
   not guarantee it — the choice was never the sender's to make.
2. **`isBusy` checks the active chat too**, so a message for chat A waits on a
   turn in chat B (or runs over a turn in A while B is idle).
3. **Every chat a bus message starts is titled `**codex says:**`** — the title is
   the first line, which is the sender header. Two such tabs are
   indistinguishable (the user read two old chats as one new one).

## Design

- New pure `busTargetConversation(from, status, exchanges)` in
  `src/agentBus/busTarget.ts`: the most recently updated **open** (not
  archived) conversation holding a prompt from `from`
  (`parseForgeInboundPrompt`, case-insensitive); else the active one.
  Derived from the conversations themselves on every call — nothing new is
  stored, so it survives a reload by construction. Closing a tab (archiving)
  is the user's signal to stop routing there.
- `AgentInbox` passes the queued message's `from` in the options it hands
  `isBusy` / `submit` (`InboxMessageOptions.from`).
- `agentMessagingSetup.ts`: `isBusy` and `submit` both use the target. Submit
  activates it (`restoreConversation(id, {activate:true})`, a no-op switch for
  an open tab) so the user sees the turn it starts. `--new` is unchanged.
- `transcriptMutations.appendUserPrompt`: a bus prompt is titled
  `<from>: <first line of its text>`.

## State × lifecycle ledger

No durable state: the target is recomputed from the already-persisted
conversations on each message, and the title uses the existing `title` field.

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| none (derived routing) | computed per message | nothing to delete | `agent_bus.enabled: false` → routes 404, nothing computed | nothing written | recomputed next activation from restored tabs | none |

CI-enforced row: `busTarget.test.ts` asserts the target follows the sender
across a changed active tab, skips archived conversations, and falls back to
the active one.

## Acceptance criteria

- A `say codex` without `--new` goes to the latest open chat holding a codex
  message, even when another tab is active, and that tab becomes active.
- With no such chat, it goes to the active chat (previous behaviour).
- A message waits only on its own target chat's turn.
- A chat started by a bus message is titled `codex: <text>`, not `**codex says:**`.
- `npm run ci` and `npm run package` pass.
