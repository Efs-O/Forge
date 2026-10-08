# History per-conversation files — make opening a past chat cheap

Status: planned 2026-10-08.

## Symptom

Picking a conversation from the history panel takes most of a second to respond.
Switching between already-open chats is instant.

## Measurement

This workspace's `<storageUri>/conversation-history.json` is **57.8 MB**: 38
conversations, the largest 8.2 / 7.4 / 7.2 MB (1,800–2,700 messages each).
Timed with Node on the real file:

| Step | Time |
|---|---|
| read + `JSON.parse` | 340 ms (startup only) |
| `JSON.stringify` of the whole history | 231 ms |
| write + rename | 275 ms |

## Why a restore pays for the whole file

`ConversationTabs.restore()` ends in `refreshUi()` (full, not `pointerOnly`),
which calls `saveSidebarSession` → `HistoryArchive.save(history, build)`.
`save` compares one signature for the *whole* list
(`id:updatedAt:title:messageCount` per entry, joined). A restore removes one
entry, so the signature changes and `save` rebuilds every remaining
conversation (`conversationToPersisted` ×37), stringifies ~58 MB and rewrites
the file — synchronously on the extension host, **before** `postSessionSync`
tells the webview anything. Closing a tab (one entry added) and the overflow
eviction past `MAX_HISTORY_CONVERSATIONS` pay the same.

The file is all-or-nothing by design (`SESSION_HISTORY_FILE_PLAN.md`); that
was right for getting history out of the memento, and wrong for edits that
touch one entry.

## Fix

Store each history conversation as its own file, so a change costs only the
entries that changed.

### Layout

`<storageUri>/history/<id>.json` — one `ConversationPersisted` per file, the
same schema the single file held per element. No index file: the directory
listing is the set of ids, and order comes from `updatedAt` (which
`saveSidebarSession` already sorts by). Ids are validated with the same rule
`ArchivedSessions` uses (`isSafeId` — export it from `ArchivedSessions.ts`, do
not copy it); an entry with an unsafe id makes `save` return `false`, so that
save keeps history in the memento, exactly like a failed write today.

`<storageUri>/archive/` (`ArchivedSessions`, the overflow tier) is unchanged.

### `HistoryArchive` changes (same owner file, same class name)

- Constructor keeps its signature: `filePath` is still the legacy
  `conversation-history.json` path (tests and `inStorageDir` pass it), and the
  body directory is `path.join(path.dirname(filePath), 'history')`.
- `private written = new Map<string, string>()` — per-id signature
  (`updatedAt:title:messageCount`) of what is on disk, replacing
  `writtenSignature`.
- `load()` → reads every `*.json` in `history/`, validates each with
  `conversationPersistedSchema`, seeds `written`. Returns `undefined` when
  neither the directory nor the legacy file exists (unchanged contract).
  - An unparsable or invalid body is renamed to
    `<id>.corrupt-<ms>.json.bad` (extension not `.json`, so it is never re-read),
    logged as an error, and skipped. **One bad body no longer empties all of
    history.** If it cannot be renamed, the archive sets `blocked` as today.
  - A directory that exists but cannot be listed sets `blocked` and returns `[]`.
- `save(history, build)` becomes:
  1. For each entry whose per-id signature differs from `written` (or is
     absent): `writeFileAtomicSync(history/<id>.json, JSON.stringify(entry))`,
     update `written`. `build` changes to `(conversation) => ConversationPersisted`
     so only changed entries are converted.
  2. Ids in `written` that are no longer in `history` are recorded as
     **pending removals** — not unlinked yet.
  3. Any write error → log, return `false` (the caller keeps history in the
     memento for that save, unchanged contract). Entries written before the
     error stay in `written`.
- New `pruneRemoved(): void` — unlinks every pending removal (ENOENT is
  success; any other error is logged and the id stays pending for the next
  save). `saveSidebarSession` calls it **after** the memento write.

  Why after: a restore moves an id from history to open tabs. Unlinking first
  and crashing before the memento write would lose that conversation outright
  — the current single-file design has exactly this window. Unlinking after
  means a crash leaves the body on disk *and* the id in the open tabs, which
  `loadSidebarSession` already de-duplicates (`history.filter(... open ...)`),
  and the next save prunes the orphan because `load()` seeded `written` with it.

  Implemented as: `persistMemento` resolves `true` once VS Code commits the
  memento `update()` (it is async) and `false` on rejection, and
  `pruneRemoved` runs only on `true`. "After the memento write" therefore means
  after it is committed, not after it is queued; a rejected write prunes
  nothing and the bodies stay the durable copy.

### Migration from `conversation-history.json`

- `load()`: if the legacy file exists, parse it as today (same quarantine
  rules) and **union** it with the directory by id, keeping the copy with the
  larger `updatedAt` (a tie keeps the directory copy). Every legacy-only entry is left out of `written`, so the
  next `save` writes it.
- After a `save` that wrote with no error while the legacy file exists, delete
  the legacy file. Union-on-load makes every crash point safe: a partial
  directory plus the legacy file loads the full set.
- Downgrade: an older build sees no `conversation-history.json`, shows empty
  history and may write a new one. On upgrade again the union brings both
  sets back; a chat deleted in the old build may reappear. Accepted.

### `saveSidebarSession` (sessionPersistence.ts)

Order becomes: overflow `put` for entries past the cap (unchanged) →
`archive.save` → memento write → `archive.pruneRemoved()`. Nothing else in the
persistence contract changes, including the "non-empty memento history wins"
rule in `loadHistory`.

`loadHistory` must call `archive.load()` **even when the memento's history
wins**, discarding the result, so `written` reflects the disk. Otherwise the
first save rewrites every body and bodies absent from the memento's history are
never pruned. (Today's code skips `load()` in that branch; with one file that
was harmless, with a directory it is not.)

### Out of scope (measure, do not change)

A restore still writes the open-tabs memento (`SESSION_KEY_V1`) and posts a
session sync. After this lands, time `refreshUi()` for a restore in the real
workspace and record the number here. If it is still above ~100 ms, the next
plan moves that write off the click path; this plan does not.

Startup still parses every history body (the same ~58 MB, now split). Lazy
loading of history bodies is a separate change.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `history/<id>.json` | `save` when the id's signature differs from `written` (new entry, or title/messages/updatedAt changed) | `pruneRemoved` after the memento write, for ids no longer in history (restore, overflow eviction past 40, permanent delete); VS Code removes `storageUri` with the workspace's storage | no switch; absent `storageUri` means no directory and history stays in the memento (unchanged) | `writeFileAtomicSync` temp + rename keeps the previous body whole; `save` returns false on error so the memento keeps history for that save | next `load` lists the directory and seeds `written`; an orphan whose id is open is filtered on load and pruned by the next save | none; bounded by `MAX_HISTORY_CONVERSATIONS` (40) |
| `history/` directory | first `save` that writes a body (`mkdirSync` recursive) | never by Forge; with the workspace's storage by VS Code | same as bodies | `mkdirSync` is atomic; an empty directory loads as empty history unless the legacy file or memento holds one | n/a, nothing in memory to lose | none |
| pending-removal set (in memory) | `save` notices an id gone from history | `pruneRemoved` after a successful unlink or ENOENT | n/a | n/a, in memory | lost; rebuilt by the next `load` (the orphan body is in `written` but not in history) and pruned by the next save | none |
| `history/<id>.json` `.forge-<pid>-<n>.tmp` sibling | inside `writeFileAtomicSync` | renamed over the target, or removed on failure | same as bodies | a crash between write and rename leaves an orphan tmp; `load` reads only `*.json`, so never parsed | same as crash | none; not swept, same as every `writeFileAtomicSync` user |
| `history/<id>.corrupt-<ms>.json.bad` | `load` finds an unparsable or schema-invalid body | never; kept for manual recovery | n/a | a failed rename is logged and sets `blocked`, so no save overwrites that body | n/a | none |
| legacy `conversation-history.json` | no longer created by this build | deleted after the first `save` that wrote with no error while it exists | n/a | union-on-load: if the delete never happened, the next start reads it again and the newer copy per id wins | same as crash | none; gone after one successful save |
| legacy `conversation-history.corrupt-<ms>.json` | as before (unparsable legacy file at load) | never | n/a | as before | n/a | none |
| memento `SESSION_KEY_V1` / `.history` | unchanged from `SESSION_HISTORY_FILE_PLAN.md` | unchanged | unchanged | unchanged; now written **before** any unlink | unchanged | none |

CI-enforced row: the delete row. A unit test in
`test/unit/HistoryArchive.test.ts` saves 3 conversations, removes one from
history, saves again, and asserts (a) no body file was written on the second
save (spy on `writeFileAtomicSync` or compare mtimes), (b) the removed body
still exists until `pruneRemoved()` runs, and (c) after a simulated crash
(load a fresh `HistoryArchive` before pruning) with the removed id among the
open tabs, `loadSidebarSession` returns it once (open) and the next save
removes the orphan body.

## Acceptance criteria

- Removing one conversation from history (restore) writes **no** body file and
  unlinks exactly one, after the memento write.
- Adding one conversation (tab close) writes exactly one body file.
- A tool-round `persistSession` with unchanged history writes nothing (as today).
- A legacy `conversation-history.json` loads intact, migrates to `history/` on
  the first save, and is then deleted; a crash before the delete loses nothing.
- One corrupt body is quarantined and logged; the other conversations load.
- A body write failure keeps history in the memento and logs an error (as today).
- Existing `HistoryArchive.test.ts` cases are kept or updated to the new layout,
  not deleted.
- `docs/OWNERS.md` row for `HistoryArchive.ts` describes the per-conversation
  directory.
- `npm run ci` green.
- Live: in this workspace after installing the VSIX, picking a history entry
  responds without a visible pause; the `refreshUi()` time for a restore is
  recorded in "Out of scope" above.
