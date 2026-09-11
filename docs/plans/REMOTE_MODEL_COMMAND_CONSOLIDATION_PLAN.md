# Remote /model command consolidation

## Problem

Two visible commands do overlapping work:

- `/models` — lists models; `/models <n>` pages.
- `/model <n-or-name>` — pins a model to this chat.
- `/model` (bare) — **already lists** (it calls `sendModelSelection(event, context, undefined)`).

So `/model` is already the unified command. `/models` only adds a hidden page
argument, and the model page footer prints a redundant line:

```
Use /model <number>. Page fallback: /models <page>. Selection expires in 10 minutes.
```

On Telegram the page is navigated by the inline `◀ Previous` / `Next ▶`
keyboard, so the `Page fallback: /models <page>.` text is dead weight there.

## End state

One visible command:

- `/model` (bare) → list models.
- `/model <n-or-name>` → pin a model to this chat.

`/models` becomes a **silent alias** (hidden from `/help` and the Telegram
native menu), matching the existing `/list` → `/chats` and `/select` → `/chat`
convention. It still answers, so muscle memory and old screenshots keep
working.

The `Page fallback: /models <page>.` line is printed **only on transports
without a keyboard** (`selectionPages` undefined). Telegram has a keyboard, so
it never sees the line; WhatsApp (plain text, no keyboard) keeps it as its only
pager.

## Why `/models` is kept as an alias, not removed

`BaileysWhatsAppChannel` has no `selectionPages`, so it renders the model list
as plain text with no keyboard. For a list longer than one page the
`Page fallback: /models <page>.` line is the only way to page it. Removing
`/models` would break WhatsApp paging. Keeping it as a hidden alias is the
`/list`/`/select` pattern already in the codebase.

## Changes

### 1. `src/remote/TelegramChannel.ts`
Remove `{ command: 'models', description: 'List configured models' }` from
`TELEGRAM_BOT_COMMANDS`. The menu stays sorted (`model` precedes `new`).

### 2. `src/remote/remoteHelpText.ts`
- Models section line:
  - before: `Models: /models [page] · /model [n-or-name] · /unload · /restart`
  - after:  `Models: /model [n-or-name] · /unload · /restart`
- Note line (also fixes a stale claim — bare `/model` lists, it does not
  report the pinned model):
  - before: `• /model with no argument reports the pinned model, /models lists them, /restart restarts the running backend`
  - after:  `• /model lists the configured models, and /model <number-or-name> pins one to this chat; /restart restarts the running backend`

### 3. `src/remote/RemoteSelectionPager.ts`
In `renderPage`, gate the page-fallback line on the transport having no
keyboard, so Telegram (which has one) drops the redundant text:

```ts
const fallback =
  pages > 1 && kind !== 'workspaces' && !context.channel.selectionPages
    ? ` Page fallback: ${commandFor(kind)} <page>.`
    : '';
```

`commandFor('models')` still returns `/models` (the alias still pages), so the
line stays correct for plain-text transports.

### 4. `test/unit/RemoteRichText.test.ts`
Add `/models` to `UNDOCUMENTED_ALIASES` and update the comment. The
command-map test greps the handler for `command === '/models'` (the alias
dispatch stays), so without this the menu test would fail on `/models` being
implemented but absent from the menu.

### 5. `test/unit/RemoteSelectionPager.test.ts`
- Assert the model page footer does **not** contain `Page fallback` on a
  keyboard transport (`FakeRemoteChannel` has `selectionPages`).
- Assert it **does** contain `Page fallback: /models <page>.` on a plain-text
  transport (a channel without `selectionPages`) with more than one page.

## Acceptance criteria

- [x] `/model` (bare) lists models — unchanged, verified by existing test.
- [x] `/model <n-or-name>` pins a model — unchanged, verified by existing test.
- [x] `/models` still lists (hidden alias) — verified by existing `/models 2` page test.
- [x] `/models <page>` still pages on a plain-text transport — verified by new test.
- [x] The model page footer omits `Page fallback` on a keyboard transport (Telegram) — verified by new test.
- [x] The model page footer keeps `Page fallback: /models <page>.` on a plain-text transport (WhatsApp) — verified by new test.
- [x] `/help` no longer documents `/models`; documents `/model` for both list and pin — verified by `RemoteRichText` help test.
- [x] The Telegram native menu no longer offers `models`; stays sorted — verified by `RemoteRichText` menu test.
- [x] The command-map test (implemented ⊆ help, implemented ⊆ menu, and the reverse) passes with `/models` in `UNDOCUMENTED_ALIASES` — verified by `RemoteRichText` command-map tests.
- [x] `npm test` passes.
