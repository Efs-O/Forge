# Per-session active time and system clock — implementation plan

**Status:** Draft for review — no implementation included.

**Goal:** show a live system clock and the selected conversation's accumulated
active-agent time beside Forge's existing status-bar state, with the time
preserved when conversations are switched or VS Code is reopened.

## Proposed behaviour

The bottom status bar would contain two adjacent items:

```text
$(pulse) Forge: generating    $(history) 00:12:34    $(clock) 19:42:08
```

- The existing Forge item continues to report stopped, ready, generating, and
  error states.
- A second Forge session item shows the selected conversation's active time.
- The system clock shows local machine time and updates once per second.
- Switching conversations immediately changes the session timer to that
  conversation's stored total.
- A session can continue accumulating time while it runs in the background;
  the selected tab controls only which total is displayed.
- Existing conversations without the new fields start at `00:00:00`.

## Timing definition

The recommended definition is **active agent time**: the interval from Forge's
generation start to generation finish for each conversation. This includes the
agent's tool rounds, file operations, and other work performed as part of the
turn, but excludes time spent waiting for a user approval decision. It does not
include time while the user is simply reading or composing a prompt.

This is preferable to asking llama-server for a session duration. llama-server
reports timings for individual requests, while Forge sessions can contain
multiple model requests, tool calls, approvals, and retries. Forge owns the
conversation lifecycle and can measure the complete agent turn reliably.

If the desired meaning is strictly GPU/model inference time, that should be a
separate mode: it would require timing each individual LLM HTTP request rather
than the existing turn lifecycle.

## Persistence model

Add optional fields to `ConversationRuntime` and its persisted Zod schema:

```ts
active_time_ms?: number;
active_started_at?: number;
```

The fields remain optional so existing `workspaceState` records migrate without
rewriting or losing conversations.

Lifecycle:

1. On generation start, record `active_started_at` and persist the session.
2. On generation finish, add `Date.now() - active_started_at` to
   `active_time_ms`, clear `active_started_at`, and persist.
3. While a generation is active, periodically persist a checkpoint of the
   accumulated value so an abnormal VS Code exit loses at most a small interval
   of time rather than the entire active turn.
4. On restore, if an old record contains `active_started_at`, close that
   unfinished interval at restore time, counting the elapsed time through the
   reload.

Timers must calculate from `Date.now()` rather than incrementing once per
interval, so delayed JavaScript timers do not introduce drift.

## Status-bar design

Extend `src/vscode/BackendStatusBar.ts` with a second `StatusBarItem` rather
than making the existing Forge state string progressively wider.

Suggested API:

```ts
setSession(conversationId: string, activeTimeMs: number, activeSince?: number): void;
clearSession(): void;
```

The item owns a one-second refresh interval while it is visible. It should use
`context.subscriptions`/`dispose()` to clear the interval and both status items.
The tooltip should include the full session title or ID and explain that the
counter is active-agent time.

The system clock may use the same class and interval, but it must remain
independent of conversation state and continue displaying while Forge is
stopped.

## Event wiring

The current generation events carry only a model name. Extend the relevant
callbacks to carry the conversation ID as well:

```ts
onGenerationStarted?: (modelName: string | null, conversationId?: string) => void;
onGenerationFinished?: (modelName: string | null, conversationId?: string) => void;
```

Update local, cloud, and CLI turn paths consistently. The event owner should
update the conversation's persisted timer state; the extension-level callback
should refresh the status-bar display for the currently selected conversation.

Conversation switching should call the same refresh path, so the item never
continues showing the previous tab's total. The item remains visible for a new
empty conversation and initially displays `00:00:00`.

## Candidate files

- `src/sidebar/sessionTypes.ts` — persisted/runtime fields and schema migration.
- `src/sidebar/AgentLoop.ts` — conversation-aware generation events.
- `src/sidebar/ProviderTurn.ts` and `src/sidebar/CliTurn.ts` — pass the
  conversation ID through start/finish events.
- `src/sidebar/ConversationTabs.ts` — refresh display on tab switches.
- `src/sidebar/BackendStatusBar` integration in `src/extension.ts` — connect
  timer updates and disposal.
- `src/vscode/BackendStatusBar.ts` — second item, formatting, and clock tick.
- Existing session and status-bar unit tests — migration, accumulation,
  switching, and disposal coverage.

No llama-server, model, or config-schema changes should be needed for the
recommended active-agent-time version.

## Edge cases

- Concurrent conversations: each conversation has its own active interval;
  switching the visible tab must not stop a background conversation's timer.
- Cancellation and backend failure: finish the active interval exactly once.
- Multiple generation-start paths: avoid double-starting the same interval.
- CLI/cloud turns: count them as active-agent time, alongside local llama.cpp
  turns.
- VS Code reload during generation: use the persisted `active_started_at`
  policy selected below rather than silently losing the interval.
- Closed conversations: their final total remains in history until the normal
  history retention policy removes them.

## Tests

Add tests for:

- old persisted records parsing without the new fields;
- start/finish accumulation;
- repeated finish/cancellation not double-counting;
- background conversation timing while another conversation is selected;
- restoring an unfinished interval;
- status-bar formatting at seconds, minutes, and hours;
- system clock refresh and disposal of the interval;
- status-bar switching between conversations.

## Open decisions before implementation

1. Should the counter include tool execution and approval waits (recommended),
   or only raw LLM request time?
2. If VS Code closes during an active turn, should the unfinished interval be
   counted up to reload time, or discarded as incomplete?
3. Should CLI/cloud sessions count, or only local llama.cpp sessions?
4. Preferred display format: `HH:MM:SS` always, including for durations below
   one hour.
5. The status-bar item is visible for a new empty conversation and shows
   `00:00:00`.

## Decisions recorded for this draft

- Count model work and tool execution, but not approval waits.
- Count unfinished active intervals through VS Code reload.
- Count local, CLI, and cloud agent sessions.
- Always display elapsed time as `HH:MM:SS`.
- Keep the session timer visible from the beginning of every conversation.
