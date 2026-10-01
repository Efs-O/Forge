# Live status bar: follow the running chat, show streaming tokens

## Problem

The session status bar (`SessionTimeStatusBar`) reads the chat on screen. A
chat started in the background (`forge.sh say --new`, Telegram, a job) never
appears on it, so the bar looks frozen while that chat works, and stays on the
old chat's numbers after it finishes. Even on the right chat, every token count
is server-reported at the end of a request, so a long thinking pass shows no
movement for minutes.

## Design

- **Follow.** `extension.ts` calls `sessionTimeBar.follow(id)` on
  `onGenerationStarted` and `follow(undefined)` on `onConversationSwitched`.
  `SidebarProvider.getSessionMetrics(followed)` reports the followed chat while
  it is still open, else the active one, and sets `following` (its title) when
  that is not the chat on screen. The bar prefixes `$(eye) <title>` then.
- **Live estimate.** `LiveStreamMeter` (new, `src/sidebar/LiveStreamMeter.ts`)
  counts streamed reasoning and answer characters per conversation. `ModelTurn`
  adds on `onReasoning` / `onToken`, resets on `onUsage` (the server's count
  takes over) and at turn start (a cancelled request reports no usage).
  `AgentLoop.getLiveStream(id)` returns it only while that chat is streaming.
  Shown as `think ~N · answer ~M`, chars ÷ 4, always with `~`; the tooltip says
  it is an estimate.

## Out of scope

- Exact live token counts (would need per-chunk token ids from each backend).
- A per-chat bar for several concurrent background chats; the last to start wins.

## State × lifecycle ledger

No durable state: the meter and the followed id live in memory and die with the
extension host. Nothing is persisted.

## Acceptance criteria

- A chat started by `forge.sh --new` while another chat is on screen shows on
  the bar, named with `$(eye)`, during and after its turn.
- Picking a chat in the sidebar returns the bar to that chat.
- During a thinking pass the `think ~N` figure grows every second, and vanishes
  when the request ends.
- `npm run ci` green; `LiveStreamMeter.test.ts` and the new
  `SessionTimeStatusBar.test.ts` cases pass.
