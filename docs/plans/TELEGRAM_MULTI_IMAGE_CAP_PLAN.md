# Telegram: up to 3 images per message, with cap + size surfaced to the user

Status: **implemented 2026-09-12.** Albums merge into one prompt, capped at 3 images
(`MAX_TELEGRAM_IMAGES_PER_MESSAGE`), with the cap and the 10 MiB / 25 MiB size limits
surfaced in-chat on overflow and documented in `/help`. `albumPhotoFromUpdate()` in the
inbound mapping and the `TelegramAlbumCoordinator` / `TelegramAlbumBuffer` pair keep
album state out of the polling method. The album cursor is committed only after the
combined event is acknowledged, and a held group can merge across poll responses.
Focused tests cover merge, cap+notice, ordering, cursor safety, cross-batch delivery,
`/help` content, and the store's per-image size rejection. Full suite green.

---

## Goal

Let a Telegram user send **up to 3 images in one go** (a photo album), and make the
cap and the size limits discoverable:

1. **Live** — when a user exceeds the cap or a size limit, Forge replies in the chat
   saying what the limit is, instead of silently dropping the overflow.
2. **Documented** — `/help` states the image cap and the per-image / total size limits.

The Forge sidebar is unaffected: it keeps its own `MAX_ATTACHMENTS_PER_PROMPT = 10`
(`src/sidebar/attachmentLimits.ts`). The new cap is Telegram-specific UX, so it is
enforced at the Telegram layer, not by changing the shared constant.

---

## Current behaviour (why this is needed)

A Telegram photo arrives as `message.photo`, an **array of size variants** of the
_same_ image. The inbound mapping takes only the largest variant and emits **one**
attachment:

- `src/remote/TelegramInboundMapping.ts:134-152` — `const photo = message.photo?.at(-1)`
  → `attachments: [attachment]`. Never more than one.
- There is **no `media_group_id` handling anywhere** (searched: zero matches). When a
  user sends a photo _album_, Telegram delivers each photo as a **separate update**
  sharing one `media_group_id`. Today each of those updates becomes its own
  single-image event, so an album of 3 becomes 3 separate prompts queued in a row —
  and an album of 6 becomes 6. That is the "at a time" problem: there is no notion of
  "these photos were one message."

The downstream cap is already 10 (`src/remote/types.ts:33` `.max(10)`;
`src/remote/RemoteAttachmentStore.ts` throws past `MAX_ATTACHMENTS_PER_PROMPT`), so a
3-image event fits under it with no downstream change. Size limits already exist and
are enforced at store time: **10 MiB per image**, **25 MiB total**
(`src/remote/RemoteAttachmentStore.ts`, `prepare()`).

---

## Design

### 1. Schema: carry `media_group_id`

`src/remote/TelegramInboundMapping.ts` — add to the `message` object in
`TelegramUpdateSchema` (it is **not** there today):

```ts
media_group_id: z.string().optional(),
```

No other schema change. `photo` stays as-is (we still take the largest variant).

`RemoteInboundEvent` is **not** touched: the channel reads `media_group_id` off the
parsed update (`TelegramUpdateSchema.parse`), not off the event, and the flushed
album is emitted as a plain `text` event. No new event field is needed.

### 2. Album buffering in the poll loop

`telegramUpdateToEvent` is a pure function and cannot hold state, so the accumulator
lives in the album coordinator used by `TelegramChannel.poll()`, which already owns
per-update state (`retryingUpdateId`, offset). The inbound-shape decision
stays in the mapping module (its docstring: "it is where every inbound-shape bug has
actually lived"), so add a small exported helper there that reuses the existing
`attachment()` builder:

```ts
/** The photo of an album update, or undefined if this update is not one. */
export function albumPhotoFromUpdate(
  update: z.infer<typeof TelegramUpdateSchema>,
): { providerFileId: string; name: string; mediaType: string } | undefined;
```

It returns the largest photo variant only when `message.photo` **and**
`message.media_group_id` are both present; otherwise `undefined`. It does **not**
change `telegramUpdateToEvent` (a single non-album photo keeps flowing through the
existing path untouched).

Keep the buffering and flush contract in `TelegramAlbumBuffer.ts` and
`TelegramAlbumCoordinator`, rather than adding a second album implementation inside
`TelegramChannel`. The coordinator accepts parsed updates, maps album photos, flushes
when the group changes or a non-album update arrives, and delegates handling,
acknowledgement, overflow notification, and cursor persistence through typed
dependencies. `TelegramChannel` remains the owner of polling and normal update
dispatch.

In the poll loop, for each parsed `update`, **before** the existing
`telegramUpdateToEvent` call:

- If `albumPhotoFromUpdate(update)` is defined (an album photo):
  - If the coordinator has no pending group or its `mediaGroupId` differs → flush
    the old one, then add this photo to a new group.
  - Else append. If the group already holds `MAX_TELEGRAM_IMAGES_PER_MESSAGE` (3)
    photos, set `overflow = true` and **do not** append the extra photo.
  - Advance the in-memory offset for this update and `continue` — **do not** emit an
    event or persist the cursor yet.
- Otherwise (any non-album update): flush the pending group first, then fall through
  to the existing `telegramUpdateToEvent` path unchanged.

When an album is pending, the next poll uses a short timeout. An empty response then
flushes the group; this gives Telegram a chance to deliver the remaining photos in a
later response without introducing a wall-clock timer. A group is also flushed before
a following non-album update or a different album so ordering remains intact.

**Flush** (`flushTelegramAlbum()`): build one `text` event with `attachments` = the buffered
photos (≤ 3), `text` = `firstText`, and the stored `chatId` / `senderId` /
`chatType` / `receivedAt` / `firstMessageId`. Call `this.handler(event)` and run
`acknowledgeDisposition` on it, exactly as a normal text event. If `overflow` was set,
also send the overflow notice (see §3). The coordinator clears the pending group
when it takes it for flushing.

#### 2.1 Flush timing — the one subtlety

Album photos are separate updates and can be split between `getUpdates` responses. The
coordinator therefore keeps the group pending while the short follow-up poll waits:

1. **An empty short poll** — no more photos arrived promptly; flush the group.
2. **A non-album update arrives** — flush before handling it.
3. **An album photo with a different `media_group_id` arrives** — flush before
   starting the new group.

Albums split across poll responses are merged while the group remains the pending
group. A non-album update or a different group is the intentional boundary.

The in-memory offset advances as updates are read, but the durable cursor is committed
once, at `lastUpdateId + 1`, only after the combined event receives its disposition.
The album handler is retried up to three times; a final failure becomes a rejection,
is acknowledged, and then advances the cursor. A crash or persistence failure before
that commit leaves the durable cursor before the album, allowing safe redelivery
instead of silently losing it.

### 3. The cap and the live notify

New constant, next to the existing ones in `src/remote/TelegramChannel.ts`
(or `TelegramInboundMapping.ts` if it is used only there):

```ts
export const MAX_TELEGRAM_IMAGES_PER_MESSAGE = 3;
```

When `flushTelegramAlbum()` fires with `overflow = true`, the handler is called with the 3
images, **and** the channel sends one extra notice to the chat:

> `Forge: albums are limited to 3 images per message — I kept the first 3. Each image
is capped at 10 MiB, 25 MiB total.`

This is a direct `this.send(event.chatId, notice, { signal })` — the same primitive
`acknowledgeDisposition` uses internally, so
it respects the per-chat send queue and the 4096-char chunking. It **cannot** go
through `acknowledgeDisposition` itself: that method only emits text for `queued` and
`rejected` dispositions, and the 3 kept images _are_ a valid prompt (they get their own
normal disposition and acknowledgement). The overflow notice is an additional send on
top, not a rejection.

**Size-limit notify** already works end-to-end and is left as-is: an oversize image
makes `RemoteAttachmentStore.save` throw, the handler returns `rejected` with that
reason, and `acknowledgeDisposition` replies with it. The only change is wording —
make sure the rejection reason names the limit (it already does:
`exceeds its 10 MiB limit` / `exceed the 25 MiB total limit`).

### 4. Document it in `/help`

`src/remote/remoteHelpText.ts` — add a bullet to the **Notes** section (the section a
reader consults for "what can I send"), after the `/view` bullet:

> • You can send up to 3 images in one message (send them as a photo album). Each image
> is capped at 10 MiB and 25 MiB total; send more than 3 and I keep the first 3 and tell
> you.

`decorateHelpLine` already bolds the leading `• /command` pattern; a bullet that does
not start with a `/command` is returned unchanged, so this line needs no decorator
change.

The **native command menu** (`TELEGRAM_BOT_COMMANDS` in `TelegramChannel`)
is for _commands_, not limits, and each description is one short line — the cap does
not belong there. `/help` is the right home, per the "wherever you think is
appropriate" guidance.

---

## Files touched

| File                                   | Change                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/remote/TelegramInboundMapping.ts` | Add `media_group_id` to `TelegramUpdateSchema`; add exported `albumPhotoFromUpdate()` helper (reuses the existing `attachment()` builder). `telegramUpdateToEvent` is unchanged. |
| `src/remote/TelegramAlbumBuffer.ts`    | Album state, cap, retry-before-cursor flush, and typed coordinator dependencies.                                                                                                 |
| `src/remote/TelegramChannel.ts`        | Polling integration, overflow notice, and cursor callback; no duplicate album state machine.                                                                                     |
| `src/remote/remoteHelpText.ts`         | One Notes bullet documenting the cap + sizes.                                                                                                                                    |

**Not touched:** `types.ts` (the channel reads `media_group_id` off the parsed update,
not the event), `attachmentLimits.ts`, `RemoteAttachmentStore.ts`, the sidebar, and the
native command menu — the 10 / 25 MiB / 10-file limits are unchanged and still the
backstop.

---

## Test plan

Home: `test/unit/TelegramChannel.test.ts` (the existing mapping tests feed a
`getUpdates` response and assert the event the `onEvent` handler receives — the same
shape an album test needs).

1. **Single photo, no group** → one `text` event, one attachment, via the unchanged
   `telegramUpdateToEvent` path (regression: today's behaviour is preserved).
2. **Album of 2 in one batch** → _one_ `text` event with 2 attachments, not two events.
3. **Album of 3 in one batch** → one event, 3 attachments, no overflow notice.
4. **Album of 4 in one batch** → one event with 3 attachments **and** one `send` call
   whose text contains "limited to 3 images".
5. **Album followed by a plain text message in the same batch** → the album flushes
   before the text is handled; both events arrive, in order (album first).
6. **Two different albums in one batch** (group A then group B) → two events, one per
   group, in order (the different-group trigger flushes A before B starts).
7. **Cursor commits after the combined event** — assert one cursor save at the final
   update id, and no save before handling completes.
8. **`/help`** contains "3 images" and "10 MiB" (string assertion on `HELP_TEXT`).
9. **Oversize image** still yields a `rejected` disposition whose reason names the
   10 MiB limit (regression on the existing store path).
10. **Cross-batch album** (2 photos in batch 1, 1 in batch 2, same group) → one event
    with all 3 images, not a crash and not a lost update.

`npm run ci` green.

---

## Acceptance criteria

- [x] A Telegram photo album of ≤ 3 images (arriving in one batch) produces **one**
      prompt carrying all of them, not N separate prompts. _(Tests 2, 3)_
- [x] A single (non-album) photo behaves exactly as before: one prompt, one image, via
      the unchanged `telegramUpdateToEvent` path. _(Test 1 — regression)_
- [x] An album of > 3 images sends the first 3 and sends an in-chat notice stating the
      cap is 3. _(Test 4)_
- [x] The cap is enforced per album / per message, independent of the sidebar's 10-file
      limit; the shared `MAX_ATTACHMENTS_PER_PROMPT` is unchanged. _(Code review of
      `attachmentLimits.ts` — untouched)_
- [x] The durable cursor advances once after an album disposition, while the in-memory
      offset advances per update so a held album cannot spin the retry guard. _(Test 7)_
- [x] A message following an album in the same batch is not dropped or reordered — the
      album flushes first. _(Test 5)_
- [x] Two different albums in one batch produce two correctly-ordered events. _(Test 6)_
- [x] An oversize image (> 10 MiB) is rejected with a reason that names the 10 MiB
      limit, and a set exceeding 25 MiB total is rejected naming the total. _(Test 9 —
      regression on the existing store path)_
- [x] A cross-batch album remains one prompt while the group stays pending, without
      losing an update or spinning the loop. _(Test 10)_
- [x] `/help` states the 3-image cap and the 10 MiB / 25 MiB size limits. _(Test 8)_
- [x] `types.ts`, the native command menu, and `telegramUpdateToEvent` are unchanged.
      _(Code review)_
- [x] `npm run ci` is green.
