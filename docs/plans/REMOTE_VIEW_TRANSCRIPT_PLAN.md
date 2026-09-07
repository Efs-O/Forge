# `/view` — read a conversation back from the phone

Status: planned 2026-09-07, for 0.15.24.

## The gap

There is no way to read a transcript from a remote chat. `/status` and
`/context` report numbers, `/chats` reports titles, and `/queue` reports pending
work. Nothing shows words. So `/chat 3` switches you into a conversation you
then cannot read, and the question that prompted this — *"I opened an old chat
and I do not remember what came of it"* — has no answer short of walking to the
machine.

The gap widens with the mirroring model. `d274397` gave a sidebar-started turn a
live progress message, but that message is **edited in place** and replaced with
`Forge: completed.` when the turn ends. A phone that was off for an hour is not
shown the edits it missed; it sees the final state only. Push is therefore
lossy by construction for the trace, and always will be. A pull command is the
complement, not a workaround.

## The command

```
/view [n]
```

- `n` defaults to **3** and is capped at **10**. A larger number is clamped,
  not refused, and the reply says it clamped — refusing a `/view 20` teaches
  the command is fragile when the honest answer is "here are 10".
- Operates on the conversation bound to this chat. No binding is the same
  rejection `/context` and `/stop` already give: `no conversation is bound`.
  Reaching another conversation is `/chat <n>` first — `/view` does not take a
  conversation operand, because two ways to address a conversation is how
  `/select` and `/chat` ended up as aliases for each other.
- Sits in the **Session** group of `/help`, beside `/status` and `/context`.

## What it shows

Each of the last `n` **exchanges**, oldest first, one Telegram message each.

Oldest first because that is reading order: Telegram appends downward, so
newest-first would have to be read bottom-up. One message per exchange because a
single agent answer runs to thousands of characters and Telegram's limit is
4,096 — packing five into one message means truncating each to ~800 characters,
which destroys exactly the detail the command exists to recover.

An exchange is the assistant's answer plus the user prompt that provoked it,
rendered as:

```
[2/3] You: resume

<the answer>
```

The prompt line is capped at 120 characters and is not optional. Five answers
with no idea which question each replies to is not a recap. The `[2/3]` counter
tells the reader whether they are looking at the whole of what they asked for.

Answers are truncated to fit `maxMessageChars` with the existing tail marker,
never split across two messages: a half-answer arriving as two notifications is
worse than a whole one that says it was cut.

## Where the text comes from

`displayPersistMessages` in `src/sidebar/sessionProjections.ts` — the same
text-only projection the webview renders.

**Not** the session log under `~/.forge/sessions/`. That file is a forensic
artifact with a known duplication defect: sessions written before 0.13.20
re-append the whole conversation on every window reload, and one audited file
was 65% duplicate rows. `/view` reading it would show the same answer three
times over. It is also keyed by session file rather than by conversation, so it
cannot answer "the chat this phone is bound to" without a second mapping.

The projection is also what `/chat` binds to, so the two commands agree about
what a conversation contains. Three consequences follow from that choice and are
accepted:

- **After `/compact`, `/view` shows the summary, not the original answers.** It
  reports what the agent can still see, which is the more useful of the two
  answers and the only one that stays true as the conversation continues.
- Tool rows and diffs are skipped. `/view` answers "what did it conclude", not
  "what did it run".
- An assistant turn that only called tools has no text and is not an exchange.

## Files

| Concern | File |
| --- | --- |
| Selecting and rendering the exchanges | `src/remote/RemoteTranscriptView.ts` (new) |
| `/view` dispatch | `src/remote/RemoteSessionCommands.ts` |
| Transcript access for transports | `src/sidebar/ForgeHostFacade.ts` |
| Command map | `src/remote/remoteHelpText.ts` |

`RemoteCommandHandler.ts` is at 463 of its 500 lines, so the rendering does not
go there; `RemoteSessionCommands.ts` (258) takes the dispatch because `/view` is
a session command, and the new module takes the formatting.

### Facade

```ts
/** The last `limit` prompt/answer pairs, oldest first. */
recentExchanges(conversationId: string, limit: number): ForgeExchange[];
```

Added to `ForgeHostFacade` rather than reaching into `getOpenConversations()`
from the remote side: the facade is the seam transports use, and the one place
that already knows an archived conversation is still readable.

## Delivery

Sent with `channel.send`, directly, exactly as `/status` and `/context` are —
not through the outbox. These are the interactive reply to a command the owner
just typed; queueing them for durable retry would mean a `/view` sent during an
expired session arrives silently an hour later among unrelated notifications.

`/mirror off` does not silence it. That switch means "stop pushing answers at
me"; `/view` is the owner pulling.

## Tests

- `n` defaults to 3, clamps at 10, and says so when it clamps.
- Oldest first, numbered `[i/total]`.
- The prompt line is present and capped.
- A long answer is truncated with the marker, not split.
- Tool-only turns are skipped rather than rendered as empty messages.
- A conversation with no answers yet replies once, saying so.
- No binding is rejected, not answered with an empty list.
