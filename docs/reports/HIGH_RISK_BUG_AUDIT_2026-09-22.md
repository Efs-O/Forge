# High-Risk Bug and Design-Flaw Audit — 2026-09-22

Repository baseline: `main` at `4d7fefc` (`0.16.30`), clean worktree before this report was added.

Scope: targeted static audit of persistence, checkpoints, agent-loop concurrency, backend lifecycle, remote state, jobs, and CLI-agent integration. No fixes were applied. Findings are present at the audited HEAD; no introduced-vs-pre-existing attribution was possible because no commit range was requested.

## Findings

### 1. An active turn can be evicted and killed by a second model acquire

Severity: Critical — crashes/interrupts live agent work and can cause repeated or partial edits.

Evidence:

- `src/backend/poolSlots.ts:46-73` evicts the LRU slot whenever no free port exists. The only exclusion is `table.isPinned(...)`.
- `src/backend/BackendPool.ts:67-74, 371-375` wires `isPinned` to `DelegationGate`; ordinary active sidebar turns are not pinned in the pool.
- `src/sidebar/ProviderTurn.ts:188-201` acquires a backend and records it as active for the conversation, but that lifecycle state is not consulted by `claimPort`.

Failure scenario: with `max_simultaneous_models: 1`, conversation A is streaming on model A. Conversation B starts on model B. B's `acquire()` sees no free slot and LRU-evicts A, then `startSlot()` stops A's server while A is still generating. A's next round may reacquire and evict B, producing alternating failures, lost tool rounds, or partial workspace changes instead of a clean capacity refusal.

### 2. Per-conversation checkpoint stacks can restore an older snapshot over another conversation's work

Severity: Critical — direct workspace data loss in the multi-tab workflow.

Evidence:

- `src/checkpoint/CheckpointStack.ts:152-174, 191-205` stores checkpoints in a map keyed by conversation id, while each checkpoint captures paths in the shared workspace.
- `src/checkpoint/CheckpointStack.ts:216-260` undoes only the selected conversation's newest checkpoint and performs the restore without checking other conversation turns.
- `src/checkpoint/DiskCheckpointRestore.ts:87-124` unconditionally removes current targets and copies the checkpoint's old blobs back.

Failure scenario: conversation A checkpoints and edits `src/app.ts`; conversation B then checkpoints and edits the same file, and the user keeps B's changes. Undoing A later restores A's pre-turn blob, deleting B's kept changes. The stacks are conversation-scoped, but the files are not.

### 3. Undo unconditionally overwrites edits made after the checkpoint

Severity: High — user edits can be destroyed without a conflict warning.

Evidence:

- `src/checkpoint/DiskCheckpointStore.ts:264-314` records only the original entries and returns changed paths; it does not retain or enforce a post-turn revision/fingerprint.
- `src/checkpoint/DiskCheckpointRestore.ts:87-124` stages the old data and then removes/replaces current files with no comparison against their current hash or mtime.
- `src/sidebar/SidebarProvider.ts:229-235` exposes this as the normal Undo action for the active conversation.

Failure scenario: an agent turn changes a file, the user manually edits that file (or another process formats it), and the user then clicks Undo. Forge deletes/replaces the current file with the pre-turn snapshot, losing the intervening human change. The same applies to a later external agent or editor write.

### 4. Remote durable state has only per-process serialization, so windows can lose each other's updates

Severity: Critical — queued prompts, bindings, dedup records, outbox entries, or cursors can be silently dropped.

Evidence:

- `src/remote/RemoteRequestStore.ts:49-52` defines `mutationTail` only on one in-memory store instance.
- `src/remote/RemoteRequestStore.ts:451-479` clones that instance's state, applies a mutation, and persists it; there is no interprocess lock or read-modify-write against the latest file for ordinary mutations.
- `src/remote/remoteStateFile.ts:17-31` provides atomic replacement, but atomic rename prevents torn files; it does not merge concurrent writers.

Failure scenario: two VS Code windows share the remote state file. Window A enqueues a request while window B finishes another request or advances a cursor. Both serialize their own stale in-memory snapshots and the last rename wins, removing the other window's change. Telegram/WhatsApp delivery can then duplicate, disappear, or become permanently stuck with incorrect state.

### 5. Config edits from two Forge windows are last-writer-wins and can delete unrelated settings/models

Severity: High — durable configuration data loss.

Evidence:

- `src/config/ConfigWriter.ts:38-56` reads the whole YAML file, mutates the in-memory document, validates it, and writes it; no file lock or expected-file-state check is used.
- `src/config/ConfigWriter.ts:79-93` uses atomic replacement, but atomic replacement does not prevent two processes from reading the same old file and overwriting each other's changes.
- The writer is the shared mutation path for model-manager and setup operations (`src/config/ConfigWriter.ts:20-28`).

Failure scenario: window A changes model A while window B changes a voice or remote setting. Both read the same version; whichever write finishes last replaces the whole document and silently discards the other edit. The `.bak` copy is also a single fixed backup path, so it cannot provide per-operation recovery for concurrent writes.

### 6. A reserved send can continue after its conversation is deleted

Severity: High — hidden agent execution and unpersisted file changes after the user deleted a chat.

Evidence:

- `src/sidebar/SendPipeline.ts:176-191` reserves the request chain, then continues asynchronously.
- `src/sidebar/SendPipeline.ts:210-235` awaits attachment persistence and only afterward calls `agentLoop.runTurn` with the captured `conv` object.
- `src/sidebar/ConversationTabs.ts:189-218` deletes a conversation by stopping/disposal and removing it from sidebar state, but does not cancel or invalidate a request-chain reservation that is still before `runTurn`.

Failure scenario: the user sends a prompt with a slow attachment save, confirms deletion of that tab while the save is pending, and the save then completes. The old object is still passed to `runTurn`; the agent can start, call tools, and modify the workspace even though the conversation no longer exists in sidebar state. The resulting transcript may not be persisted because the deleted conversation is absent from the session.

### 7. Tool-failure fallback state is global, despite turns being conversation-scoped

Severity: High — one tab can disable tools for another or erase its recovery evidence.

Evidence:

- `src/tools/StripTools.ts:18-33` stores one scalar failure counter in one `ToolFailureTracker` instance.
- `src/sidebar/sidebarWiring.ts:102-124, 237-250` injects the same tracker into the shared `AgentLoop` and `SendPipeline` used by every conversation.
- `src/sidebar/ModelTurn.ts:185-189` reads the global counter to decide whether to strip tools; `src/sidebar/SendPipeline.ts:227-240` resets it whenever any turn finishes. `ConversationTabs.ts:155-177, 245-252` also resets it on tab actions.

Failure scenario: conversation A accumulates two malformed/tool-dispatch failures and is about to cross the strip threshold. Conversation B finishes first, causing the shared `reset()`. A continues with tools enabled and repeats the failing calls instead of entering recovery. Conversely, A's failures can force B's unrelated next turn into no-tool mode.

### 8. CLI session capacity can be exceeded by concurrent cold starts

Severity: High — excess CLI processes, broken session ownership, and capacity-related crashes.

Evidence:

- `src/agents/CliSessionRegistry.ts:60-75` awaits `getOrCreate()` before sending.
- `src/agents/CliSessionRegistry.ts:94-112` checks capacity, awaits idle eviction, and only then inserts the new entry; there is no registry-wide creation lock or in-flight map.
- `src/agents/CliSessionRegistry.ts:115-123` selects/removes an idle candidate before awaiting its disposal.

Failure scenario: with `maxSessions = 1`, two conversations start CLI turns concurrently while one idle session exists. Both calls see the registry full and select the same idle entry before either finishes eviction. Both then create and insert new sessions, leaving two entries/processes despite the limit; both may also dispose the same old session. The next capacity decision is now based on corrupted bookkeeping.

### 9. One-shot CLI protocol corruption can be reported as a successful turn

Severity: High — the agent may have changed files while Forge records a false success or an empty answer.

Evidence:

- `src/agents/CliAgentDriver.ts:82-90` catches every adapter/parser exception for a stdout line and does nothing.
- `src/agents/CliAgentDriver.ts:161-173` returns `status: 'completed'` whenever the process exits with code 0 and no explicit `errorText`, even if protocol lines were malformed or no final result was parsed.
- `src/sidebar/CliTurn.ts:151-174` treats a completed CLI result as a completed Forge turn and appends/presents the returned text.

Failure scenario: a CLI writes a non-JSON warning, truncated frame, or incompatible protocol line to stdout and exits 0. Forge ignores the malformed frame and can return completed with partial or empty `finalText`. If the CLI already edited files, the user sees no reliable failure signal and may rerun the request, duplicating or conflicting with those edits.

### 10. Deleting a job does not invalidate an already-running scheduler execution

Severity: High — deleted jobs can continue mutating the machine and recreate durable state.

Evidence:

- `src/jobs/JobStore.ts:273-286` deletes the definition, state, run log, run marker, staged build, and outbox, but has no run-generation token or cancellation handshake with the scheduler.
- `src/jobs/JobStore.ts:203-224` recreates a missing state file from `defaultState()` when `patchState()` runs.
- `src/jobs/JobStore.ts:292-303` recreates/appends the run log; `src/jobs/JobScheduler.ts:473-499` writes state and appends a run record as execution completes/fails.

Failure scenario: a scheduled `llamacpp_update` or agent task has already started; the user deletes the job while it is running. The in-flight operation continues because deletion does not cancel or mark it invalid. Its completion path can recreate `state/<id>.json` and `runs/<id>.jsonl`, while the action itself may still install/restart software or deliver a notification for a job the user removed.

## Audit limitations

This was a targeted static audit, not a full test run or live multi-window/Telegram/CLI exercise. The findings above are code-supported failure modes; live timing and provider-specific behavior may affect reproducibility, but do not remove the underlying races or missing guards.
