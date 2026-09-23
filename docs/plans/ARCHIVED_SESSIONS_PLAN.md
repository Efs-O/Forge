# Archived sessions: keep every chat, list them like Claude Code

Status: implemented in three phases — 2026-09-23.

## Implementation notes

- `HistoryArchive` currently owns `conversation-history.json` and stores up to
  40 complete history bodies. `upsertHistoryConversation` is a pure in-memory
  transition; persistence happens through `saveSidebarSession`.
- Restore, rename, and delete are also pure `ConversationOps` transitions.
  File-backed archive reads and writes must be coordinated by their caller in
  `ConversationTabs` / `sessionPersistence`, then reflected in those transitions.
- The requested new `ArchivedSessions.ts` module will own only the overflow
  archive index and body files; the existing `HistoryArchive.ts` remains the
  owner of recent history.

## Problem

The history panel shows at most 40 chats per workspace, and the 41st archive
**deletes** the oldest for good: `upsertHistoryConversation`
(`src/sidebar/sessionPersistence.ts`) sorts and `.slice(0, MAX_HISTORY_CONVERSATIONS)`
with `MAX_HISTORY_CONVERSATIONS = 40` (`sessionTypes.ts`). The Forge and
HalluScribe workspaces are at exactly 40 now.

The cap cannot simply be raised. Every archived chat is held in memory with
its full `messages`, and `HistoryArchive.save` rewrites the whole
`conversation-history.json` whenever the history changes. That file is
**43 MB for 40 chats** in the Forge workspace (≈1 MB per chat), so 150 chats
would be ~160 MB rewritten on each archive.

The chats already dropped are recoverable: session log files are named by
conversation id (`~/.forge/sessions/<id>.jsonl`, 40 of 40 history ids match),
and 124 logs carry `workspace_path` = this Forge workspace (older logs have no
`workspace_path`).

Wanted (user screenshot, Claude Code style): the recent list as today, then a
collapsed **"Archived sessions (N)"** row at the bottom that expands to all the
older chats, each openable.

## Design

**Split the index from the bodies.**

- `conversation-history.json` keeps the full body of the most recent
  `MAX_HISTORY_CONVERSATIONS` (40) chats, exactly as today. That keeps the hot
  path (restore a recent chat), the memento fallback and today's file size
  unchanged.
- When a chat falls off the 40, `upsertHistoryConversation` stops deleting it:
  it is **evicted** to `<storageUri>/archive/<id>.json` (one file, written
  once with `writeFileAtomicSync`), and a meta row
  (`SessionHistoryMeta`-shaped: id, title, createdAt, updatedAt, messageCount,
  active_model) is appended to `<storageUri>/archive/index.json`.
- The webview gets `archived: SessionHistoryMeta[]` next to `history` in the
  session sync. `HistoryList` renders it as a collapsed
  "Archived sessions" row with a count badge; expanding it lists the rows
  (same `HistoryRow`, newest first).
- Opening an archived row: the host reads `archive/<id>.json`, moves the chat
  back into the recent history (so it becomes the newest), deletes the body
  file and its index row. Rename/delete work on archived rows too (delete
  removes both).
- **Backfill (one-time, per workspace):** on first load where
  `archive/index.json` is absent, list `~/.forge/sessions/*.jsonl` whose
  `session_start.workspace_path` matches this workspace and whose id is not in
  the recent history, and add them to the index as `source: 'log'` rows
  (title and time from `session_start`, no body file). Opening one rebuilds
  the messages from the JSONL (user/assistant/tool rows, deduplicated by the
  rules in CLAUDE.md, since pre-0.13.20 logs repeat themselves). Logs with no
  `workspace_path` are not guessed at.

No-folder windows (no `storageUri`) keep today's behaviour: the memento, capped
at 40, with no archive.

## Phases

1. **Evict, don't delete.** Archive store (`src/sidebar/ArchivedSessions.ts`:
   index + body files) and the eviction in `upsertHistoryConversation`;
   restore, rename and delete on archived ids in `ConversationOps`. No UI yet,
   but nothing is lost from this commit on.
2. **The panel.** `archived` in the session sync and `messageBridge`; the
   collapsed "Archived sessions (N)" section in `HistoryList`.
3. **Backfill from session logs.** Index rows with `source: 'log'`, rebuilt on
   open.

Each phase: `npm run ci` green, one commit, a CHANGES 0.16.41 bullet.

## State × lifecycle ledger

| Artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `archive/<id>.json` (body) | eviction of a chat from the recent 40 | restore (moves back to recent) or user Delete; VS Code removes `storageUri` with the workspace | none; no-folder windows never create it | `writeFileAtomicSync` temp+rename: whole old or whole new; body is written BEFORE its index row, so a crash leaves an orphan body, never a dangling row | nothing held open; next activation reads the index | none — kept until the user deletes it |
| `archive/index.json` | first eviction, or backfill on first load | never as a whole; rows removed on restore/delete | none | temp+rename; an orphan body (row missing) is re-indexed on load from its own id/title | next activation reloads it | none |
| index row `source: 'log'` | backfill | restore or user Delete; also dropped on load if its `.jsonl` is gone | none | same file as above | same | none; a log deleted outside Forge drops its row on load |
| recent history (`conversation-history.json`) | unchanged from SESSION_HISTORY_FILE_PLAN | unchanged | unchanged | unchanged | unchanged | bounded by 40 — now by **eviction**, not deletion |

CI row: a unit test that archives 41 chats and asserts the oldest is readable
from the archive (body + index row) — the regression that caused this plan.

## Acceptance criteria

- Archiving a 41st chat evicts the oldest to `archive/`, and it is listed under
  "Archived sessions" and opens with its full transcript.
- `conversation-history.json` stays bounded at 40 bodies; no whole-archive
  rewrite on any save.
- Restore, rename and delete work on archived rows; delete removes the body file.
- Backfill lists this workspace's older session logs once, and opening one
  shows its user/assistant/tool turns with duplicates removed.
- No-folder windows behave exactly as before.
- New module rows in `docs/OWNERS.md`; `npm run ci` green after each phase.
