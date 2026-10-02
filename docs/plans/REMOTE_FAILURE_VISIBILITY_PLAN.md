# Remote Failure Visibility — what a phone is still not told

Status: **#1 shipped in 0.15.33. #2 largely superseded; #4 revised to a silent bubble clock and implementing (2026-10-02); #3 unbuilt.** `src/llm/streamWatchdog.ts` now aborts a stream after 120 s idle once bytes flow (600 s before the first byte), the turn fails, and `failureNotice` sends that to the phone. What #2 would still add: a warning inside the 600 s first-byte window, where silence is usually a legitimate long prefill, so a 60 s warning there risks being the false positive §2 warns about. #3 needs its audit first.
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

## #4 — A liveness clock in the progress bubble (revised 2026-10-02, implementing)

**Problem.** "Is it alive or dead?" from a phone, on an hour-long turn. The
progress bubble has no clock: its only timer is the 1.5 s edit throttle. When
the model goes quiet (a long prefill, a long think) the bubble simply stops
changing, and "busy" looks identical to "stuck" until the stall watchdog gives
up and `failureNotice` sends the failure.

**Rejected shape: a pushed message every N minutes.** Every send buzzes the
phone. Six buzzes an hour that say "nothing is wrong" train the user to ignore
Forge's buzzes, and the ones that matter (turn stopped, latched warnings,
`ask_user`) ride the same channel.

**Shape.** One more line in the existing bubble, refreshed by a silent edit
about once a minute:

```
⏱ 18 min · 24 tool calls · last activity 40 s ago
```

The running tool already appears as the milestone line ("Running run_build…"),
so the clock line does not repeat it.

- **Where.** `RemoteAgentProgress` owns it. `ActiveProgress` gains `startedAt`,
  `lastActivityAt`, `toolCalls` and a `clock` interval. `begin()` sets
  `startedAt = lastActivityAt = now()` and starts the interval; `finish()`,
  `dispose()` and `drop()` clear it, alongside the existing `timer`. The
  interval is not started when the channel has no `editMessage` (the bubble
  cannot be edited, so there is nothing to refresh).
- **Tick.** `CLOCK_INTERVAL_MS = 60_000`, injectable through the constructor
  (like `editIntervalMs`) so tests use fake timers. Each tick calls the existing
  `queueEdit`, so it rides `state.tail`, honours `canDeliver`, and is skipped
  when the rendered text is unchanged. Edits only: the clock **never** calls
  `channel.send`.
- **Activity.** Every event `handle()` receives for a live state, of any kind
  other than `end`, sets `lastActivityAt = now()`, including `commentary`, which
  is otherwise still dropped from the bubble. A `tool` event also increments
  `toolCalls`.
- **Reasoning counts as activity.** Today `ModelTurn.onReasoning` emits no
  progress event at all, so a model thinking for five minutes would read "last
  activity 5 min ago", the false "stuck" this change exists to avoid. Add
  `{ conversationId; kind: 'reasoning' }` (no text: reasoning content must not
  reach any remote surface) to `AgentProgressEvent`, emitted from
  `onReasoning`. `RemoteAgentProgress` treats it as activity only. Every other
  consumer of `AgentProgressEvent` (grep it: `busTurnWatch`, `liveSessionMirror`,
  `turnMirrorWiring`, `remoteHostProgress`, `ForgeHostFacade`, `AgentProgressBus`
  and others) must ignore it, or treat it exactly as it treats `commentary` for
  liveness. Check each one for an exhaustive switch or a fall-through `else`
  that would mis-handle a new kind (the final `else` in
  `RemoteAgentProgress.handle` is one: it would treat the event as a status).
  A first `reasoning` event may open a host-started bubble through
  `HostProgressOpener`, the same as a first token does today. That is
  intended.
- **Format.** Elapsed: `<1 min`, `N min`, then `H h MM min` from 60 minutes on.
  Last activity: `N s` under a minute, `N min` after. Tool calls: `1 tool call`
  or `N tool calls`. Pure functions, unit-tested.
- **Render.** The clock line is the **last** section of `render()`, after the
  milestone. `keepTailWithPrefix` keeps the headline and the tail, so the clock
  survives truncation.
- **The terminal edit** ("Forge: completed." / "Forge: failed.") is unchanged:
  no clock line once the turn is over.

**Out of scope.** No config key (the interval is a constant, like
`DEFAULT_EDIT_INTERVAL_MS`). No pushed "silent for N min" message: add it later
only if the clock proves not enough. No sidebar change.

**Cost.** ~80-120 lines plus tests. `RemoteAgentProgress.ts` is 401 lines; if
the change pushes it near the cap, move the pure formatting and `render` into a
new `src/remote/remoteProgressRender.ts` (a real seam: pure, no state) and add
its `docs/OWNERS.md` row.

### Acceptance criteria

- [ ] With fake timers, a live bubble is re-edited once per `CLOCK_INTERVAL_MS`
  with an updated clock line, and the clock never calls `channel.send`.
- [ ] Elapsed, tool-call and last-activity text match the format above
  (`<1 min`, `N min`, `1 h 05 min`; `1 tool call` / `N tool calls`;
  `N s` / `N min`). Pure-function tests.
- [ ] `tool` events increment the count. `tool`, `commentary`, `narration`,
  `status`, `phase`, `notice` and `reasoning` events all reset last activity.
- [ ] A `reasoning` event never puts text in the bubble and is never sent. Its
  only effect in `RemoteAgentProgress` is the activity reset.
- [ ] `ModelTurn.onReasoning` emits `{ kind: 'reasoning' }`. Every other
  `AgentProgressEvent` consumer was checked and ignores it (or treats it as
  liveness like `commentary`). Tests cover at least `busTurnWatch` and
  `liveSessionMirror`.
- [ ] After `finish()`, `dispose()` or a second `begin()` for the same
  conversation, no further clock edit happens (advance timers well past the
  interval and assert no edit). After `dispose()`, `vi.getTimerCount()` is 0.
- [ ] No clock interval starts when `channel.editMessage` is absent.
- [ ] An unchanged render is not re-sent (existing `lastText` guard).
- [ ] The clock line survives `maxMessageChars` truncation (render test with a
  long milestone).
- [ ] Every new or touched `.ts` file is under 500 lines. `npm run ci` is green
  after the last edit. `CHANGES.md` has a bullet. `docs/OWNERS.md` has a row for
  any new module.
- [ ] Live check (Claude, after review): a Telegram-started turn on a local
  model shows the clock advancing about once a minute, keeps "last activity"
  small while the model thinks, and buzzes nothing new.

### State × lifecycle ledger

No durable state. Everything this adds is in memory: the clock interval
lives on `ActiveProgress` and dies with it (`finish`, `dispose`, `drop`), and
the acceptance criteria above make that cleanup test-enforced. Nothing is
written to disk, config, the outbox or the session log.

## Order

#4 (the clock) now. #2 only if the clock proves not enough in the first-byte window. #3 behind an audit. #1 is done.
