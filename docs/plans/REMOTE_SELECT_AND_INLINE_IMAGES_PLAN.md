# Remote `/select` loop, `/ratelimit`, command rename, and inline images

Status: implemented (2026-09-07). `npm run ci` green: 2013 tests.

Two unrelated reports, planned together because both were opened in the same
session:

1. Telegram answered every `/select 1` with `remote rate limit exceeded`.
2. Images sent to Forge never appear in the chat transcript.

---

## Part 1 — Why `/select 1` reported a rate limit

`remote.rate_limit_per_minute` is 30 per chat per 60 s
(`src/config/schema.ts:240`, `src/remote/RemoteRateLimiter.ts`). Four user
messages across 24 minutes cannot exhaust it. The audit log
(`globalStorage/efsoo.forge-llm/remote-audit-v1.json`) says what actually
happened:

```
12:13:27  inbound            <- one /select 1 from the phone
12:13:28  inbound x5
12:13:29  inbound x10
12:13:30  inbound x10
12:13:31  inbound x3         <- 30 hits; limiter trips; the burst stops
```

Identical bursts at 12:14, 12:26 and 12:37 — one per `/select`.

**Mechanism.** `/select <n>` calls `host.restoreConversation`
(`RemoteCommandHandler.ts:253`), which throws when the tab cannot be restored:
`ForgeHostFacade.restoreConversation` throws `Forge: conversation could not be
restored.` whenever `ConversationTabs.restore` returns undefined — the
`MAX_CONVERSATIONS = 12` cap, or an id not in history. The Telegram poll loop
turns *any* thrown handler error into `{ kind: 'retry' }` and then `break`s
**without advancing the getUpdates offset** (`TelegramChannel.ts:263-295`).
Telegram redelivers the same update immediately, it throws again, and the loop
spins. The rate limiter is the only thing that stops it: once it starts
returning `rejected`, the offset advances and the burst ends.

So the reported error is the brake, not the fault. Raising the limit makes it
worse. Three fixes, in this order:

### 1.1 Surface the real failure (`RemoteCommandHandler.ts`)
Wrap the `/select` / `/resume <n>` restore in try/catch and return
`{ kind: 'rejected', reason }` carrying the host's message. A rejected
disposition advances the offset, so this alone kills the loop for this command
and tells the user "maximum open conversations" on the first try.

### 1.2 Bound retry redelivery (`TelegramChannel.ts`)
A `retry` must not be able to spin forever on one update. Track
`update_id -> attempts`; after `MAX_UPDATE_RETRIES` (3) convert the disposition
to `rejected` with the last error text and advance the offset. This is the
general guard — 1.1 fixes one command, this fixes every future one.

### 1.3 `/ratelimit [n|off]`
Modelled one-for-one on `/timeout` (`RemoteCommandHandler.ts:120-147` +
`extension.ts:323`): a `setRateLimit?: (perMinute: number) => Promise<void>`
context callback that writes `remote.rate_limit_per_minute` through
`updateConfigFile` and re-applies the config. `off` maps to the schema maximum
(600), because a real ceiling still bounds a runaway loop; a true "off" would
remove the only backstop the poll loop has. Bare `/ratelimit` reports the
current value.

`RemoteController` rebuilds its limiter on `applyOptions`, so the new value
takes effect on the next message with no reload.

### 1.4 Rename `/list` and `/select`
`/select` does not say what it selects, and `/list` does not say what it lists.
Rename to the plural-lists / singular-picks shape `/models` + `/model` already
uses:

- `/chats [page]` — new name for `/list`
- `/chat <n-or-id>` — new name for `/select`

`/list` and `/select` stay as undocumented aliases (muscle memory, and the
selection pager's own prompt text). `selectSession` was rejected: camelCase
matches no other command, and "session" already means the *authenticated remote
session* that `/lock` and `/timeout` operate on — reusing it for conversation
tabs would collide.

### 1.5 Help ordering
The Notes bullets in `remoteHelpText.ts` are in no order at all. Reorder them to
follow the command map above them (Session -> Workspace -> Queue -> Models ->
Window -> Machine) rather than alphabetically: the section list is already the
reader's index, so two different orders on one screen is the actual defect.

---

## Part 2 — Images in the transcript

Today an image sent to Forge is invisible. Worse, it is *lost*: a user turn with
an attachment has array `content`, and `displayPersistMessages`
(`sessionProjections.ts:78-84`) drops any user message whose content is not a
string — so after a reload the prompt text disappears from the transcript too.

### 2.1 Constraint
`slimPersistMessages` deliberately strips image parts: base64 pixels must never
land in `workspaceState`. So the transcript stores a **reference**, not data.

### 2.2 Storage — `ChatAttachmentStore`
New owner: `src/sidebar/ChatAttachmentStore.ts`. Writes to
`globalStorageUri/attachments/<conversationId>/<uuid><ext>`, returns
`{ name, mediaType, bytes, relativePath }`. globalStorage rather than the
workspace so nothing lands in a user's repo (`.forge/remote-inbox` is the
remote-only precedent and stays as it is). Saved in `SendPipeline.send` before
`runTurn`, so webview sends, remote sends and queue drains all get it.

Pruning: on activation, delete attachment directories whose conversation id is
in neither `conversations` nor `history`.

### 2.3 Carrying the reference
- `ChatMessage.attachments?: ChatAttachmentRef[]` — a Forge-only extra, like
  `reasoning` / `toolMs`, ignored by every provider serializer.
- `slimMsgSchema` gains an optional `attachments` array so it survives a reload
  (metadata only, no pixels), and `chatMessagesFromSlim` restores it.
- `displayPersistMessages` stops dropping array-content user turns: it takes
  their text via `textContent` and emits `attachments`.

### 2.4 Rendering
- `AppMessage.attachments?: MessageAttachment[]` where `src` is either a
  `data:` URL (the live local echo, which still holds the bytes) or a webview
  URI built from an attachments root shipped once in `sessionSync`.
- New `MessageAttachments` component: a row of ~120px thumbnails under the user
  bubble for images, a compact file chip for everything else. Reuses
  `AttachmentTray`'s `shortenName` / `sizeLabel`.
- Click posts `openAttachment { relativePath }`; the host resolves it under the
  attachments root (path-escape checked, like `RemoteAttachmentStore.load`) and
  runs `vscode.open`, which opens VS Code's own image preview.
- CSP already allows `data:` and `${cspSource}` images; only
  `localResourceRoots` needs the attachments directory added
  (`SidebarProvider.ts:263`).

---

## Test plan
- `RemoteRateLimiter` / `/ratelimit` parse + config write.
- Poll loop: a handler that always throws advances the offset after 3 attempts.
- `/chat` on an unrestorable id returns `rejected`, not `retry`.
- `displayPersistMessages` keeps an array-content user turn and its refs.
- `ChatAttachmentStore` round-trip + path-escape rejection.
- `npm run ci`.
