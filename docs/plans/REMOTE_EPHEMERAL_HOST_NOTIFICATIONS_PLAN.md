# Remote ephemeral host notifications (auto-delete "unloaded" broadcasts)

## Goal

The remote chat (Telegram) accumulates persistent `Forge: <model> unloaded.` /
`Forge: all models unloaded.` lines. Make these auto-delete after the same
delay that governs command replies (`delete_command_replies_after`, default
10s), so they behave "like the other commands".

## Root cause

Command replies auto-delete because they flow through
`CommandCleanupScheduler.trackReplies`, which arms a delete per sent message id.
The `…unloaded.` lines are a different path: host-activity events from
`SlashCommandHandler.runUnload` → `emitActivity` → the durable outbox
(`RemoteOutboxDelivery.deliver` → raw `channel.send`), which discards the
returned message ids and never arms a delete. (The remote `/unload` command
reply is a different, longer "memory released" text and already auto-deletes via
`trackReplies`.)

## Method

Thread an `ephemeral` flag from the event to the outbox record, then arm
deletion on delivery, reusing `CommandCleanupScheduler`:

1. `src/sidebar/HostActivity.ts` — `HostActivityEvent`: add `ephemeral?: boolean`.
2. `src/sidebar/SlashCommandHandler.ts` — `runUnload`: `emitActivity({ text, ephemeral: true })`.
3. `src/remote/remoteActivityRouting.ts` — `routeHostActivity`: pass `event.ephemeral` to `broadcastHostNotification` (window-scoped branch only).
4. `src/remote/RemoteController.ts` — `broadcastHostNotification(text, ephemeral?)` → `fanout.toWorkspace(text, ephemeral)`; ctor passes an `armEphemeral` callback to the outbox.
5. `src/remote/RemoteNotificationFanout.ts` — `toWorkspace(text, ephemeral?)` / `send(chatIds, text, ephemeral?)` → `notifyOutbox(channel, chatId, text, { ephemeral })`.
6. `src/remote/RemoteRequestStore.ts` — `notifyOutbox(..., options?: { ephemeral?: boolean })` stores `ephemeral: true` when set.
7. `src/remote/types.ts` — `RemoteOutboxRecord`: add `ephemeral?: boolean`.
8. `src/remote/RemoteStoreSchemas.ts` — `OutboxSchema`: add `ephemeral: z.boolean().optional()`.
9. `src/remote/RemoteOutboxDelivery.ts` — ctor `armEphemeral?` callback; `deliver()` captures the `channel.send` ids and, for `ephemeral` items, arms deletion OUTSIDE the delivery retry path (best-effort, so a failure can never requeue an already-delivered item).
10. `src/remote/CommandCleanupScheduler.ts` — public `armEphemeral(chatId, messageIds)` that reads the live `replyDelaySeconds()` callback (same as `trackReplies`), no snapshot.
11. `src/config/schema.ts` + `src/config/types.ts` — update the `delete_command_replies_after` comment to mention ephemeral host notifications.

Delay = `delete_command_replies_after` (live read via the existing
`replyDelaySeconds()` callback). No new config knob.

Scope: only the unload broadcasts become ephemeral. Compaction, notify_user,
turn echo/failure, backend restart, and chat-cleared are untouched.

## State × lifecycle ledger

Durable artifact: the `ephemeral` flag on the outbox record
(`.forge/remote-state.json` → `outbox[]`).

| Artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `outbox[].ephemeral` | Set in `notifyOutbox` when the unload broadcast is enqueued, atomically with the record via the existing `mutate` + state lock + persist. | Pruned with the record by existing `pruneRemoteState` retention; the flag adds no new retention path. | N/A (outbox items have no pause concept). | Written in the same atomic persist as the record: either both land or neither. A `pending`+`ephemeral` record on disk is delivered and armed after restart. | Same as crash: a `pending`+`ephemeral` record survives and is delivered + armed on the next `start()` (the outbox re-kicks pending items). | Existing outbox `RETENTION_MS` / `MAX_OUTBOX_RECORDS` prune the record; the flag rides along. |

Known best-effort limit (confirmed by Codex): if Telegram accepts the message
but Forge crashes between `channel.send` and `markOutbox('delivered')` +
arming, the provider ids are not persisted, so that one message is not deleted.
This matches the existing command-reply cleanup, which has the same limit.

## Acceptance criteria

- [x] `SlashCommandHandler.runUnload` emits the unload broadcast with `ephemeral: true` (both `/unload` and `/unloadall`) — `SlashCommandHandler.test.ts` (it.each + non-ephemeral scope guard).
- [x] `routeHostActivity` forwards `event.ephemeral` to `broadcastHostNotification` for window-scoped events — `RemoteOutboundActivity.test.ts` (flag, absent→undefined, conversation-scoped never forwards).
- [x] `toWorkspace` / `send` / `notifyOutbox` carry the flag to the durable record; a non-ephemeral record has no `ephemeral` field — `RemoteOutboundActivity.test.ts`.
- [x] `RemoteOutboxRecord` + `OutboxSchema` accept `ephemeral?: boolean`; pre-existing on-disk records (no flag) still parse — `RemoteRequestStoreScope.test.ts` (hand-written v2 state + persist/reload round-trip).
- [x] `RemoteOutboxDelivery.deliver` arms `armEphemeral(chatId, ids)` for an `ephemeral` item after a successful send, with every chunk id — `RemoteHardening.test.ts` (two-chunk id list).
- [x] Non-ephemeral items do NOT arm deletion — `RemoteHardening.test.ts` (asserted after the delivered mark).
- [x] A failed send does NOT arm deletion and requeues the item (existing retry path intact) — `RemoteHardening.test.ts` (pending, attempts: 1).
- [x] A `void` send (no ids) arms with `[]` and does not throw — `RemoteHardening.test.ts`.
- [x] A throwing `armEphemeral` does NOT requeue an already-delivered item; it reports via `onError` — `RemoteHardening.test.ts`.
- [x] A pending+ephemeral record survives a restart: delivered and armed after reload — `RemoteHardening.test.ts` (ledger crash-mid-write / owner-process-death claim).
- [x] A throwing `onError` in the cleanup path does NOT reject `deliver()` or requeue the delivered item — `RemoteHardening.test.ts`.
- [x] Duplicate delivery (delivered-mark failure → re-send) arms exactly once and the item ends delivered — `RemoteHardening.test.ts`.
- [x] `CommandCleanupScheduler.armEphemeral` deletes each id after the live `replyDelaySeconds()`; no-op when it is 0 — `RemoteCommandCleanup.test.ts` (delay, 0, arm-time read, dedup, key-space separation from `trackReplies`).
- [x] `delete_command_replies_after` comment mentions ephemeral host notifications — `schema.ts` + `types.ts`.
- [x] `npm run type-check` and `npm test` pass — type-check clean; 327 files / 3235 tests green (2026-09-26).
