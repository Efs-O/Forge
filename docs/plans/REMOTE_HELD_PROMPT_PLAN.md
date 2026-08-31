# Remote Held Prompt Plan

Status: proposed — 2026-08-31

## Problem

A prompt sent from Telegram into an idle-expired session is destroyed.

`RemoteController.handle()` gates every inbound event. When the session has
expired, `RemoteSessionAuth.gate()` reaches its no-code branch
(`RemoteSessionAuth.ts:124-128`), flips the session to `awaiting_totp`, and
returns `{ kind: 'challenge' }`. The controller
(`RemoteController.ts:161-169`) replies "authentication required", returns
`{ kind: 'handled' }`, and **the event is discarded**. Nothing holds it.

The user then sends the 6-digit code, `gate()` returns `newlyAuthenticated`,
the controller replies "Forge: authenticated." and returns
(`RemoteController.ts:185-192`). It never looks for anything pending — so the
original prompt has to be retyped from the phone.

## Non-goals

An earlier framing proposed a proactive "1 minute before expiry" warning and a
"session expired" push. Both are rejected:

- Expiry here is **lazy arithmetic, not a scheduled event**.
  `RemoteSessionAuth.expire()` (`RemoteSessionAuth.ts:243-253`) subtracts
  `lastActivityAt` from `now` and is only ever reached via `gate()`, `touch()`,
  `canUse()`, or `currentNonce()` — all of which require an inbound event or an
  outbound delivery check. `RemoteSessionAuth` contains no timer. A proactive
  push would need a new `setInterval` sweep plus disposal wiring, and would
  still have to answer what it does while VS Code is closed.
- Once the prompt is held, the warning buys nothing. Sending a prompt into an
  expired session stops costing anything, which was the warning's entire value.

The information the warning would have carried moves into the challenge
message, which already fires at exactly the moment it matters.

Also out of scope: holding more than one prompt, and persisting a held prompt
across a window reload. Sessions are memory-only by design
(`RemoteSessionAuth.ts:45-50`); the held prompt matches that lifetime.

## Design

Three changes, no new timers.

### 1. `gate()` says *why* it is challenging

`RemoteGateResult`'s challenge arm (`RemoteSessionAuth.ts:35`) carries no
reason, so the controller cannot honestly write "expired". Add one:

```ts
| { kind: 'challenge'; reason: 'expired' | 'locked' }
```

`AuthSession` gains `expiredFromInactivity?: boolean`, set in `expire()` when
inactivity is what locked the session, and cleared on successful
authentication and on explicit `lock()` (`/lock`, enrollment change, disable).
`lock()` must clear it: a deliberate lock is not an expiry.

### 2. A held prompt, owned by one small module

New file `src/remote/RemotePendingPrompt.ts` — the single owner of held
prompts, added to `docs/OWNERS.md`. `RemoteController` is at 295 LOC and this
keeps it under the soft threshold.

```ts
hold(event, now?)                  // one slot per channel+chat; a new prompt overwrites
take(channel, chatId, now?)        // pops, honouring TTL
clear(channel, chatId)
clearChannel(channel)
```

TTL of 10 minutes. Only `text` events can ever be held, and that is structural,
not a check to remember: `gate()` returns `blocked` for any non-text event
before the challenge branch is reachable (`RemoteSessionAuth.ts:122`).

**Why holding is safe.** The sender's identity is established *before* the
gate — `RemoteController.handle()` rejects a non-owner at
`RemoteController.ts:150`, and `gate()` returns `blocked` when
`enrollment.ownerId !== ownerId` (`RemoteSessionAuth.ts:108`). So a held prompt
is provably from the enrolled owner; only the second factor is outstanding.
The held prompt runs only after that factor is satisfied. This is the same
shape as a login flow preserving the URL you asked for.

Cleared on: successful replay, TTL, `/lock`, and lockout after
`MAX_FAILURES`. Lockout matters most — five failed codes must not leave a
prompt armed.

### 3. Controller holds, explains, and replays

In the `challenge` branch, hold the event and send a message naming the cause:

> Forge: session expired after 30 min idle. Your prompt is held and will run
> once you verify — send your 6-digit code.

and for `reason: 'locked'` (never authenticated this session, or `/lock`):

> Forge: authentication required. Your prompt is held and will run once you
> verify — send your 6-digit code.

Timeout minutes come from `options.inactivityTimeoutMinutes ?? 30`, matching
`RemoteController.ts:228`.

In the `newlyAuthenticated` branch, after "Forge: authenticated.", pop the held
prompt, echo a truncated preview so a replay is never silent, and re-enter
`handle()` with it.

Re-entering `handle()` rather than duplicating the admission path is what keeps
`/commands`, `/steer`, attachments and the `maxMessageChars` check working on a
replayed prompt. It cannot recurse: the replayed event now gates as
`authorized` without `newlyAuthenticated`, so the replay branch is unreachable
the second time. Dedup is unaffected — `remoteDedupKey` is computed at
admission, and the held event was never admitted, so the replay is its first
and only admission.

## Verification

Unit tests in `test/unit/RemoteCore.test.ts` (existing home for this
boundary), using `FakeRemoteChannel`:

1. Prompt into an expired session → challenge message names the expiry and
   says the prompt is held.
2. Correct code afterwards → the held prompt runs; the fake channel shows the
   echo; the prompt reaches the host exactly once.
3. Prompt held, then five wrong codes → lockout clears the held prompt; a
   later correct code runs nothing.
4. `/lock` while a prompt is held → held prompt cleared.
5. Second prompt while one is held → the newer one replaces it.
6. Held prompt past TTL → not replayed.
7. A non-owner cannot reach the hold path at all.

Then `npm run ci` and `npm run package`.
