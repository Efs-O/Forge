# Telegram draft answer streaming

**Status:** implemented 2026-10-05 (after 0.16.86; ships in the next release).
**Superseded in part (2026-10-05):** the status is no longer a draft. See
`TELEGRAM_STATUS_BUBBLE_RESTORE_PLAN.md`: the status is a plain edited bubble
again, and only the model's words stream in a draft.
**Follows:** `TELEGRAM_BOT_API_UPGRADE_PLAN.md` Phase 2 (`ed3edf9`), which put the
status bubble into a `sendRichMessageDraft` preview but deliberately left the
model's words out of it ("Actual token-by-token answer streaming requires a
separate design for answer ownership and fanout"). This is that design.

## Problem (live report, 2026-10-05)

After 0.16.86 a Telegram-watched turn showed:

1. `Forge: working…` typed out letter by letter (the client animates every
   draft update) and then nothing else live: the bubble never carried the
   model's text, so there was nothing to stream.
2. Narrations arriving late and in a burst. Draft calls went through
   `TelegramChatQueue`, the same per-chat FIFO as every narration, and
   `postTelegram` honours a 429 by sleeping up to 60 s, three times. Drafts are
   throttled far harder than messages, so one throttled heartbeat parked every
   narration behind it. `RemoteAgentProgress` also serialized draft updates and
   narrations on the same `state.tail`, which doubled the coupling.
3. The draft vanishing mid-turn: a heartbeat stuck in that queue misses the
   ~30 s preview window and Telegram retires the preview.

## Design

**The draft streams the words, the existing paths own the record.** The
`commentary` event (token deltas, `ModelTurn.onToken` / `CliTurn`) is appended
to a per-turn buffer and shown in the draft. Nothing about answer delivery
changes:

- A round that ends in tool calls emits `narration`; `RemoteAgentProgress`
  sends it as its own message exactly as before, and the stream buffer is
  cleared on that event so the draft drops back to status.
- The final answer is still delivered once, by the outbox (`store.finish` →
  notification) for a chat-queued turn and by the mirror fanout for a
  sidebar-started one. `finalizeStatus` still sends a status-only message.

This is why the draft may stream where the old edited bubble could not
(`4dcb826`, "keep streamed words out of the Telegram progress bubble"): an
edited bubble is permanent, so every thought appeared twice. A draft is a
preview Telegram retires on its own, so the text appears once as a record.
The plain edited bubble keeps that rule and still never shows streamed words.

**Draft calls never block a message.**

- `TelegramChannel` sends `sendRichMessageDraft` outside `TelegramChatQueue`
  and without the in-place 429 retry. A draft update is replaceable by the
  next one, so waiting for it is never worth delaying a real message.
- `TelegramRichDrafts` owns the throttle: a 429 on an update records the
  chat's `retry_after` and skips updates for that chat until it passes. The
  skipped update is not lost information, because the next update renders the
  whole state again.
- `RemoteAgentProgress` drives the draft through `RemoteDraftLane`
  (`src/remote/RemoteDraftLane.ts`): one call in flight per turn, latest state
  wins, never chained onto the narration `tail`. `finish` waits for both.
- Stream updates coalesce at `DRAFT_STREAM_INTERVAL_MS` (1 s) instead of the
  1.5 s edit cadence, and the 20 s heartbeat stays.

`sendRichMessage` (the final status) stays in the chat lane: it is a real
message and must keep its order relative to the narrations.

**The preview text is append-only (follow-up, same day).** The first build
sent the full progress render as the draft: headline, then the words, then
`⏱ … last activity N s ago`. Live, the preview never got past `Forge:`.
Telegram re-types a draft from its first changed character, and that clock
line, along with the headline and tool name above the words, changed on every
1 s update, so each update restarted the typing. `renderRemoteDraft` now sends
just the streamed words while the model writes, so each update only appends.
With nothing streaming, it sends a short status with no clock. The clock
remains on the plain bubble and is not needed on a preview.

That fixed the words but left the status re-typing. Each tool replaced the
`Running …` line, and a narration cleared the words. So the draft became one
**append-only log per turn**: the opening headline, then each new milestone
(`Running read_file…`, a status, a notice) and the streamed words, in arrival
order. A narration no longer clears it. Live timing on 2026-10-05 showed every
inbound message admitted within 1 s of its Telegram timestamp. The
multi-minute lag the user saw was model time on a 140K-token context, plus a
plain-text "Stop" (no slash) being queued as a prompt.

## Limits

- `MAX_STREAM_CHARS` (3,000) bounds the log. When it fills up, the log starts
  over from the newest entry: one short re-type. Dropping the head instead
  would re-type the whole text on every update. The full text is always in the
  final message.
- Reasoning tokens never enter the draft (`reasoning` carries no text by
  contract).

## State × lifecycle ledger

No durable state. The stream buffer, the per-turn draft lane and the
per-chat 429 pause live in memory and are dropped with the turn (`finish`,
`drop`, `dispose`) or the window. The draft registry is the existing
`RemoteDraftRegistry`, unchanged. Nothing is written to disk, config, the
remote-state file or the outbox.

## Acceptance criteria

- [x] `commentary` deltas appear in the draft text and stay there after a `narration`.
- [x] A plain (non-draft) bubble still ignores `commentary`.
- [x] A pending draft update does not delay a narration send (test with a
      draft call that never resolves).
- [x] `sendRichMessageDraft` bypasses the chat queue and is not retried on 429;
      a 429 pauses updates for that chat for `retry_after`.
- [x] `finish` waits for an in-flight draft update before finalizing.
- [x] Successive stream updates are prefixes of one another, and a draft never
      carries the ticking clock line.
- [x] `npm run ci` passes.
