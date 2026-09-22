# Session history file — take the chat archive out of workspaceState

Status: implemented 2026-09-22 (0.16.34).

## Symptom

The whole VS Code window lags while Forge runs a turn — typing, scrolling,
switching editors — not just the Forge sidebar.

## Measurement

CDP profile of the workbench renderer (`remote-debugging-port`) during an agent
turn: the page was 25.6% JS-busy, dominated by `setExtensionState` and IPC
deserialization. VS Code itself logged:

```
large extension state detected (Efsoo.forge-llm) 44375kb
```

This workspace's Forge state was 45.5 MB: 1.35 MB of open tabs, the rest the
40 archived conversations (`history`).

## Why every save costs the full 45 MB

The extension-host Memento does not send a changed key. `update(key, value)`
sends the extension's *entire* workspaceState object to the renderer, which
JSON-stringifies it and writes it to `state.vscdb`. Forge calls
`persistSession()` after every tool round (`setTranscriptChangedListener` in
`sidebarWiring.ts`), so every round shipped and re-serialized the archive,
though the archive only changes when a tab is closed or cleared. The earlier
pointer-only fix (`SIDEBAR_SWITCH_LATENCY_PLAN.md`) did not help here: even a
one-string `ACTIVE_ID_KEY` update ships the whole object.

## Fix

`history` moves to its own file, `<context.storageUri>/conversation-history.json`,
owned by `src/sidebar/HistoryArchive.ts`.

- `saveSidebarSession(state, session, archive)` hands `session.history` to the
  archive first, then writes the memento session **without** `history`.
- The archive writes the file (atomic replace) only when the history's
  signature — `id:updatedAt:title:messageCount` per entry — changed since its
  last write or load. A tool round in an open tab costs a string compare.
- If the file write throws, the error is logged and that save keeps `history`
  in the memento, so nothing is ever dropped because the disk refused a write.
- `loadSidebarSession(state, archive)` uses the memento's `history` when the
  record still carries a non-empty one (an empty one, saved while the file was
  unreadable, must not erase the file's archive) (a pre-0.16.34 record, a downgrade that wrote one
  since, or a save whose file write failed — in every case the memento copy is
  the newer), otherwise the file. The next save then moves it to the file.
- An unparsable file is renamed to `conversation-history.corrupt-<ms>.json`,
  logged as an error, and history loads empty. Never deleted. If the file can
  be neither read nor renamed, it is left untouched and the archive refuses
  every save for that session, so history stays in the memento rather than an
  empty list overwriting the only old copy.
- No `storageUri` (no folder open) or no archive passed (tests): behaviour is
  exactly the old in-memento one.

`buildSessionSyncMessage` sends only history metadata to the webview, so
nothing changes there.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `conversation-history.json` | first save whose history signature differs from the last written one (including the first save after migration) | never deleted by Forge; an empty history writes `[]`; VS Code removes `storageUri` with the workspace's storage | no switch; absent `storageUri` means it is never created and history stays in the memento | `writeFileAtomicSync` writes a temp file and renames, so the old file stays whole; the memento is written after the file, so a crash between them leaves a memento without the new entry but the file has it | next activation loads it; the signature cache is in-memory, so the first save rewrites it once | none; bounded by `MAX_HISTORY_CONVERSATIONS` (40) |
| its `.forge-<pid>-<n>.tmp` sibling | inside `writeFileAtomicSync` | renamed over the target on success; removed by `writeFileAtomicSync` on failure | same as the file | a crash between write and rename leaves an orphan tmp; harmless, never read | same as crash | none (orphans are not swept; same as every other `writeFileAtomicSync` user) |
| memento `SESSION_KEY_V1` (now without `history`) | every `persistSession` | never; overwritten | same as before this plan | VS Code owns memento durability | VS Code flushes on shutdown | none |
| memento `SESSION_KEY_V1.history` (legacy) | pre-0.16.34 builds, or a save whose file write failed | dropped by the next save whose file write succeeds | n/a | if the file write fails, the memento keeps history — never lost | loaded on next start and preferred over the file | none |
| `conversation-history.corrupt-<ms>.json` | load finds an unparsable file | never; kept for manual recovery | n/a | a failed rename is logged, history loads empty, and the archive refuses saves for the session, so the unreadable file is never overwritten; history stays in the memento | n/a | none |

CI-enforced row: the migration row. `test/unit/HistoryArchive.test.ts` loads a
memento carrying `history`, saves, and asserts the memento no longer carries it
and the file does — and that a failing file write keeps it in the memento.

## Acceptance criteria

- A tool-round `persistSession` with unchanged history writes no file and puts
  no `history` into the memento.
- An old record with memento `history` loads intact and migrates on first save.
- A file write failure keeps history in the memento and logs an error.
- A corrupt file is quarantined, logged, and history loads empty.
- `npm run ci` green; after install, VS Code no longer logs "large extension
  state detected" for Forge in this workspace.
