# Remote Command Auto-Cleanup Plan

Status: **implemented 2026-09-13, released in 0.16.0** (`bc9c234`).
`src/remote/CommandCleanupScheduler.ts`, scheduled from `RemoteController`;
`remote.delete_command_messages_after` (default 5, `0..3600`). Tests:
`test/unit/RemoteCommandCleanup.test.ts`.

After Forge has terminally processed an owner-authenticated Telegram command,
delete the owner's original command message after a configurable delay. Forge's
reply remains. This is presentation-only, best-effort work: no delete outcome
may alter command execution, acknowledgement, or retry behaviour.

## Scope and exact routing rule

- Add `remote.delete_command_messages_after` in seconds; `0` disables it and
  the validated default is `5`. Bound it to `0..3600`.
- Apply only to a terminal (`handled` or `rejected`) result from a text command
  that reached command execution:
  - the normal `isRemoteCommand(event.text)` route (all slash text other than
    `/steer`, including an unknown command which the handler rejects), and
  - the inline `/lock` route.
- Do not delete ordinary prompts, any `/steer` form, voice, selections,
  approval actions, pairing/TOTP input, commands rejected before execution
  (auth/session gate, rate limit, or length check), or any `retry` result.
- `/steer` deliberately remains prompt admission: `parseSteerCommand` makes
  `isRemoteCommand` false for it.

This wording treats an unknown slash command as a command-routed rejected
command. If product instead means only names in the command catalog, add a
shared command classifier first; do not duplicate the catalog in the
controller. The current handler has no such classifier.

`event.providerMessageId` is the correct original Telegram message id on the
text path: `telegramUpdateToEvent` sets it from `message.message_id`. It must
be used with `event.chatId`; callback ids used by selection/action events are
irrelevant because those paths never schedule cleanup.

## Why there are two choke points

The normal branch in `RemoteController.handle()` is the correct central point
for all command-handler commands, but it is not the only command path:
`/lock` is handled and replied inline before rate limiting and before that
branch. Schedule after both terminal paths. All earlier returns occur before
either scheduling point, which protects commands that were not processed.

For the normal branch, `retry` does **not** return before the scheduling code;
it reaches the common return after the result check. Therefore the code must
explicitly schedule only `handled`/`rejected` (never rely on return ordering).
`handleRemoteCommand` maps an already-completed dedup control event to
`handled`, so timer scheduling also needs its own per-message dedup guard.

## Implementation

### 1. Configuration and public option

In `src/config/schema.ts`, add beside `rate_limit_per_minute`:

```ts
/** Seconds to retain a processed Telegram command; 0 disables cleanup. */
delete_command_messages_after: z.number().int().min(0).max(3600).default(5),
```

Add the required number to `ForgeConfig.remote` in `src/config/types.ts`, and
document the non-secret setting in `config/config.example.yaml` beside the
other remote behaviour settings.

Add the required `deleteCommandMessagesAfter: number` to
`RemoteControllerOptions`, and map it directly in
`buildRemoteControllerOptions`. Do not make this optional or introduce a
controller fallback: the validated config always supplies it. Update every
manual `RemoteControllerOptions` fixture/object literal in tests with an
explicit value (normally `0`, except cleanup tests).

`RemoteRuntime.replace()` calls `updateActiveOptions()` whenever transport
topology and voice runtime signature are unchanged; that method rebuilds
options with `buildRemoteControllerOptions(config, this.deps)` for each active
controller. Thus a config reload changes the delay for subsequently received
commands without a window reload. Timers already armed retain the delay that
armed them.

### 2. Channel affordance

Add this optional method to `RemoteChannel` in `src/remote/types.ts`, beside
`editMessage`:

```ts
deleteMessage?(
  chatId: string,
  messageId: string,
  options?: { signal?: AbortSignal },
): Promise<void>;
```

Implement it in `TelegramChannel` with the same options shape as
`editMessage`:

```ts
async deleteMessage(chatId: string, messageId: string, options?: { signal?: AbortSignal }) {
  await this.call(
    'deleteMessage',
    { chat_id: chatId, message_id: Number(messageId) },
    options?.signal,
  );
}
```

`call()` derives `chat_id` and runs through `sendQueue`, so the delayed delete
shares the Telegram chat lane with replies. In particular, a rejected-command
reply is sent by Telegram's acknowledgement layer only *after* controller
`handle()` returns; its immediate send is enqueued before the later timer's
delete. Do not claim that `handleRemoteCommand` itself always sent the rejected
reply.

Give `FakeRemoteChannel` a `deleted: Array<{ chatId: string; messageId: string
}>` recorder and `deleteMessage` implementation.

### 3. Controller scheduling and lifecycle

In `RemoteController`, maintain:

- a `Set<string>` of cleanup keys already armed/attempted, keyed with
  `remoteDedupKey(event.channel, event.chatId, event.providerMessageId)`; keep
  a key after firing so duplicate delivery cannot issue a second delete; and
- a `Set<ReturnType<typeof setTimeout>>` of pending timer handles.

Add a private helper taking `Extract<RemoteInboundEvent, { kind: 'text' }>`:

1. Return when delay is `0`, the channel lacks `deleteMessage`, or the cleanup
   key is already present.
2. Add the key, arm `delaySeconds * 1000`, and remove only that timer handle
   when it fires.
3. On firing, return if the controller abort signal is set. Otherwise invoke
   `channel.deleteMessage(event.chatId, event.providerMessageId, {
   signal: this.abort.signal })` without awaiting the command path. Wrap both
   synchronous and asynchronous failure (for example with an async detached
   function and `try/catch`) and report it through `options.onError`; never
   throw from the timer.

After `handleRemoteCommand` resolves, touch auth as today and call the helper
only when its result is `handled` or `rejected`. In the existing inline
`/lock` block, call the same helper after its successful `channel.send` and
before returning `{ kind: 'handled' }`. Do not move `/lock` into the command
handler merely for cleanup.

At the beginning of `stop()`, set `accepting` false, clear every pending timer,
clear the timer/key collections, then abort as today. A delete already started
is passed the abort signal; it remains best effort and is not awaited by
shutdown.

## Tests

- `test/unit/RemoteCore.test.ts`: extend the full remote-config `toEqual` with
  default `5`; reject `-1` and `3601`.
- `test/unit/TelegramChannel.test.ts`: call public `deleteMessage('chat','42')`
  and assert one `deleteMessage` API call with numeric `message_id: 42`.
- Add focused `test/unit/RemoteCommandCleanup.test.ts` with fake timers and an
  owner-authenticated controller. Cover:
  - handled command deletes after 5 seconds, using the inbound
    `providerMessageId`;
  - rejected handler command (bad argument and/or unknown command) deletes;
  - inline `/lock` deletes;
  - `retry` is not scheduled (exercise a real retry-producing command path or
    a controlled handler dependency; do not assert this only by code review);
  - delay `0`, normal text, `/steer`, voice, selection, and approval produce
    no delete;
  - a rejecting (and, if practical, synchronously throwing) delete reports
    `onError` but leaves the original terminal disposition unchanged;
  - duplicate delivery for the same provider id results in one delete attempt;
  - `stop()` before expiry prevents the delete.
- Add a `RemoteRuntime` reload test using a retained fake Telegram channel:
  apply enabled config, apply an in-place config change from `5` to `0`, then
  emit a command and advance timers. Assert no delete, proving the active
  controller received rebuilt options rather than relying on code review.
- Run `npm run ci`, `npm run package`, and `git diff --check` after the final
  implementation edit.

## Acceptance criteria

- The validated setting defaults to `5`, accepts `0..3600`, appears in the
  example config, and applies to new commands after an in-place config reload.
- A terminal command-handler command and inline `/lock` delete exactly the
  owner's original Telegram text after the configured delay; replies remain.
- Retry/non-command and pre-execution rejection paths do not delete anything.
- Delete failures, duplicate delivery, and controller shutdown cannot change
  command execution or create an unhandled timer error.

## Deliberate limitation

The timer is process-local. A `/reload`, extension-host shutdown, or transport
replacement before it fires cancels cleanup; a delete already in flight may be
aborted. Guaranteeing deletion across those boundaries would require a durable
cleanup intent and a running post-reload transport worker, which is outside
this small best-effort feature. Document this behaviour rather than silently
claiming eventual deletion.
