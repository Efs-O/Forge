# Telegram live bubble

**Status:** implemented 2026-10-06 (after 0.16.88).
**Supersedes:** the words draft and standalone status bubble of
`TELEGRAM_STATUS_BUBBLE_RESTORE_PLAN.md`.

## Problem (live report, 2026-10-06)

1. **Stale stream buffer.** After a bubble was finalized, the next bubble
   briefly streamed the previous block's text ("Let me get t…") before turning
   into the real message. The streamed-text buffer and the draft target were
   reset separately, so a throttled update composed for the old block could
   render into the new one.
2. **Stranded status card.** Telegram never moves a message, so the separate
   status bubble (and its ⏹ Stop) stayed above every bubble sent after it.

## Design

`src/remote/RemoteLiveBubble.ts` owns a turn's bubbles; `RemoteAgentProgress`
routes events into it.

- One bubble per text block. A tool call or a narration ends the block; the
  next word starts a new bubble. The new bubble is created only by that first
  word.
- Each block is a new bubble **object**. A send renders its text and reads its
  message id from the same object, so an update composed for the old bubble can
  only land on the old message — there is no shared buffer to inherit.
- The newest bubble reads `words\n\n⏳ <status> · <elapsed> · <n> tool calls ·
  last activity <x> ago` with the ⏹ Stop keyboard. When a new bubble starts,
  the old one is edited to its words alone (no `reply_markup`, so the keyboard
  goes). With no words yet the bubble holds the footer alone; a status-only
  bubble that loses the footer is deleted.
- A warning or image sent mid-turn first flushes the bubble, then the footer
  moves to a fresh bubble below it.
- Edits coalesce at 1 s per chat. "message is not modified" is treated as
  success. A 429 is not retried in place (`retryRateLimit: false`); the bubble
  waits `retry_after` and renders the **latest** state.
- Words split into a new bubble before words + footer would pass the message
  limit; the footer moves along.
- At finish every footer and keyboard is removed. An unfinished streaming block
  is the final answer, which arrives as its own message, so its bubbles are
  deleted and the last bubble becomes the terminal line (armed for deletion).

## Limits

- Stop on an older bubble is gone; `/stop` and the newest bubble's Stop work.
- Removed with the draft lane, since nothing produced them any more:
  `TelegramRichDrafts` (`sendRichMessageDraft`), `RemoteDraftRegistry`, and
  the `generation_stopped` inbound event (Telegram's native draft Stop; the
  bot no longer asks for `stopped_message_generation`). The status-bubble
  opener moved to `src/remote/remoteProgressOpen.ts`.
- A repeated Stop tap is not deduplicated; it calls `cancel` again, which is a
  no-op on a turn already cancelling.

## State × lifecycle ledger

No durable state. Bubbles, their ids and the footer live only in memory for the
turn and are forgotten on finish, dispose and replacement. A Stop button left
by a failed terminal edit resolves to no live turn and does nothing.

## Acceptance criteria

- [x] No bubble ever shows a previous block's words, including through an edit
      in flight at the boundary (`RemoteLiveBubble.test.ts`).
- [x] Only the newest bubble carries the footer and Stop; Stop resolves from
      every bubble id, including after the footer moves (`RemoteLiveBubble`,
      `HostProgressOpener`, `RemoteStopButton`).
- [x] Finished bubbles keep no footer or keyboard after close.
- [x] A 429 re-sends the newest text, not the refused snapshot.
- [x] Every message stays within the limit when a block splits.
- [x] Words before an image or warning appear above it
      (`RemoteImageDelivery`, `RemoteAgentProgress`).
