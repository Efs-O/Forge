# Chat cap: evict un-kept chats without losing Undo, say why when nothing can go, stop the bus lying

Status: **revised 2026-10-01 after review — change 1 simplified; implementing.**

Three defects at `MAX_CONVERSATIONS = 12`, one root cause: the eviction gate
treats "nobody pressed Keep or Undo yet" as "busy", and the refusal it produces
is both a lie and a silent drop.

---

## 1. The problem, with evidence

| # | Fact | Evidence |
|---|---|---|
| 1 | The cap is 12 open chats | `src/sidebar/sessionTypes.ts:27` — `export const MAX_CONVERSATIONS = 12;` |
| 2 | At the cap, `create()` archives the least recently active chat that the caller proves idle | `src/sidebar/ConversationTabs.ts:112-121` → `archiveLeastRecent` at `:300-310` → `opArchiveLeastRecent` (`src/sidebar/ConversationOps.ts:118-129`) |
| 3 | The gate is 14 boolean signals; **all** must be false | `src/sidebar/sidebarWiring.ts:116-133` (`ConversationEvictionSignals`), `:135-137` (`isConversationEvictable` = `!Object.values(signals).some(s => s === true \|\| s === undefined)`) |
| 4 | One signal is `undecidedChanges: checkpoints.canUndo(id)` | `src/sidebar/sidebarWiring.ts:364`; its own comment at `:131-132` says "Keep/Undo still undecided: archiving would hide the only way to undo" |
| 5 | `canUndo(id)` is true for the whole life of the stack — a chat whose agent wrote files and nobody dismissed the bar is pinned **forever** | `src/checkpoint/CheckpointStack.ts:321-323` → `depth(id) > 0`; the stack is only popped by `keep()` (`:305`) or `undo()` (`:236`) |
| 6 | So at cap, with 12 such chats, `archiveLeastRecent` returns `undefined` and the user is told every chat is *busy* | `src/sidebar/ConversationTabs.ts:113-116` — `showWarningMessage(\`Forge: all ${MAX_CONVERSATIONS} open chats are busy.\`)`. Same string on the restore path at `:322-324` |
| 7 | The same string is thrown to remote/transport callers, who must handle it as an error | `src/sidebar/ForgeHostFacade.ts:229-231` (`createConversation` throws), `:236-246` (`restoreConversation` throws); callers that already treat a throw as expected: `src/remote/RemoteCommandHandler.ts:238-241`, `src/remote/RemoteWorkspaceHandoff.ts:122-126` |
| 8 | Eviction already destroys the checkpoint before anyone asked | `ConversationTabs.ts:204-218` `disposeEvictedConversation` → `await this.deps.checkpoints.disposeConversation(id)` (`:208`) → `CheckpointStack.ts:325-338` discards every disk reference and `stacks.delete(id)`. Today this is *correct* only because signal #4 means eviction never reaches a chat with a stack |
| 9 | The webview drops a closed tab's pending-checkpoint bar, so the Keep/Undo affordance really does vanish with the tab | `webview-ui/src/reducer.ts:411-415` — "A closed tab can never show its bar again, so drop its pending id" |

### 1.1 The agent-bus lie, traced end to end

`forge.sh say <name> --new` at the cap returns HTTP 202 with a body that reads
like a success, and the message disappears. The exact path:

1. `src/agentBus/forge.sh:139` parses `--new` → `NEW_CHAT=true`; `:159` puts
   `new_chat=true` in the query string and POSTs `/agent/message`.
2. `src/backend/agentRoutes.ts:358-372` — `messageOptions()` maps `new_chat` to
   `newChat`; `inbox.accept(...)` returns `{position, id}`; `:379`
   `return sendJson(res, 202, { queued, id });` **This is the last thing the
   route does that the caller can see.**
3. `src/agentBus/agentInbox.ts:150-166` `accept()` only pushes onto an
   in-memory queue and kicks `void this.drain()`. Its 429 at `agentRoutes.ts:373`
   covers the *inbox depth* cap only — nothing about conversations.
4. `src/agentBus/agentInbox.ts:227-236` `drain()` polls `isBusy`, then
   `:249` `await this.host.submit(...)`.
5. `src/vscode/agentMessagingSetup.ts:132-139` `submit` → `submitBusMessage`.
6. `src/vscode/agentMessagingSetup.ts:68-73` —
   `conversationId = (await facade.createConversation({ activate: true })).id;`
7. `src/sidebar/ForgeHostFacade.ts:229-231` — `tabs.create()` returned
   `undefined`, so this **throws** `Forge: all 12 open chats are busy.`
8. `src/sidebar/ConversationTabs.ts:113-116` — at the same moment, a
   `showWarningMessage` fires **into the VS Code window**, not onto the bus.
9. `src/agentBus/agentInbox.ts:262-269` — the throw lands in `drain()`'s
   `catch`. `this.busy(...)` is false (a `--new` message is never busy:
   `agentMessagingSetup.ts:127-128` returns `false` for `newChat`), so it takes
   the else branch: `log.error` + `this.host.warn(...)`, and the item is
   **dropped**. `submit` never resolves to a `BusTurnEnd`, so
   `onBusTurnFinished` (`agentInbox.ts:250-259`) never runs and the sender gets
   no `failed` line either.

**Where the failure is dropped: `agentInbox.ts:262-269`.** The route had already
answered 202 at `agentRoutes.ts:379`, so by construction the caller cannot be
told anything. The only thing the user sees is a window-modal toast; the only
thing the agent gets is `{"queued":0,"id":"m…"}` and silence.

Note the asymmetry worth keeping: an ordinary `say` (no `--new`) targets an
existing chat and cannot hit the cap, so it is genuinely queueable. Only
`--new` (and `--model`, which `claimMidTurn` also refuses to deliver mid-turn —
`agentInbox.ts:206`) needs a tab to exist.

---

## 2. How checkpoints are stored and keyed — the finding that sizes this work

| Question | Answer | Evidence |
|---|---|---|
| Where does the stack live? | `CheckpointStack.stacks: Map<conversationId, Checkpoint[]>` — **in memory only**, on a `CheckpointStack` built once at activation | `CheckpointStack.ts:158`, `:345-350`; constructed at `src/extension.ts:153` via `src/vscode/checkpointSetup.ts:36-41` |
| Keyed by what? | `conversationId`, defaulting to `'__default__'` — **not** by tab | `CheckpointStack.ts:48`, `:175` |
| What is in a `Checkpoint`? | `turnId`, `conversationId`, `snapshots: FileSnapshot[]` (**original file contents held as in-memory `Buffer`s**), `diskSnapshots: DiskCheckpointReference[]`, `createdAt` | `CheckpointStack.ts:26-33`, `:16-20` |
| What is on disk? | Only the **external-CLI workspace rollback**: one `mkdtemp` dir `<storageRoot>/turn-XXXXXX/` with `blobs/<sha256>.bin`, `manifest.pending.json` → `manifest.committed.json` | `DiskCheckpointStore.ts:117-120`, `:163-171`, `:281-286`; `CheckpointManifest.ts:100-106` |
| Are tool-written files (the normal Keep/Undo case) on disk? | **No.** `ToolDispatch.ts:328-333` calls only `snapshotBefore` / `snapshotMissingBefore`, which are the in-memory capture (`CheckpointStack.ts:65-81`, `MemoryCheckpointState.ts`). `preparePaths` / `prepareWorkspace` are reachable only from `src/agents/WorkspaceCheckpoint.ts:13` ← `CliChatRunner.ts:107`, i.e. CLI turns |
| Does any of it survive a window reload? | **No.** The stack is a `Map` on a class instantiated at activation; nothing reads it back. The disk half is *not* re-keyed on startup: `DiskCheckpointStore`'s only startup action is `reportExistingCheckpointRecoveryData`, which counts `turn-*` dirs and logs a warning — it never reattaches them | `CheckpointStack.ts:158`, `:164-170`; `CheckpointRecovery.ts:6-24` |
| Where is the disk root? | `<globalStorageUri>/checkpoints` unless `forge.checkpoint.storagePath` is set; falls back to `os.tmpdir()/forge-checkpoints-<pid>` when unconfigured | `checkpointSetup.ts:36-39`; `CheckpointStack.ts:168` |
| Is Undo cross-window safe today? | Yes, and this is the property to reuse: every Undo re-reads the manifest from disk and refuses unless the workspace still matches the captured postcondition fingerprints | `DiskCheckpointRestore.ts:127-150` (`assertDiskCheckpointCurrent`), `CheckpointManifest.ts:44-49,61` (`postconditions`) |
| Does anything else key off an archived conversation's id? | Yes, and it survives archiving: `ArchivedSessions` keeps the transcript under the same id (`ConversationTabs.ts:226-240` reads a stored row back on restore), and `ToolFailureTracker.reset(id)` is already called on eviction (`:214`) | `ArchivedSessions.ts`, `ConversationTabs.ts:204-250` |

**Verdict on size.** There is no durable checkpoint index today, and the
in-memory `Buffer` snapshots cannot be persisted cheaply (they are bounded only
by `forge.checkpoint.maxBytes`, default 2 GiB — `package.json:415-419`). So
change 1 does **not** invent one. The stack is already keyed by `conversationId`,
and an archived conversation keeps its id for life — history rows,
`archivedSessions.json`, and restore-by-id all prove it. Therefore eviction can
simply *stop destroying* the stack, and restore can *re-post* the bar. Change 1
is small: no new file, no new format, no index to keep consistent.

---

## 3. Design

### 3.1 Change 1 — eviction keeps the checkpoint stack; restore re-posts the bar

The whole of it: **`CheckpointStack.stacks` is keyed by `conversationId`, not by
tab, and an archived conversation keeps its `conversationId` forever.** So the
stack of an evicted chat is not garbage — it is a row in a Map under an id that
can come back. Eviction destroying it is the only reason Undo is lost.

Three edits, no new module:

| Path | Today | After |
|---|---|---|
| eviction (`ConversationTabs.ts:204-218`) | `await checkpoints.disposeConversation(id)` — discards every disk reference and `stacks.delete(id)` | **nothing for checkpoints.** The stack stays in the Map under that id, its `Buffer` snapshots and its `turn-*/` dirs intact. `agentLoop.disposeConversation(id)` and `failureTracker.reset(id)` stay exactly as they are |
| restore (`ConversationTabs.ts:312-345`) | nothing | if `checkpoints.canUndo(id)` is true, `post({ type: 'checkpointReady', conversationId: id })` and re-arm the editor Code Lenses from `checkpoints.pendingSnapshots(id)` — the same two affordances a committed turn raises (`ProviderTurn.ts:81-83`, `ToolDispatch.ts:251`) |
| `close(id)` (`:183-199`) — the user pressed ✕ | `disposeConversation` | **unchanged.** Closing on purpose forfeits the Undo; that asymmetry with eviction is deliberate |
| `deleteConversation(id)` (`:200-250`) | `disposeConversation` | **unchanged** — Delete (not evict) still disposes the stack and its disk dirs |
| `dispose()` (`CheckpointStack.ts:340-345`) | disposes every conversation | **unchanged** — window teardown still cleans up; the stack is in-memory and dies with the window, as it does today |

**Eviction gate.** Drop `undecidedChanges` from `ConversationEvictionSignals`
(`sidebarWiring.ts:131-132`, `:364`) and from the test's signal list
(`test/unit/ConversationOps.test.ts:127-141,157-161`). It stops being a reason
to refuse because eviction no longer loses anything: the stack survives in
memory, and Undo/Keep work the moment the chat is reopened — in the same window.

**Why this is safe, not just convenient.**

1. Undo re-verifies before writing. `undo()` (`CheckpointStack.ts:210-236`)
   refuses unless every in-memory `afterFingerprint` still matches the file and
   every disk reference still passes `diskStore.assertCurrent`. A chat that sat
   archived for a day while the workspace churned gets a refusal, not corrupt
   bytes.
2. The bar is per-conversation in the webview (`reducer.ts:366-375`
   `checkpointPendingIds` is a `Set<convId>`), and `SESSION_SYNC` already prunes
   ids that are not open (`:411-415`). A parked-but-not-restored chat therefore
   shows nothing anywhere: no tab, no bar, no Code Lens until it is reopened.
3. `KeepUndoCodeLensProvider.pendingFiles` is a `Set<string>` of file paths with
   no conversation key, so re-arming it on restore is one call
   (`markPending(paths)`) and it is already cleared by Keep/Undo
   (`KeepUndoCodeLens.ts:23-33`).

**The honest limit, stated plainly.** The stack is in memory, so a **window
reload between archiving and restoring still loses that chat's Undo** — exactly
as it loses the Undo of a chat that stayed open. This is not a regression
introduced here; it is today's behaviour for every chat, and the disk half
already survives it (its manifests are re-read at Undo time). Persisting the
`Buffer` snapshots would mean a durable copy of up to `forge.checkpoint.maxBytes`
(2 GiB default) per chat, and is **out of scope** (§5). What changes is that
within one window — the case the cap actually creates — eviction costs nothing.

**Memory.** An evicted chat's snapshots stay resident until the user restores it
and presses Keep/Undo, or closes/reloads the window. That is the same memory an
open chat already holds, and `MAX_CHECKPOINT_DEPTH = 20` per conversation
(`checkpointHistory.ts`) already bounds it per id. The cap is 12 chats, so the
worst case is what 12 open chats already cost; the gate no longer *adds*
retention, it just stops throwing it away.

### 3.2 Change 2 — the refusal must name the reasons, with counts

Stop deriving the answer as one boolean. `isConversationEvictable` keeps its
shape (it is the tested contract, and `src/` has exactly one caller), and a new
sibling in the same owner file explains a refusal:

```ts
// src/sidebar/sidebarWiring.ts — same file, same signal object
export function evictionBlockers(signals: ConversationEvictionSignals): string[];
```

It returns human labels for each signal that blocks, so the counts come from the
existing signal list rather than a second, drifting enumeration:
`streaming | activeRequestChain | unattended | pendingApproval* | pendingQuestion |
unattributedRequest | *Queue | remoteBinding | remoteRuntimeUnavailable`.
`ConversationTabs` aggregates over the 12 chats and shows:

```
Forge: no open chat can be archived — 7 are running a turn, 3 have an approval
waiting, 2 are bound to a remote chat. Archive one yourself (✕ on its tab) or
unload its model, then try again.
```

Two consequences to get right:

- The message must not claim "busy" for a state that isn't. With
  `undecidedChanges` gone from the gate, the residual blocker set really is
  activity, so `busy` becomes true — but the counts version is what ships,
  because "2 are running" is actionable and "all 12 are busy" is not. The old
  wording's "Keep/Undo its pending changes" advice is now obsolete twice over:
  undecided changes no longer block, and archiving no longer hides them.
- `ForgeHostFacade.ts:231` and `:240-245` throw the same string for transports.
  Give the facade a reason-carrying error (`atCapReason: string[]`) rather than
  a formatted sentence, so `RemoteCommandHandler` / `RemoteWorkspaceHandoff`
  keep their existing throw-handling and can forward the reason to a phone.
  Keep one owner for the wording: `ConversationTabs` formats the human string,
  the facade carries the array.

### 3.3 Change 3 — the bus must fail, not shrug

The failure is discovered after the 202, so the fix is to make it *impossible to
accept a message that cannot be delivered*, and to report the failure through
the channels that do exist for the residue.

1. **Pre-flight at accept time** (closes the lie for the common case). In
   `agentRoutes.ts`, before `inbox.accept(...)`: if `options.newChat` and the
   host reports the conversation set is at the cap with nothing evictable,
   `throw new HttpError(409, …)`. `HttpError` is already mapped to a JSON error
   body at `:380-382`, and `forge.sh:170-172` already prints the body and exits
   1 (`--fail-with-body`). The caller gets a real error, at the moment it asked.
   Needs one new facade read: the aggregate blocker list from §3.2
   (`chatCapBlockers()`), which already exists as sidebar state.
2. **Report, never drop, in `drain()`** (`agentInbox.ts:262-269`). The else
   branch currently logs and warns and loses the item. Change it to:
   `onBusTurnFinished(from, duration, { kind: 'failed', error: why })` — the
   `failed` disposition and its one-line rendering already exist
   (`agentInbox.ts:31-36`, `agentMessagingSetup.ts:158-166`) and write a board
   event. Keep the `warn` for the window. The item is still dropped — a prompt
   replayed after the user fixed the cap is stale intent, and the inbox's own
   doc says it is memory-only by design (`agentInbox.ts:120-131`) — but the
   sender is told, in the same shape it is told for every other failed turn.
3. **Do not make a `--new` message look retryable.** `agentMessagingSetup.ts:127-128`
   returns `isBusy === false` for `newChat`, which is what routes the failure to
   the drop branch. Leave that (a cap is not busy-ness) and rely on (1) + (2).

---

## 4. Files to touch

| File | Change |
|---|---|
| `src/sidebar/ConversationTabs.ts` | eviction stops disposing the checkpoint stack (`:204-218`); restore re-posts `checkpointReady` + re-arms the Code Lens when `canUndo(id)`; cap message with counts (`:113-116`, `:322-324`) |
| `src/sidebar/sidebarWiring.ts` | remove `undecidedChanges` (`:131-132`, `:364`); add `evictionBlockers(signals)`; expose the aggregate blocker counts `ConversationTabs` needs |
| `src/sidebar/ForgeHostFacade.ts` | cap error carries `atCapReason: string[]` instead of one sentence (`:229-246`); new `openConversationCount()` + `evictionBlockers()` reads for the routes |
| `src/sidebar/KeepUndoCodeLens.ts` | `pendingFilePaths()` so a restored chat can re-arm the editor lenses through the existing owner |
| `src/backend/agentRoutes.ts` | 409 pre-flight for `new_chat` at an unrecoverable cap (before `:372`) |
| `src/agentBus/agentInbox.ts` | `drain()`'s drop branch reports `failed` to the sender (`:262-269`) |
| `src/agentBus/busContent.ts` | document the 409 in the `say --new` section (`:47-51`) |
| `CHANGES.md` | one bullet for the release (source of truth; `CHANGELOG.md` is generated) |

No new source file, and no `docs/OWNERS.md` row: every change lands in a file
that already owns its concern (`OWNERS.md:26` for `ConversationTabs.ts`, the
checkpoint rows at `:450-452` are untouched because `src/checkpoint/` does not
change).

---

## 5. Out of scope

- **Persisting the in-memory `Buffer` snapshots.** That would make Undo survive
  a window reload for tool-written files — a real gap, but a different one, and
  it costs a durable copy of up to `forge.checkpoint.maxBytes` (2 GiB default)
  per conversation plus a park index, a TTL, and an orphan sweep. If it is ever
  built, it is a separate plan with its own ledger; nothing here blocks it.
- **The orphan `turn-*/` sweep.** `reportExistingCheckpointRecoveryData`
  (`CheckpointRecovery.ts:6-24`) keeps today's behaviour: report, never delete.
  It only became load-bearing as a *sweep* in the dropped park-index design.
- **Making the cap recoverable by force.** A remote caller still cannot evict a
  chat the user is looking at; that rule (`archiveLeastRecent`'s
  `activate === false` guard) stays.

---

## 6. State × lifecycle ledger

Change 1 deliberately adds **no new durable state**: the checkpoint stack stays
in memory and dies with the window, exactly as it does today. The artifacts
below are the ones this plan newly relies on or newly changes the rules for.

| Artifact | create | delete | pause / disable | crash mid-write | owner-process death (window reload) | TTL / expiry |
|---|---|---|---|---|---|---|
| `CheckpointStack.stacks` entry for an **archived** conversation (in memory, newly retained) | unchanged: a committed turn (`commitSession`, `CheckpointStack.ts:180-203`) | `keep()` / `undo()` pop it; `close()` (✕) and `deleteConversation()` call `disposeConversation`; `dispose()` clears all at teardown | `forge.checkpoint.externalCliEnabled = false` still records the in-memory half (`CheckpointStack.ts:118,133` gate only the disk half), so the entry exists and Undo works for native tools | n/a — a `Map` in memory; a crash loses it, which is today's behaviour for every chat | the entry dies with the window, as today; no index, nothing to reattach, nothing stale on disk to point at | no TTL; bounded per conversation by `MAX_CHECKPOINT_DEPTH = 20` (`checkpointHistory.ts`) |
| `turn-*/manifest.committed.json` + `blobs/*.bin` (pre-existing, now retained across an archive) | unchanged, `DiskCheckpointStore.finalize` (`:281-286`) | unchanged: `keep()` / `undo()` / `close()` / `deleteConversation()` / `dispose()` all still discard; **eviction no longer discards** | unchanged | unchanged: `manifest.pending.json` → committed, then the pending file is removed (`:285-286`) | the dir outlives the reload that killed its in-memory entry — already true today for an open chat, and harmless: `reportExistingCheckpointRecoveryData` reports it and nothing reattaches it, so Undo cannot reach it | follows the in-memory entry that names it; unreferenced dirs keep today's behaviour (reported, never deleted — §5) |
| `undecidedChanges` (removed signal) | n/a — deleted, not a new artifact | removed from `ConversationEvictionSignals`, from the wiring at `:364`, and from the test signal list | n/a | n/a | n/a | n/a |
| the 409 pre-flight answer (`agentRoutes`) | n/a — an HTTP response, nothing written to disk | n/a | absent facade hook ⇒ no pre-flight, so the pre-`--new` behaviour is unchanged and (2) still reports the failure | n/a | n/a | n/a |

**CI row (the cheapest one, per the repo rule):** the eviction/restore pair. One
test archives a chat that has a stack and asserts `canUndo(id)` is still true
and the `turn-*/` dir is still on disk; a second restores it and asserts
`checkpointReady` was posted for that id. A later phase that reintroduces a
checkpoint destroy on the eviction path fails the first test.

---

## 7. Tests to add

| Test | File | Asserts |
|---|---|---|
| eviction keeps the stack and the disk dir | `test/unit/ConversationTabsPinModel.test.ts` | a chat evicted at cap with `canUndo === true`: `checkpoints.disposeConversation` **not** called for it, `canUndo(id)` still true, its `turn-*/` dir still exists |
| restore re-posts the bar | `test/unit/ConversationTabsPinModel.test.ts` | restoring that id posts `{ type: 'checkpointReady', conversationId: id }`; restoring a chat with no stack posts nothing |
| Undo works after evict → restore | `test/unit/ConversationTabsPinModel.test.ts` (real `CheckpointStack`) | the file bytes are restored by `checkpoints.undo(id)` after the round trip |
| close and delete still forfeit | `test/unit/ConversationTabsPinModel.test.ts` | `close(id)` and `deleteConversation(id)` each call `disposeConversation(id)` |
| eviction no longer blocked by undecided changes | `test/unit/ConversationOps.test.ts` | `ConversationEvictionSignals` has no `undecidedChanges` key; a chat with `canUndo === true` is chosen as the LRU victim |
| the refusal counts reasons | `test/unit/ConversationOps.test.ts` + `test/unit/ConversationTabsPinModel.test.ts` | `evictionBlockers` returns one label per blocking signal; the composed message contains the per-reason counts for a fixture of 12 and **not** the old "all 12 open chats are busy" string |
| cap error carries reasons to transports | `test/unit/ForgeHostFacade.test.ts` | `createConversation` at cap rejects with `atCapReason` non-empty, and `RemoteCommandHandler`'s existing throw path still yields a user-visible reply |
| bus says no | `test/unit/AgentRoutes.test.ts` | `new_chat=true` at an unrecoverable cap → **409** with a reason body; at a recoverable cap → 202 as today |
| bus reports a dropped message | `test/unit/AgentInbox.test.ts` (extend) | `submit` throwing a non-busy error calls `onBusTurnFinished(from, _, {kind:'failed', error})` exactly once, and the message is not re-queued |
| ledger contract | `test/unit/PlanLedgerContract.test.ts` (existing) | this file's ledger has every cell filled |

---

## 8. Acceptance criteria

- [ ] Archiving a chat at the cap never destroys its checkpoint: the conversation's
      stack stays in the Map and its `turn-*` directory survives.
      → *"eviction keeps the stack and the disk dir"*.
- [ ] Keep and Undo work again, in the same window, once the chat is restored
      from history, with the existing postcondition refusal intact.
      → *"Undo works after evict → restore"*, *"restore re-posts the bar"*.
- [ ] `undecidedChanges` is gone from `ConversationEvictionSignals` and from the
      wiring; a chat with un-kept changes is evictable.
      → *"eviction no longer blocked by undecided changes"*.
- [ ] A user who closes a tab with ✕, or deletes a chat, still forfeits its Undo
      and its disk dirs. → *"close and delete still forfeit"*.
- [ ] At an unrecoverable cap the message names counts per reason and an action,
      and never says "all 12 open chats are busy", and never advises
      Keep/Undo-ing pending changes as a way to free a slot.
      → *"the refusal counts reasons"* asserts the literal absence of both.
- [ ] Transport callers get a structured reason, not a sentence, and their
      existing throw handling still works.
      → *"cap error carries reasons to transports"*.
- [ ] `forge.sh say <name> --new` at an unrecoverable cap exits non-zero with the
      reason on stderr, and no message id is returned.
      → *"bus says no"* (409 + body); `forge.sh:170-172` renders it.
- [ ] A bus message that fails after accept produces exactly one `failed`
      sender line and is not silently re-queued.
      → *"bus reports a dropped message"*.
- [ ] A reload between archiving and restoring still loses that chat's Undo —
      the same as for a chat that stayed open — and nothing on disk points at a
      stack that no longer exists. → *named validation step: read §3.1 "The
      honest limit" and the ledger row; no test asserts cross-window Undo.*
- [ ] `CHANGES.md` gains the bullet in the same change; `docs/OWNERS.md` needs no
      new row (no new owner). → *named validation step: grep both files.*
- [ ] `npx vitest run test/unit/PlanLedgerContract.test.ts` green; `npm run ci`
      green on Windows, ubuntu and macOS.
