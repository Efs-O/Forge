# Remote Failure Visibility — what a phone is still not told

Status: **#1 shipped in 0.15.33. #2, #3, #4 are unbuilt.**
Written 2026-09-10, from the diagnosis of the halluscribe session `3c073ca7`.

## The rule this all follows

Telegram raises a push notification on `sendMessage` and **none** on
`editMessageText`. Forge's remote progress bubble is one message edited in
place for the life of a turn. Therefore: anything a remote user must be *told*
has to go out as a send. An edit is only for state that is genuinely volatile —
the headline and the currently-running tool.

`RemoteAgentProgress.queueOutbound` is the send path. It rides `state.tail`, so
a sent line cannot overtake the bubble edit that preceded it, and it respects
`canDeliver` (session lock) like every other delivery.

## Already covered — do not rebuild

- **A turn that dies outright.** `onTurnFailed` → `RemoteNotificationFanout.failureNotice`
  sends a real message ("Forge: the turn stopped — …") and deliberately ignores
  `/mirror off`. Verified in the outbox: "fetch failed", "the next model request
  cannot fit in this conversation's context".
- **Mid-turn narration** (0.15.33) — each round's text before its tool calls.
- **Latched warnings** (0.15.33, #1) — sent as well as latched in the bubble.
- **Turn liveness figures on demand.** `/status` already reports active
  requests, queued prompts here, streaming conversations, crash-unknown
  requests, pending/abandoned notifications, and the conversation's model
  request count. #4 below is only about *pushing* this, not computing it.
- **The specific silent stop seen in `3c073ca7`.** A round whose whole output
  budget went into thinking returned `finishReason: 'length'` with no content
  and no tool call; `completeAnswer('')` flushed it as a normal completion and
  the loop exited with nothing recorded anywhere. Fixed in **0.15.31** —
  `OUTPUT_BUDGET_EXHAUSTED_NOTICE` now lands in the transcript. If a silent stop
  is seen again on 0.15.31+, it is a *different* bug and this is not the cause.

## #2 — Stall detection from the stream heartbeat

**Problem.** The model stops sending frames and nothing anywhere says so. The
measurement already exists and already fires: `OpenAIClient` logs
`stream heartbeat id=N elapsed_ms=… idle_ms=… reads=… sse_frames=… bytes=…`
every 15s, at WARN once idle passes ~30s. In `3c073ca7` there were minutes of
`sse_frames=0 bytes=3` rows and neither the sidebar nor the phone was told.

**Shape.** Thread a callback from the heartbeat out to `emitAgentProgress` as a
`notice`/`warning`, and a matching `info` when frames resume. The token path
already runs this exact route (`onToken` → `ModelTurn` → `emitAgentProgress`),
so this is following a path, not cutting one. With #1 shipped, a warning notice
already becomes a message for free — that is why #2 got cheaper.

**Cost.** ~100-150 lines across 4-5 files. An afternoon, not a session.

**The hard part is not code.** Choosing the idle threshold. A reasoning model
can legitimately be quiet, but note that reasoning tokens *are* SSE frames — so
`sse_frames=0` really does mean nothing is arriving, which makes the signal
cleaner than it first looks. Start conservative (60s), and make sure the
all-clear fires, or the first false positive teaches you to ignore the warning.

## #3 — Surface individual tool failures

**Problem.** A tool call that fails is invisible everywhere — sidebar included.
`CLAUDE.md`: *"The rendered chat hides tool failures entirely; the transcript
will look fine while a tool fails half its calls."*

**Do the audit first.** `CLAUDE.md` is emphatic that guessing at tool failure
rates is how bad rules get written, and the two rates it used to quote both
turned out to be measuring builds and quants that no longer run. Emitting a
warning per failed tool result is a few lines; knowing whether that produces 2
messages a turn or 40 is the actual work.

**Cost.** A real project with its own measurement phase. Lowest priority
despite being the biggest correctness win.

## #4 — Push a liveness heartbeat

**Problem.** "Is it alive or dead?" from a phone, on an hour-long turn.

**Shape.** A timer per open `ActiveProgress`; every N minutes send
"still working — 18 min, 24 tool calls, currently `run_build`". All of it is
already at hand in the progress state or on `/status`.

**Cost.** ~60-80 lines, self-contained in `RemoteAgentProgress`. An hour.

**Caveat.** The risk is annoyance, not correctness — and `/status` already
answers the same question on demand. Worth doing only if #2 lands and pulling
`/status` still feels like too much work from a phone.

## Order

#2, then #4 if still wanted, then #3 behind an audit. #1 is done.
