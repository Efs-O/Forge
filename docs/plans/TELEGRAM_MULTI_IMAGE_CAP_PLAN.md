# Telegram: up to 3 images per message, with cap + size surfaced to the user

Status: **proposed** (2026-09-12). For review — nothing implemented yet.

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
*same* image. The inbound mapping takes only the largest variant and emits **one**
attachment:

- `src/remote/TelegramInboundMapping.ts:134-152` — `const photo = message.photo?.at(-1)`
  → `attachments: [attachment]`. Never more than one.
- There is **no `media_group_id` handling anywhere** (searched: zero matches). When a
  user sends a photo *album*, Telegram delivers each photo as a **separate update**
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
lives in `TelegramChannel.poll()` (`src/remote/TelegramChannel.ts:268-320`), which
already owns per-update state (`retryingUpdateId`, offset). The inbound-shape decision
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

Add a private field to `TelegramChannel`:

```ts
private pendingAlbum:
  | {
      mediaGroupId: string;
      photos: Array<{ name: string; mediaType: string; providerFileId: string }>;
      firstText: string;        // caption/text of the first update in the group
      firstMessageId: number;   // providerMessageId for the flushed event
      chatId: string;
      senderId: string;
      chatType: RemoteInboundEvent['chatType'];
      receivedAt: number;       // first photo's date * 1000
      overflow: boolean;        // true once a 4th photo in this group is seen
    }
  | undefined;
```

In the poll loop, for each parsed `update`, **before** the existing
`telegramUpdateToEvent` call:

- If `albumPhotoFromUpdate(update)` is defined (an album photo):
  - If `pendingAlbum` is `undefined` or its `mediaGroupId` differs → flush the old
    one, start a new `pendingAlbum` from this photo.
  - Else append. If the group already holds `MAX_TELEGRAM_IMAGES_PER_MESSAGE` (3)
    photos, set `overflow = true` and **do not** append the extra photo.
  - Advance the offset for this update and `continue` — **do not** emit an event yet.
- Otherwise (any non-album update): flush `pendingAlbum` first, then fall through to
  the existing `telegramUpdateToEvent` path unchanged.

**After the `for` loop over the batch**, flush `pendingAlbum` if set. This is the
primary trigger: an album's photos arrive as a burst in one `getUpdates` batch, so
flushing at the end of the batch emits the merged event with no waiting, and an album
that is the only thing sent is not held until the next message.

**Flush** (`flushAlbum()`): build one `text` event with `attachments` = the buffered
photos (≤ 3), `text` = `firstText`, and the stored `chatId` / `senderId` /
`chatType` / `receivedAt` / `firstMessageId`. Call `this.handler(event)` and run
`acknowledgeDisposition` on it, exactly as a normal text event. If `overflow` was set,
also send the overflow notice (see §3). Then clear `pendingAlbum`.

#### 2.1 Flush timing — the one subtlety

Album photos are separate updates, but they land in the **same `getUpdates` batch**
(Telegram sends an album as a burst, and the poll returns everything accumulated). So
three triggers cover the real cases with **no timer**:

1. **End of batch** — the normal case; the album is complete and emitted immediately.
2. **A non-album update arrives** — the album is done; flush before handling it.
3. **An album photo with a different `media_group_id` arrives** — the previous album
   is done; flush before starting the new group.

**Known limitation (accepted):** if an album's photos happen to split across two
`getUpdates` batches, the first batch's end-of-batch flush emits a partial album and
the second batch starts a new one — the album degrades to two prompts, which is
exactly today's behaviour for that (rare) case. A wall-clock window to merge them
would add a timer and a held-event delay for a case that already degrades safely, so
it is deliberately not added.

**Offset is advanced per update as it is today** (each album photo is consumed and its
offset saved immediately, even though the event is emitted once on flush). Holding the
*event emission* — not the offset — means a crash mid-album loses at most one album,
and never spins the poll loop: the offset always moves forward, so the
`MAX_UPDATE_RETRIES` guard at `src/remote/TelegramChannel.ts:285-295` still has a
moving offset to work with.

### 3. The cap and the live notify

New constant, next to the existing ones in `src/remote/TelegramChannel.ts`
(or `TelegramInboundMapping.ts` if it is used only there):

```ts
export const MAX_TELEGRAM_IMAGES_PER_MESSAGE = 3;
```

When `flushAlbum()` fires with `overflow = true`, the handler is called with the 3
images, **and** the channel sends one extra notice to the chat:

> `Forge: albums are limited to 3 images per message — I kept the first 3. Each image
> is capped at 10 MiB, 25 MiB total.`

This is a direct `this.send(event.chatId, notice, { signal })` — the same primitive
`acknowledgeDisposition` (`src/remote/TelegramChannel.ts:345-390`) uses internally, so
it respects the per-chat send queue and the 4096-char chunking. It **cannot** go
through `acknowledgeDisposition` itself: that method only emits text for `queued` and
`rejected` dispositions, and the 3 kept images *are* a valid prompt (they get their own
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

The **native command menu** (`TELEGRAM_BOT_COMMANDS`, `src/remote/TelegramChannel.ts:28-57`)
is for *commands*, not limits, and each description is one short line — the cap does
not belong there. `/help` is the right home, per the "wherever you think is
appropriate" guidance.

---

## Files touched

| File | Change |
| --- | --- |
| `src/remote/TelegramInboundMapping.ts` | Add `media_group_id` to `TelegramUpdateSchema`; add exported `albumPhotoFromUpdate()` helper (reuses the existing `attachment()` builder). `telegramUpdateToEvent` is unchanged. |
| `src/remote/TelegramChannel.ts` | `MAX_TELEGRAM_IMAGES_PER_MESSAGE`; `pendingAlbum` field; per-update buffering + `flushAlbum()`; overflow notice via `this.send`; flush on end-of-batch / non-album / different-group. |
| `src/remote/remoteHelpText.ts` | One Notes bullet documenting the cap + sizes. |

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
2. **Album of 2 in one batch** → *one* `text` event with 2 attachments, not two events.
3. **Album of 3 in one batch** → one event, 3 attachments, no overflow notice.
4. **Album of 4 in one batch** → one event with 3 attachments **and** one `send` call
   whose text contains "limited to 3 images".
5. **Album followed by a plain text message in the same batch** → the album flushes
   before the text is handled; both events arrive, in order (album first).
6. **Two different albums in one batch** (group A then group B) → two events, one per
   group, in order (the different-group trigger flushes A before B starts).
7. **Offset advances on every album photo** even though the event is emitted once —
   assert `setCursor` is called per update, not just per emitted event.
8. **`/help`** contains "3 images" and "10 MiB" (string assertion on `HELP_TEXT`).
9. **Oversize image** still yields a `rejected` disposition whose reason names the
   10 MiB limit (regression on the existing store path).
10. **Cross-batch album** (2 photos in batch 1, 1 in batch 2, same group) → two events
    (the accepted degradation, §2.1), not a crash and not a lost update.

`npm run ci` green.

---

## Acceptance criteria

- [ ] A Telegram photo album of ≤ 3 images (arriving in one batch) produces **one**
      prompt carrying all of them, not N separate prompts. *(Tests 2, 3)*
- [ ] A single (non-album) photo behaves exactly as before: one prompt, one image, via
      the unchanged `telegramUpdateToEvent` path. *(Test 1 — regression)*
- [ ] An album of > 3 images sends the first 3 and sends an in-chat notice stating the
      cap is 3. *(Test 4)*
- [ ] The cap is enforced per album / per message, independent of the sidebar's 10-file
      limit; the shared `MAX_ATTACHMENTS_PER_PROMPT` is unchanged. *(Code review of
      `attachmentLimits.ts` — untouched)*
- [ ] The poll-loop offset advances on every album photo update, so a held album can
      never spin the `MAX_UPDATE_RETRIES` guard. *(Test 7)*
- [ ] A message following an album in the same batch is not dropped or reordered — the
      album flushes first. *(Test 5)*
- [ ] Two different albums in one batch produce two correctly-ordered events. *(Test 6)*
- [ ] An oversize image (> 10 MiB) is rejected with a reason that names the 10 MiB
      limit, and a set exceeding 25 MiB total is rejected naming the total. *(Test 9 —
      regression on the existing store path)*
- [ ] A cross-batch album degrades to two prompts (the accepted limitation) without
      losing an update or spinning the loop. *(Test 10)*
- [ ] `/help` states the 3-image cap and the 10 MiB / 25 MiB size limits. *(Test 8)*
- [ ] `types.ts`, the native command menu, and `telegramUpdateToEvent` are unchanged.
      *(Code review)*
- [ ] `npm run ci` is green.
