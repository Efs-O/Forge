# ask_live_session notify_on_answer: ask, end the turn, get woken by the answer

Status: draft 2026-09-29; implemented in the same session.

## Problem

`ask_live_session` blocks the agent's round until the other session answers or
`wait_minutes` (max 20) runs out (`liveSessionTool.ts`, `waitForReply`). In the
`a14e9b9b` session the local agent reasoned "the Claude ask is long-blocking
(15 min)… I can't do other work" and delayed the user's request to avoid it.
`tell_live_session` is the non-blocking primitive but by design carries no
reply, so there is no way to ask something and keep working.

`exec_command` solved the same shape with `notify_on_exit`
(`BACKGROUND_EXIT_NOTIFY_PLAN.md`): the job outlives the turn and the chat is
woken when it finishes. This plan reuses that delivery path.

## Design

One new optional boolean on the existing tool, `notify_on_answer` (default
false; behaviour unchanged when absent). No new tool.

1. With `notify_on_answer: true` the handler does everything up to and including
   delivery exactly as today, then returns at once with an acknowledgement
   naming the question id. It requires a conversation id (rejected otherwise,
   like `notify_on_exit`).
2. The wait for the answer moves into `LiveAnswerNotices.defer`
   (`src/agentBus/liveAnswerNotices.ts`): the same `settle` closure the blocking
   path awaits, run detached with its own `AbortController`. The turn's abort
   signal (`/stop`) does **not** cancel it: the question was already delivered.
3. When `settle` resolves, the notice goes to the single registered listener,
   which the sidebar prompt router (`createSidebarPromptRouter`) subscribes with
   its existing `route`: reserved chat -> `MidTurnInbox`, idle chat -> addressed
   `send`. Text is prefixed `[Forge notice — not a message from the user]` and
   says the body is another agent's reply, not instructions.
4. Observed (Forge-owned) sessions have no natural timeout, so the detached run
   is aborted after `wait_minutes` and reports "No answer within N min". The
   file-bus path keeps `waitForReply`'s own timeout and the existing orphan
   path.
5. At most `MAX_PENDING_LIVE_ASKS` (4) are pending; a fifth is rejected with a
   message. With no listener registered the call is rejected up front rather
   than accepting a question whose answer has nowhere to go.

## Out of scope

- Surviving a window reload (see ledger).
- Changing the blocking default or `tell_live_session`.
- Telegram-specific formatting: a woken turn is an ordinary turn.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Pending entry + AbortController (memory, `LiveAnswerNotices.pending`) | `defer()` after the question was delivered | On settle, timeout, or `dispose()` | `/stop` does not cancel it; `agent_bus.enabled` off only stops new asks | In-memory, no partial write | Host death loses it; no notice; the answer is not delivered as a notice | Observed path: aborted after `wait_minutes`; bus path: `waitForReply` timeout |
| Question file `inbox/<id>.md` (existing, on disk) | `writeQuestion` before delivery | `clearExchange` on answer; `withdrawQuestion` on timeout | Unchanged | Atomic write via `.tmp` + rename (existing) | Survives; swept by `sweepStale` at TTL | `TTL_MS` sweep (existing) |
| Reply file `outbox/<id>-reply.md` (existing, on disk) | The other session | `clearExchange` after the notice is built; `takeOrphans` if the question was withdrawn | Unchanged | `.tmp` + rename (existing) | After a reload the reply waits; once the question is swept it is announced by the next `ask_live_session` as a late answer | `TTL_MS` sweep (existing) |
| Notice in `MidTurnInbox` / woken turn (existing paths) | Router delivery | Existing drain / conversation lifetime | Existing `takeUndelivered` | Existing | Lost with the host, like any tell | Existing |
| Target conversation no longer open | — | Notice dropped, one log line, never routed to the active tab | — | — | — | — |

**CI-enforced row:** the first. A unit test proves a deferred answer notifies
exactly once, never after `dispose()`, reports a timeout once, cannot exceed
`MAX_PENDING_LIVE_ASKS`, and that `defer` refuses with no listener.

## Tests

- `LiveAnswerNotices`: the CI row above, plus a `settle` that rejects turns into
  a failure notice instead of an unhandled rejection.
- `ask_live_session`: `notify_on_answer` returns immediately with the id,
  rejects without a conversation, delivers the answer through the listener;
  the default path is byte-identical to before.
- Delivery: closed conversation is dropped with a log line and no route call.

## Acceptance criteria

- `npm run ci` passes.
- Live check on the installed build: Qwen asks the live Claude session with
  `notify_on_answer: true`, keeps working, and the answer arrives as a new turn
  in the same chat without stealing sidebar focus.
- Without the flag, behaviour and the tool result text are unchanged.
