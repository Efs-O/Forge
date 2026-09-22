# High-Risk Bug Audit Revalidation

Date: 2026-09-22  
Current HEAD: `1974218` (`feat(jobs): CLI agents in unattended jobs need one consent`)  
Original audit baseline: `4d7fefc`

## Result

The original audit remains valid. None of the ten findings is fully invalidated by the changes since the original baseline. Finding 6 is partially mitigated for turns that are already registered as streaming; its pre-stream reservation race remains. The other nine findings remain materially present.

The review was static and evidence-based. No source changes were made and no test suite was run.

## Findings

1. **Critical — active turns can still be killed by model eviction — still valid.**

   `src/sidebar/ProviderTurn.ts` calls `ctx.pool.acquire(model.name)` before it marks the conversation streaming. `src/backend/BackendPool.ts` still calls `claimPort(true)` for ordinary acquisition, and `src/backend/poolSlots.ts` allows `lruSlot()` to evict any slot that is not pinned by the delegation gate. A sidebar turn is not pinned merely because it is active.

   **Failure:** with one local slot, conversation A is generating on model A; conversation B requests model B. B evicts and stops A's server, so A's in-flight request fails or its turn is left incomplete. The newer control-server hold logic does not pin ordinary sidebar turns.

2. **Critical — per-conversation checkpoints can restore over another conversation's edits — still valid.**

   `src/checkpoint/CheckpointStack.ts` keys stacks by conversation ID, but snapshots contain workspace file paths. `undo()` calls `restoreMemoryState()` and disk restore without checking the file's current version. Switching conversations does not dispose the other conversation's stack.

   **Failure:** conversation A checkpoints `file.ts`; conversation B edits and keeps that same file; returning to A and pressing Undo restores A's old snapshot and destroys B's newer work.

3. **Critical — Undo overwrites edits made after the checkpoint — still valid.**

   `src/checkpoint/MemoryCheckpointState.ts` restores the original state directly, and `src/checkpoint/DiskCheckpointRestore.ts` removes/recreates checkpoint targets directly. There is no compare-and-swap, current-content hash check, or conflict prompt.

   **Failure:** a user or another process edits a file after an agent checkpoint; Undo unconditionally replaces that newer content, causing silent data loss.

4. **High — remote durable state is only serialized per process — still valid.**

   `src/remote/RemoteRequestStore.ts` serializes mutations through the in-memory `mutationTail`. Its reload-before-mutate option reads the file but does not acquire an inter-process lock. `src/remote/remoteStateFile.ts` uses temporary-file rename, which prevents torn writes but not lost updates.

   **Failure:** two extension hosts load the same remote state, each applies a different mutation, and the later atomic rename replaces the first host's change. Queue, deduplication, receipt, or cursor state can disappear.

5. **High — config writes still have a cross-window lost-update race — still valid.**

   `src/config/ConfigWriter.ts` reads the YAML, mutates it, validates it, and atomically renames a temporary file. There is no lock or revision check around the read/modify/write sequence.

   **Failure:** two VS Code windows read the same config; each changes a different setting; the second atomic rename wins and silently removes the first window's change.

6. **High — deletion can still race a reserved send — partially mitigated, still valid.**

   `src/sidebar/SendPipeline.ts` reserves the request before awaiting asynchronous attachment storage, then invokes `agentLoop.runTurn()` afterward. `src/sidebar/ConversationTabs.ts` now stops registered streaming turns before deleting, which closes the already-streaming case. However, `src/sidebar/AgentLoop.ts` registers lifecycle streaming inside `runTurn()`, after the SendPipeline's attachment await, and no conversation-generation invalidation is attached to the reservation.

   **Failure:** a send is reserved and waiting in attachment storage; deletion sees no registered stream, removes the conversation, and returns; attachment storage completes and the send runs against the stale conversation object. Its prompt/result can be lost, posted to a deleted conversation, or reintroduced by later persistence.

7. **High — tool-failure tracking still crosses conversation boundaries — still valid.**

   `src/tools/StripTools.ts` stores failures in one mutable scalar counter. `src/sidebar/sidebarWiring.ts` injects one `ToolFailureTracker` instance into the shared `AgentLoop` and `SendPipeline`. The tool loop records failures, while send completion and tab actions reset the same object.

   **Failure:** concurrent turns in conversations A and B can increment and reset the same counter. B may reach the strip-tools threshold because of A's failures, or A's counter may be cleared by B completing, changing agent behavior nondeterministically.

8. **High — CLI session capacity is not atomic under concurrent cold starts — still valid.**

   `src/agents/CliSessionRegistry.ts` checks `this.size`, awaits idle eviction, then creates and inserts a session. There is no registry-wide mutex covering that sequence.

   **Failure:** two conversations request new CLI sessions concurrently when capacity is one. Both observe capacity, both create sessions, and the registry temporarily exceeds its configured limit; for the same key, one session can overwrite the other and leak its process/session.

9. **High — malformed CLI protocol can still be reported as success — still valid.**

   `src/agents/CliAgentDriver.ts` catches and ignores every exception from `adapter.handleLine(line, ctx)`. If the process exits zero and no explicit error frame was parsed, the driver returns `status: 'completed'` with `finalText ?? ''`.

   **Failure:** a malformed or unexpected protocol line prevents the final text or session ID from being captured, but a zero exit code produces a successful empty turn. Forge can persist false success and later attempt to resume an invalid or missing session. Improvements in other JSON-RPC handling do not remove this catch-all in the driver path.

10. **High — deleting a job does not invalidate an active scheduler run — still valid.**

   `src/jobs/JobStore.ts.delete()` removes the definition, state, run log, requests, staged build, and outbox items. `src/jobs/JobScheduler.ts` can continue an already-started `runJob()` or detached `agentTask`, then calls `appendRun()` and `patchState()` without rechecking that the job still exists. `runningJobs` only prevents duplicate scheduling.

   **Failure:** a job is deleted while its check/action is awaiting I/O. Completion recreates the run log or state file, resurrects durable artifacts for the deleted job, and may still deliver or apply a staged machine-changing action.

## Change classification

All ten findings were pre-existing at the original audit baseline. No fixes were applied during this revalidation. Later changes provide targeted hardening in adjacent paths, but they do not remove the failure mechanisms above.
