# Remote Selection Pagination Plan

**Date:** 2026-09-01  
**Status:** approved for implementation  
**Scope:** paginate Telegram `/list` and `/models` results in groups of ten
without changing conversation/model selection semantics.

## Problem

`/list` and `/models` currently send every available entry in one message. A
workspace with dozens of conversations produces a long Telegram response that
is difficult to scan and leaves unnecessary history in the chat.

Telegram does not send bot events for an empty Enter press, Escape, or the
mobile Back gesture. Pagination therefore needs native inline-keyboard callback
buttons rather than keyboard-event emulation.

## Desired behavior

- Show ten entries per page for both `/list` and `/models`.
- Include an explicit range and page count, for example `1–10 of 40 · page 1/4`.
- Show `Previous`, `Next`, and `Close` buttons as applicable.
- Edit the original Telegram message when moving between pages.
- Delete the Telegram message when `Close` is pressed.
- Preserve absolute numbering across every page so `/select 17` and `/model 17`
  retain their existing meaning.
- Keep the existing ten-minute selection lifetime.
- Support `/list <page>` and `/models <page>` as text fallbacks for transports
  without interactive pagination.
- Reject stale, expired, cross-chat, cross-kind, and out-of-range callbacks.

## Architecture

### Durable selection state

Extend the existing remote selection record with an optional opaque token. New
selections receive a short random token; the field remains optional so version-2
state created by previous Forge builds continues to parse unchanged.

The stored `values` array remains the single mapping from absolute number to
conversation ID or model name. Navigation never reorders or replaces that
mapping.

### Transport-neutral event

Add a strict `kind: selection` inbound event carrying:

- selection kind: `conversations` or `models`;
- opaque selection token;
- action: show a validated zero-based page or close the list;
- provider message ID needed to edit/delete the original response.

The event passes through the existing private-chat, paired-owner, TOTP, and
rate-limit gates before it can affect presentation state.

### Remote channel surface

Add optional channel presentation methods for:

- sending a selection page;
- editing a selection page;
- closing a selection page.

Telegram implements these with `sendMessage`, `editMessageText`, and
`deleteMessage`. Other transports may omit the methods and receive a plain-text
page with a command fallback.

### Shared pager

A dedicated remote selection pager owns:

- page-size and TTL constants;
- page parsing and bounds checks;
- stable page formatting;
- conversation metadata lookup;
- model formatting;
- selection callback validation;
- navigation and close behavior.

This prevents `/list` and `/models` from developing separate pagination logic
and keeps `RemoteCommandHandler.ts` within its command-routing responsibility.

### Telegram callback encoding

Use compact callback data that remains below Telegram's 64-byte limit:

```text
s:<opaque-token>:c:<zero-based-page>
s:<opaque-token>:m:<zero-based-page>
s:<opaque-token>:c:x
s:<opaque-token>:m:x
```

`c` means conversations, `m` means models, and `x` means close. Parsing is
strict; arbitrary callback data remains ignored or rejected.

## Security and reliability invariants

1. Navigation is private-chat-only and paired-owner-only.
2. TOTP must authorize every callback when enrolled.
3. A new selection invalidates older buttons of the same kind and chat.
4. A token cannot operate another chat or selection kind.
5. Expired selections cannot be navigated or closed authoritatively.
6. Callback page indices are bounded against the stored selection length.
7. Numeric `/select` and `/model` resolution continues to use the full stored
   values array, not only the visible page.
8. Callback data contains no conversation IDs, model names, paths, identities,
   or secrets.
9. Callback updates use the existing disposition-before-cursor ordering.
10. Close invalidates the selection before removing its Telegram message.

## Implementation steps

1. Extend remote selection state with an opaque token and safe clear/lookup
   methods.
2. Add strict selection event and channel presentation types.
3. Implement shared conversation/model formatting and action handling.
4. Route authenticated selection actions in `RemoteController`.
5. Add Telegram pagination keyboards, callback parsing, message editing, and
   deletion.
6. Replace unbounded `/list` and `/models` rendering with the shared pager.
7. Update the fake channel and add focused unit coverage.
8. Update Telegram command documentation.
9. Run `npm run ci` and `npm run package`.

## Acceptance criteria

- A list of 40 conversations initially displays only items 1–10.
- `Next` displays 11–20 by editing the same message.
- `Previous` returns to the earlier page.
- Page four displays 31–40 and has no `Next` button.
- `Close` removes the Telegram list message and invalidates its token.
- The same behavior applies to more than ten configured models.
- `/select 17` and `/model 17` resolve the seventeenth stored item after page
  navigation.
- `/list 2` and `/models 2` work as text fallbacks.
- Invalid pages receive a visible usage/range rejection.
- Stale, expired, wrong-chat, and wrong-kind callbacks fail closed.
- Existing approval callbacks continue to work unchanged.
- Telegram callback payloads remain within the 64-byte Bot API limit.
- Existing remote-state files migrate implicitly without a version bump.

## Non-goals

- Capturing Enter, Escape, or mobile Back key events.
- Turning conversation rows into individual resume buttons.
- Adding Telegram Mini Apps.
- Changing sorting, archive visibility, selection lifetime, or conversation
  restoration behavior.
- Adding a new public endpoint or hosted service.
