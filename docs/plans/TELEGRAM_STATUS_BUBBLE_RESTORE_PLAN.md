# Telegram status bubble restore

**Status:** implemented 2026-10-05 (after 0.16.86).
**Supersedes in part:** `TELEGRAM_DRAFT_ANSWER_STREAMING_PLAN.md` (the status
draft) and `TELEGRAM_BOT_API_UPGRADE_PLAN.md` Phase 2 (status in a
`sendRichMessageDraft` preview).

## Problem (live report, 2026-10-05)

Three attempts to make a draft-backed status bubble feel live all failed:

1. `Forge: working…` crawled. Telegram re-types a draft from its first changed
   character, so every clock tick and tool line re-animated the whole status.
2. Tool-call lines (`Running read_file…`) were appended to the streamed draft,
   so the preview read as a tool log rather than the agent's words.
3. A draft lives about 30 s. The status preview flashed into Telegram's Stop
   button and a finalized status was sent afresh, so messages appeared to
   vanish and reappear around the user's prompts.
4. After a stopped turn the last narration arrived twice: once live, and again
   after `Forge: completed.` from the `finalAnswer` transcript fallback, which
   picked the text of a round that had ended in tool calls.

The user asked for status/report messages not to stream at all, and for the
agent's words to keep streaming ("the streaming of forge messages works
nicely").

## Design

- **Status is the plain bubble again.** `openProgressBubble` only calls
  `sendProgress`; the bubble is edited in place (clock, one "Running tool…"
  line) and deleted a short time after its terminal edit, as before Phase 2.
  `finalizeStatus` (`sendRichMessage`) and the `draftEpoch` dependency on the
  openers are removed.
- **Words-only draft.** `RemoteAgentProgress` opens a separate draft lazily on
  the turn's first `commentary` event. It carries the model's words only,
  append-only, reusing one `draft_id`, through `RemoteDraftLane` (1 s
  coalesce; heartbeat `min(clock, 20 s)` once open). It is registered in
  `RemoteDraftRegistry` so its native Stop cancels the turn, with the epoch
  check against unpair races. Milestones never touch it. On finish it is left
  to expire. An `unsupported`/`unknown` open turns drafts off for that turn;
  the bubble is unaffected.
- **No duplicate after Stop.** `finalAnswer` in `turnMirrorWiring` returns
  nothing when the last assistant message carries `tool_calls`: that round was
  already narrated live, and the turn has no final answer.

## Investigated, not a Forge defect

- **Prompts disappearing.** `remote-audit-v1.json` records every prompt as
  inbound and accepted, with no delete against any. Forge deletes only slash
  commands and their replies (`CommandCleanupScheduler`) and the status bubble
  after its terminal edit. The likely perception was item 3 above.
- **Web-UI prompts on Telegram.** No code has ever mirrored sidebar prompt text;
  only the turn's progress and answer reach the bound chat.

## Limits

- The words draft still expires about 30 s after the model stops talking, with
  Telegram's own animation. The answer always arrives as a normal message.
- Tool names still appear in the plain bubble's single status line.

## State × lifecycle ledger

No durable state. The status bubble and the words draft live only for the
turn; the registry entry is in-memory and forgotten on finish, dispose and
unpair. Nothing is written to disk or config.

## Acceptance criteria

- [x] The status bubble opens with `sendMessage`, never `sendRichMessageDraft`
      (`HostProgressOpener`, `RemoteQueueDrainDraft`, `TelegramChannel` tests).
- [x] Status, clock and tool lines never enter the draft; only commentary does
      (`RemoteAgentProgressDraft`).
- [x] The draft is append-only and reuses one `draft_id`.
- [x] A refused draft turns drafts off for the turn without touching the bubble.
- [x] The draft's native Stop still cancels the turn; an unpair mid-open does
      not register it (`RemoteGenerationStopped`).
- [x] A stopped turn with only narrated tool rounds sends no answer
      (`RemoteOutboundActivity`).
- [ ] Live check on Telegram: the status never animates, words stream, no
      duplicate after Stop.
