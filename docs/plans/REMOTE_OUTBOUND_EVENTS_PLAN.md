# Remote Outbound Events

Forge's remote transports are close to one-directional. A paired Telegram chat
hears about what Telegram itself asked for, and almost nothing else. Two user
reports, one cause.

## What was reported

1. A prompt typed in the **sidebar** produces no Telegram output. Sending
   anything from Telegram "establishes" it. The remote chip stays blue
   throughout.
2. `/unloadModel` run from the sidebar reaches Telegram silently — no notice.
   Suspected to apply to the other slash commands too. It does.

## The actual cause

`ForgeHostFacade` exposes exactly three outbound hooks:

| Hook | Fires on | Reaches |
| --- | --- | --- |
| `onCompactionEvent` | compaction start/end | chats bound to that conversation |
| `onUserNotification` | the agent calling `notify_user` | chats bound to that conversation |
| `onAgentProgress` | streamed turn progress | only a turn with a live progress message |

That is the complete set. Everything else the window does — unloading a model,
restarting the backend, starting or clearing a chat, finishing a turn — is a
plain method call that emits nothing.

The progress path is the sharpest case. `RemoteAgentProgress.begin()` takes a
`messageId`: the Telegram message it edits in place. The only caller is
`RemoteQueueDrain`, which drains **remote-originated** prompts. A sidebar turn
has no message to edit and no code that would create one, so it is not that
mirroring is failing — there is no mirroring.

Compaction is the lone exception, and only because auto-compaction can strike
while the user is away from the desk. It got an event for that reason.

### The chip was right

`#remote-chip` reports transport-running plus owner-paired. Both were true.
Its tooltip says "Messages from there drive this window" — one direction,
deliberately. Greying it out would have been false in the other direction: the
`/resume` binding was live, and a `notify_user` or compaction notice would have
arrived. The chip is not the bug.

## Design

One new event, not two. Both reported gaps are "the host did something and
nobody outside the window heard", so they get one hook:

```ts
export interface HostActivityEvent {
  text: string;
  /** Absent = window-scoped: reaches every chat bound to this workspace. */
  conversationId?: string;
}
```

Conversation-scoped events reuse `enqueueHostNotification` unchanged. Window
scope needs a new fan-out, because unloading a model is not a property of one
conversation — `bindingsForWorkspace` mirrors the existing
`bindingsForConversation`.

### Emission points

| Source | Scope | Text |
| --- | --- | --- |
| `/unloadModel` | window | `Forge: models unloaded.` |
| `/restartBackend` | window | `Forge: backend restarted.` / stopped |
| `/newChat` | window | `Forge: started a new chat here.` |
| `/clearChat` | conversation | `Forge: chat cleared.` |
| turn finished | conversation | the assistant's answer |

`SlashCommandHandler` already owns `compactionListeners` and
`onCompactionEvent`. The activity listeners sit beside them, same shape — no
new ownership, no new file for the emitter.

### Not double-posting a remote turn

`onGenerationFinished` fires for every turn, whatever asked for it. A
Telegram-originated turn is already reported by `RemoteQueueDrain` via
`progress.finish()`, so mirroring it too would send the answer twice.

The rule: **mirror only when no remote progress message owns this turn.**
`RemoteAgentProgress` already keys its `active` map by `conversationId` and
`begin()` is the only thing that populates it, so `owns(conversationId)` is the
exact question, answered by the component that knows. No origin flag has to be
threaded through the turn path to ask it.

### Toggles

`/notify on|off` already exists, defaults on, and means "host-originated
messages to this chat". Compaction, `notify_user` and the new window activity
all belong to it — no second switch.

Turn echoes get their own `/mirror on|off`, **default on**, because they are a
different volume of traffic: `notify_user` is rare and deliberate, whereas a
mirrored turn fires on every answer. Wanting the first without the second is a
real preference, not a hypothetical one. Both are in-memory and reset on window
reload, matching `/notify` and `/clanker`.

## Risks

- **Phone noise.** Default-on mirroring means every sidebar turn buzzes a
  paired phone. `/mirror off` is the answer, and the pairing flow should say so.
- **Long answers.** Turn text is capped the way progress text already is;
  `keepTail` is the existing owner of that.
- **Ordering.** The outbox is durable and already serialises per chat, so a
  mirrored answer cannot overtake a compaction notice.

## Out of scope

Live token-by-token progress for sidebar turns. It would mean posting a
placeholder message per turn to have something to edit, multiplying Telegram
API traffic for a view nobody asked for while sitting at the keyboard. The
final answer is what is missing when you walk away.
