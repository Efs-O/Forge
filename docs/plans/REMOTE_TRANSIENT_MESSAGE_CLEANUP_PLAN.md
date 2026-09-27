# Remote transient-message auto-delete (auth, rejections, album overflow)

Follow-up to the already-committed "got it" 10s auto-delete. Extends the same
`CommandCleanupScheduler` machinery to the remaining non-command Telegram
messages that currently linger, per the user's decision: **auto-delete A + B +
C; keep D + E.**

## Goal

Telegram accumulates persistent non-command messages that are transient
operational notices, not content. Make them auto-delete like the command
replies already do, reusing the existing `CommandCleanupScheduler` (no new
timer, no new config knob).

## Scope

**AUTO-DELETE (this plan):**

- **A. Auth / pairing lifecycle** — six messages sent in
  `RemoteController.handle()`, currently `await this.channel.send(...)` with the
  returned ids discarded:
  1. `Forge remote pairing complete.`
  2. Auth challenge: `Forge: <authentication required | session expired after N min idle>…`
  3. `Forge: authentication failed.`
  4. `Forge: authenticated.`
  5. `Forge: running your held prompt — …`
  6. `Forge: remote session locked.`
- **B. Operational rejection reasons** — sent via
  `acknowledgeTelegramDisposition` when a disposition is `rejected`. Marked
  `ephemeral: true` at the source so only operational rejections (not
  contact-service refusals) are deleted:
  - `RemoteController.handle()`: `invalid remote event`, `private chats only`,
    `sender is not paired`, `remote authentication is temporarily locked`,
    `remote authentication is required`, `remote rate limit exceeded`,
    `message exceeds configured limit`.
  - Voice handling: both disabled paths (`RemoteController.handle()` when the
    bridge is absent and `RemoteVoiceBridge.handle()` when settings disable
    voice), the duration-limit rejection, `this channel cannot download voice
    notes`, and `voice note is too large`.
- **C. Album overflow notice** — sent in `TelegramChannel`'s `onOverflow`:
  `Forge: albums are limited to 3 images per message — …`.
- **(Already done, preserved)** the `got it` queued acknowledgement — fixed
  10s via `armAfter`. This plan generalizes the channel→controller callback it
  introduced (see Method §1, §5).

**KEEP (not auto-deleted):**

- **D. Contact service** — both its direct sends (`Only /owner is available to
  contacts.`, `Forge: authenticate with the owner privately first.`,
  `contactGroupStrangerText()`, …) and its rejection reasons
  (`contactPrivateText()`, `contactGroupRequiredText()`, `contact callback is
  owner-only`, `only text is supported in contact groups`, `sender is not the
  contact bound to this group`, `contact command is not available`, `owner
  session is not authenticated`). The contact service does NOT set
  `ephemeral: true`, so none of its messages are armed.
- **E. Host-originated content** — compaction lines, `notify_user`, "chat
  cleared", mirrored answers, `Forge request failed: …`, backend restart.
- Approval prompts, question prompts, selection pages (button messages —
  deleting would strand the action), progress bubbles (edited in place), and
  voice/photo media.
- Other rejected dispositions not listed under B remain unchanged and are not
  auto-deleted. This is an explicit allowlist; adding a rejection to B requires
  marking its source disposition `ephemeral: true`.

## Delay decision

- `got it` (queued): **fixed 10s** (`QUEUED_ACK_DELETE_SECONDS`), via
  `armAfter`. Preserved from the committed feature.
- **A, B, C: `delete_command_replies_after`** (live read via the existing
  `replyDelaySeconds()` callback), via `armEphemeral`. No new config knob.
  Currently `20` in the active config, default `10`.
This is the selected behavior: transient notices follow the existing
configurable reply-retention setting; only the queued acknowledgement uses its
separate fixed 10-second window.

## Method

1. **`src/remote/types.ts`**
   - `RemoteInboundDisposition`: add `ephemeral?: boolean` to the
     `{ kind: 'rejected'; reason: string }` variant.
   - Add `export type EphemeralKind = 'queued' | 'transient';`.
   - `RemoteChannel`: rename `setEphemeralAcknowledgementHandler?` →
     `setEphemeralMessageHandler?`, signature
     `(chatId: string, messageIds: string[], kind: EphemeralKind) => void`.
2. **`src/remote/RemoteController.ts`**
   - In `handle()`, for each of the six auth sends (A), capture the returned
     ids and arm: `const ids = await this.channel.send(...); this.commandCleanup.armEphemeral(event.chatId, ids ?? []);`.
   - Mark the seven operational rejections (B) `ephemeral: true` on the
     returned disposition.
   - Also mark the voice-disabled rejection in the `!this.voice` branch
     `ephemeral: true`; this path does not enter `RemoteVoiceBridge`.
   - Replace `armAcknowledgement(chatId, ids, delaySeconds)` with
     `armEphemeralMessage(chatId, ids, kind)` that dispatches:
     `kind === 'queued'` → `commandCleanup.armAfter(chatId, ids,
     QUEUED_ACK_DELETE_SECONDS)`; else → `commandCleanup.armEphemeral(chatId,
     ids)`. Import `QUEUED_ACK_DELETE_SECONDS` from `./TelegramAcknowledgement`.
3. **`src/remote/RemoteVoiceBridge.ts`** — mark each of its four rejected
  dispositions (voice disabled, duration limit, missing download capability,
  and oversize note) `ephemeral: true`.
4. **`src/remote/TelegramAcknowledgement.ts`**
   - Change the `onEphemeral` callback to
     `(chatId, messageIds, kind: EphemeralKind) => void`.
   - Queued disposition → `onEphemeral(chatId, ids, 'queued')`.
   - Rejected disposition with `ephemeral: true` → `onEphemeral(chatId, ids,
     'transient')`.
   - Rejected disposition without the flag → do NOT call (D stays).
5. **`src/remote/TelegramChannel.ts`**
   - Rename `ephemeralAckHandler` → `ephemeralMessageHandler`; rename
     `setEphemeralAcknowledgementHandler` → `setEphemeralMessageHandler`
     (kind-based).
   - `acknowledgeDisposition`: pass the kind-based handler to
     `acknowledgeTelegramDisposition`.
   - `onOverflow` (C): capture the sent ids and call
     `this.ephemeralMessageHandler?.(event.chatId, ids, 'transient')`.
6. **`src/remote/RemoteTransportManager.ts`** — wire
   `channel.setEphemeralMessageHandler((chatId, ids, kind) =>
   controller.armEphemeralMessage(chatId, ids, kind))`.

Dedup key spaces stay disjoint: `armEphemeral` uses `ephemeral:<id>`,
`armAfter` uses `after:<id>`, `trackReplies` uses `reply:<id>` — no collision.

## State × lifecycle ledger

**No durable state.** This feature writes nothing that outlives the process:

- The deletes are in-memory `setTimeout`s owned by `CommandCleanupScheduler`
  (the same timers the committed `got it` and the existing `armEphemeral`
  unload-broadcast path use). A restart cancels them via `dispose()`; any
  already-sent message simply stays (the known best-effort limit, shared with
  command-reply cleanup).
- The `ephemeral?: boolean` on the rejected disposition is a transient
  in-memory value (returned by `handle()`, consumed by
  `acknowledgeTelegramDisposition`, never persisted).
- No new config field (reuses `delete_command_replies_after`), no new file,
  registry, or scheduler entry.

Known best-effort limit (same as the existing cleanup paths): if Telegram
accepts the message but Forge crashes between `channel.send` and arming the
delete, that one message is not deleted.

## Acceptance criteria

- [ ] `RemoteInboundDisposition` rejected variant accepts `ephemeral?:
  boolean`; existing rejection sites (no flag) still type-check —
  `npm run type-check`.
- [ ] Each of the six auth messages (A) arms `armEphemeral` with its sent ids —
  `RemoteController` handle test (table-driven over the six).
- [ ] An operational rejection (B, e.g. `remote rate limit exceeded`) is
  returned with `ephemeral: true` and arms deletion — controller +
  `TelegramChannel` test.
- [ ] A contact-service rejection (D, e.g. `contactPrivateText()`) is returned
  WITHOUT `ephemeral` and does NOT arm deletion — `TelegramContacts.test.ts`
  regression guard (the "keep D" invariant).
- [ ] The controller's voice-disabled fallback and all four rejected
  dispositions from `RemoteVoiceBridge` (B) carry `ephemeral: true`; verify
  that Telegram acknowledgement arms deletion for each path.
- [ ] Album overflow (C) arms `armEphemeral` with the sent ids —
  `TelegramChannel` test.
- [ ] `RemoteTransportManager` registers the kind-based handler and routes
  `queued` and `transient` notifications to `RemoteController.armEphemeralMessage`
  — focused transport-manager test (or an existing lifecycle test extended to
  assert this wiring).
- [ ] `armEphemeralMessage` dispatch: `'queued'` → `armAfter` at
  `QUEUED_ACK_DELETE_SECONDS` (10s); `'transient'` → `armEphemeral` at the
  live `replyDelaySeconds()` — `RemoteCommandCleanup.test.ts`.
- [ ] The committed `got it` behaviour is preserved: the existing
  `TelegramChannel.test.ts` "arms the queued got it acknowledgement…" test
  (updated to the kind-based `setEphemeralMessageHandler`) still asserts a 10s
  arm.
- [ ] An empty message-id list (`[]`) is a no-op and does not throw; the
  `RemoteChannel.send` contract returns `string[]`, so no `void` result is
  expected.
- [ ] Final repository gates pass: `npm run ci` and `npm run package`.
