# CLI Checkpoint Architecture Plan

**Status:** Core implementation complete (Phases 0-3 and hardening); isolated Git worktree prototype remains separately review-gated  
**Created:** 2026-07-31  
**Scope:** Direct Forge chat models using external Claude Code or Codex CLI tools

## 1. Decision Summary

Forge must stop copying an entire workspace into VS Code extension-host memory before every
external CLI turn.

The recommended replacement is phased:

1. Add an immediate metadata-only preflight and a hard allocation budget so an unsafe turn is
   blocked before the CLI starts.
2. Replace in-memory `Buffer` snapshots with an asynchronous, disk-backed checkpoint store.
3. Retain only preimages for paths that actually changed and delete unused checkpoint data.
4. Add an isolated Git worktree transaction strategy for scalable CLI execution in Git
   workspaces, while keeping the disk-backed strategy as the correctness fallback for smaller
   non-Git workspaces.

The safety requirement remains unchanged: Forge must establish rollback coverage before an
unrestricted external agent can write. Running silently without checkpoint coverage is not part
of this plan.

## 2. Incident and Root Cause

The failure was reproduced in `N:\vs code apps\Ssuno` after the first successful Claude turn.

- Forge captured every non-excluded top-level workspace entry.
- The captured workspace contained approximately 7.5 GiB of model checkpoints, media, audio,
  and project files.
- `CheckpointStack.capture()` loaded every file with `fs.readFileSync()` and retained the result
  as an in-memory `Buffer`.
- The affected VS Code extension host reached approximately 8.44 GiB of private committed
  memory.
- The successful Claude answer was only 3,418 characters, and Claude's transcript was only about
  157 KiB.
- The first visible failure occurred while VS Code serialized Forge's post-turn `sessionSync`.
  Later retries also failed while Forge attempted another checkpoint.

The current behavior is intentional but too coarse. External CLI models use their own tools and
bypass Forge's `ToolRegistry`, so Forge cannot use the normal path-local snapshot taken immediately
before a Forge write tool runs. `WorkspaceCheckpoint.snapshotWorkspaceBefore()` compensates by
capturing everything the external process could modify.

The invariant is valid; the storage strategy is not.

## 3. Current Execution Path

```text
User sends prompt
  -> Forge prepares Claude/Codex CLI
  -> Forge records the user message
  -> Forge announces "Backend ready"
  -> snapshotWorkspaceBefore(workspace root)
       -> snapshot each eligible top-level entry
       -> recursively read every file into Buffer memory
  -> spawn/resume the external CLI
  -> CLI uses its own unrestricted tools
  -> recapture workspace entries to find changes
  -> retain changed snapshots for Keep/Undo
  -> send full session state to the webview
```

Problems in this sequence:

- `Backend ready` is emitted before checkpoint preparation succeeds.
- Snapshot I/O is synchronous on the extension-host thread.
- Peak memory is proportional to workspace bytes rather than changed bytes.
- Post-turn comparison can reread large trees while the original snapshot remains live.
- One changed file can retain the original contents of its entire top-level directory.
- There is no preflight byte count, memory budget, free-space check, or cancellation.
- The fixed top-level exclusion list cannot make arbitrary large workspaces safe.

## 4. Architectural Constraints

The implementation must preserve these Forge guarantees:

1. **Rollback before mutation:** no unrestricted CLI process starts until rollback coverage is
   established for every writable path in scope.
2. **Exact restoration:** Undo restores modified and deleted files byte-for-byte and removes files
   created by the turn.
3. **No `.forge` capture or restoration:** `.forge` and `.forge-*` remain excluded under every
   strategy.
4. **No extension-host-sized snapshots:** workspace file contents must not be retained as large
   JavaScript strings or `Buffer` graphs.
5. **No silent degradation:** if Forge cannot create a safe checkpoint, it must not quietly run
   the CLI without one.
6. **Conversation isolation:** checkpoints, generation state, cancellation, and CLI session IDs
   remain keyed by Forge conversation ID.
7. **Concurrent turns:** independent conversations may run concurrently without sharing mutable
   checkpoint state.
8. **CLI ownership:** Claude Code and Codex retain their own authentication, models, sessions, and
   tools.
9. **Crash safety:** an interrupted checkpoint must not damage the workspace or be mistaken for a
   valid Undo point.
10. **Minimal dependencies:** prefer Node and Git capabilities already available to Forge.

## 5. Options Considered

| Option                                   | Memory safety | Exact Undo                                       | Large workspace cost        | Cross-platform     | Recommendation                  |
| ---------------------------------------- | ------------- | ------------------------------------------------ | --------------------------- | ------------------ | ------------------------------- |
| Current eager in-memory copy             | No            | Yes, when it completes                           | Critical                    | Yes                | Remove                          |
| Add more directory exclusions            | Unreliable    | No for excluded writes                           | Unbounded                   | Yes                | Reject as primary fix           |
| Filesystem watcher only                  | Yes           | No; notification is generally after mutation     | Low                         | Yes                | Insufficient                    |
| Disk-backed streaming snapshot           | Yes           | Yes                                              | High first-capture disk I/O | Yes                | Required compatibility strategy |
| Git diff against live workspace          | Yes           | Incomplete for ignored/untracked/pre-dirty state | Low                         | Yes                | Useful optimization only        |
| Isolated Git worktree transaction        | Yes           | Yes for managed transaction scope                | Moderate                    | Yes, with Git      | Recommended scalable strategy   |
| Force all CLI writes through Forge tools | Yes           | Yes                                              | Low                         | Provider-dependent | Separate future design          |

There is no safe mechanism that both permits unrestricted writes and provides exact rollback
without doing at least one of the following:

- intercepting every write before it occurs;
- running the process in an isolated copy-on-write environment; or
- preserving the original bytes of every path the process may overwrite.

Prompt classification is not a security boundary. A prompt that appears read-only may still lead
an autonomous CLI to edit a file, run a formatter, generate an artifact, or invoke a hook.

## 6. Proposed Architecture

### 6.1 Checkpoint coordinator

Keep `CheckpointStack.ts` as the canonical owner of per-turn checkpoint behavior, but split its
storage and inventory responsibilities into focused modules so source files remain practical in
size.

Proposed modules:

```text
src/checkpoint/
  CheckpointStack.ts          # lifecycle, ordering, Keep/Undo API
  CheckpointCoordinator.ts    # strategy selection and turn orchestration
  CheckpointInventory.ts      # cancellable metadata walk and exclusions
  DiskCheckpointStore.ts      # streamed blobs, manifests, restoration
  CheckpointManifest.ts       # strict internal manifest schema and validation
  GitWorktreeCheckpoint.ts    # later isolated-worktree strategy
```

The coordinator owns this lifecycle:

```text
preflight -> prepare -> ready -> run agent -> finalize -> expose Keep/Undo
```

The external CLI must not be spawned during `preflight` or `prepare`.

### 6.2 Metadata-only preflight

Before reading file contents, Forge walks the eligible workspace scope and records:

- relative path;
- entry kind: file, directory, or symlink;
- file size;
- modification time;
- file count and total logical bytes;
- filesystem identity where Node exposes it safely;
- exclusion reason for skipped top-level infrastructure.

Preflight must:

- run asynchronously in bounded batches;
- accept an `AbortSignal`;
- keep `.git`, `.hg`, `.svn`, `node_modules`, `.venv`, `venv`, `.forge`, and `.forge-*`
  exclusions explicit;
- reject paths that escape the workspace through unsafe traversal;
- treat symlinks as links and never recursively follow them outside the workspace;
- calculate required temporary storage before preparation begins;
- log counts, sizes, duration, and strategy without logging file contents.

### 6.3 Immediate allocation guard

Until the disk-backed engine is complete, add a conservative maximum eligible-byte and file-count
budget around the existing in-memory implementation.

If preflight exceeds either budget:

1. do not call `snapshotWorkspaceBefore()`;
2. do not spawn or resume the external CLI;
3. surface a clear error containing the measured size, configured limit, and remediation;
4. leave the conversation and CLI session reusable for a later retry;
5. do not create a checkpoint decoration.

This is a containment patch, not the completed architecture. Its purpose is to convert an
extension-host crash into a deterministic, recoverable refusal.

Budget configuration must have one documented owner and validation boundary. It must not be
duplicated between `config.yaml`, VS Code settings, and checkpoint modules. The implementation
phase must decide which existing configuration surface owns it before adding fields.

### 6.4 Disk-backed checkpoint store

The compatibility checkpoint strategy stores file contents outside the workspace under a
Forge-owned storage directory. It never constructs an in-memory representation of an entire file
tree.

Each turn gets:

```text
<checkpoint-storage>/<workspace-id>/<conversation-id>/<turn-id>/
  manifest.pending.json
  manifest.committed.json
  blobs/
  staging/
```

Storage rules:

- Stream files in bounded chunks using Node streams.
- Write a blob to a temporary name, flush and close it, then atomically rename it.
- Store only normalized workspace-relative paths in manifests.
- Validate every restoration target against the resolved workspace root.
- Preserve file bytes, executable/read-only mode where supported, empty directories when needed,
  and symlink targets without following the link.
- Never place checkpoint storage under the workspace being captured.
- Never include credentials, Forge config, or checkpoint storage in logs.
- Remove pending data after cancellation or failed preparation.
- Keep committed data until Keep, Undo, explicit conversation disposal, or expiry cleanup.

`CheckpointStack` should retain only small manifest references and metadata. It must no longer own
file-content `Buffer` values.

### 6.5 Finalization and changed-path retention

After the CLI exits, Forge creates a second metadata inventory and determines candidate changes:

- created paths;
- deleted paths;
- type changes;
- size or modification-time changes;
- directory membership changes.

Candidate files are verified with streaming hashes or byte comparison. Forge then:

1. writes the final change set to `manifest.committed.json`;
2. retains the pre-turn blobs required to undo only those changed paths;
3. deletes or dereferences unused baseline blobs;
4. exposes Keep/Undo only after the committed manifest is durable;
5. reports finalization errors without discarding recoverable preimages.

Metadata is an optimization, not the sole correctness test. A file whose content changed while
size and timestamp remained equal must still be detectable when exact rollback is promised.

### 6.6 Keep and Undo

**Keep**:

- removes the committed checkpoint record from the stack;
- deletes or dereferences its stored preimages;
- leaves live workspace files untouched;
- reports cleanup failures separately without pretending the checkpoint still exists.

**Undo**:

- validates every manifest entry and target before mutating anything;
- restores modified and deleted paths from streamed preimages;
- removes paths created by that turn only when the manifest proves they were originally missing;
- handles deepest paths before parent directories where ordering matters;
- never deletes or recreates `.forge` or `.forge-*`;
- reports partial restoration path-by-path and retains recovery data if restoration is incomplete.

Material deletion or replacement performed by Undo must stay within the verified workspace root.

### 6.7 User-visible lifecycle

The sidebar sequence should become:

```text
Starting claude-code…
Preparing rollback checkpoint… 2,603 files / 84 MiB
Backend ready.
<generation starts>
```

For a blocked workspace:

```text
Forge did not start claude-code.
Rollback coverage requires 7.5 GiB across 2,632 files, exceeding the configured checkpoint limit.
Open a smaller workspace or change the reviewed checkpoint policy.
```

`Backend ready` must mean both the CLI executable and rollback preparation are ready. It must not
be emitted before checkpoint preparation.

### 6.8 Isolated Git worktree strategy

Disk-backed full snapshots solve correctness and memory safety but can still impose excessive disk
I/O. The scalable Git strategy should run the external CLI in a per-conversation transaction
worktree instead of the live workspace.

Target flow:

1. Create a detached Forge-owned worktree for the conversation.
2. Overlay the live workspace's tracked modifications into the transaction baseline.
3. Copy explicitly covered untracked source files into the transaction.
4. Start or resume the CLI with the transaction worktree as its working directory.
5. Compute the transaction diff after each turn.
6. On Keep, apply the diff to the live workspace using a conflict-aware operation.
7. On Undo, discard the transaction changes without touching the live workspace.
8. Refresh or rebuild the transaction baseline after Keep and after conflicting external edits.

This phase requires a separate design checkpoint before implementation because it affects:

- ignored assets required at runtime;
- pre-existing staged and unstaged changes;
- untracked files;
- symlinks and submodules;
- long-lived Claude/Codex session working directories;
- simultaneous Forge conversations;
- live user edits made while a CLI turn is running;
- three-way conflict reporting when Keep is applied.

The worktree strategy must not ship as an incomplete substitute for non-Git rollback. Unsupported
workspace state must route to the bounded disk-backed strategy or be blocked explicitly.

## 7. Implementation Phases

### Phase 0 — Regression lock and observability

- Add a regression test representing a multi-gigabyte logical workspace without allocating the
  equivalent RAM; sparse files or a mocked inventory may be used.
- Add structured checkpoint timing and size logs.
- Record extension-host memory only in tests or local diagnostics; do not add telemetry.
- Confirm current CLI session persistence and concurrent-conversation tests before refactoring.

**Exit criteria:** the current unsafe behavior is captured by a failing regression test.

### Phase 1 — Safety containment

- Implement cancellable metadata preflight.
- Add validated byte/file budgets around the legacy in-memory snapshot.
- Move `Backend ready` after successful checkpoint preparation.
- Block unsafe turns before driver invocation.
- Surface measured size and remediation in the sidebar.
- Preserve `.forge` exclusions and add direct tests.

**Exit criteria:** the Ssuno-sized fixture is refused without spawning Claude/Codex and without a
material extension-host memory increase.

### Phase 2 — Disk-backed engine

- Add manifest schema and disk store.
- Stream capture and restore operations.
- Convert `CheckpointStack` from content ownership to manifest-reference ownership.
- Add atomic pending/committed lifecycle.
- Implement cancellation, disk-full handling, cleanup, and startup recovery.
- Retain only changed-path preimages after finalization.

**Exit criteria:** a workspace larger than RAM can be checkpointed without memory growth
proportional to workspace size, subject to configured disk policy.

### Phase 3 — Integration and migration

- Route direct Claude and Codex chat through `CheckpointCoordinator`.
- Route CLI workers through the same storage engine while keeping worker writable scopes narrow.
- Keep Forge-native write tools on efficient path-local snapshots.
- Remove `WorkspaceCheckpoint`'s eager recursive `Buffer` capture.
- Preserve existing Keep/Undo message bridge behavior unless a typed progress message is added.
- Dispose active checkpoint operations during extension deactivation.

**Exit criteria:** all checkpoint consumers use one lifecycle owner and no duplicate capture logic
remains.

### Phase 4 — Isolated worktree transaction prototype

- Prototype on clean, dirty, staged, and untracked Git workspaces.
- Validate Claude and Codex resume behavior when cwd is transaction-owned.
- Define ignored-file visibility and writable-scope policy.
- Define conflict behavior for live edits and concurrent conversations.
- Compare startup time and disk consumption against disk-backed snapshots.

**Exit criteria:** a reviewed decision determines whether worktrees become the default Git strategy.

### Phase 5 — Hardening and release

- Add orphan cleanup with conservative age and ownership validation.
- Add recovery diagnostics for incomplete manifests.
- Update README checkpoint semantics and configuration documentation.
- Update the config example if configuration is introduced.
- Add release notes explaining the corrected `Backend ready` semantics.
- Run the complete code-quality and packaging gates.

**Exit criteria:** release artifacts pass CI and VSIX smoke tests with large-workspace regression
coverage.

## 8. Test Plan

### Unit tests

- Inventory applies every required exclusion, especially `.forge` and `.forge-*`.
- Inventory does not follow symlinks outside the workspace.
- Preflight calculates bytes/files without reading content into snapshot buffers.
- Over-budget preflight prevents CLI driver invocation.
- Cancellation removes pending storage and leaves no checkpoint decoration.
- Manifest validation rejects absolute paths and `..` traversal.
- Disk store restores modified, deleted, created, empty, binary, and symlink entries.
- Keep deletes checkpoint data without changing workspace files.
- Undo retains recovery data after a partial failure.
- Conversation A cannot Keep/Undo conversation B's checkpoint.
- A read-only turn results in no retained committed checkpoint.

### Integration tests

- Claude first turn and resume keep the same session ID through checkpoint preparation.
- Codex first turn and resume keep the same thread ID.
- Two CLI conversations run concurrently with independent checkpoints.
- A live config under `.forge/config.yaml` is never captured, deleted, or recreated.
- Disk-full, permission, cancellation, and process-failure injection all produce explicit errors.
- Extension deactivation cancels preparation and closes file handles.
- A large sparse/binary workspace keeps extension-host memory within the acceptance budget.

### Restoration matrix

Test each operation for text and binary files:

- existing file modified;
- existing file truncated;
- existing file deleted;
- missing file created;
- file replaced by directory;
- directory replaced by file;
- nested directory created or removed;
- symlink target changed;
- path renamed;
- multiple changes under one top-level directory.

## 9. Acceptance Criteria

The redesign is complete when all of the following are true:

1. A 10 GiB eligible workspace does not cause extension-host memory growth proportional to 10
   GiB.
2. Phase 1 blocks an over-budget legacy checkpoint before the external CLI starts.
3. Phase 2 streams content with a documented small upper bound on in-flight memory.
4. `Backend ready` is emitted only after rollback preparation succeeds.
5. Undo restores all covered test cases byte-for-byte.
6. No strategy captures, removes, or restores `.forge` or `.forge-*`.
7. Failures are visible to the user and are not silently swallowed.
8. Checkpoint state is isolated by conversation and safe under concurrent turns.
9. Existing Claude `session_id` and Codex `thread_id` persistence continues to work.
10. `npm run ci` passes.
11. `npm run package` passes and the generated VSIX completes its smoke test.

## 10. Risks and Mitigations

### Disk exhaustion

**Risk:** disk-backed snapshots exchange RAM pressure for disk pressure.  
**Mitigation:** preflight logical size, check available storage, use explicit budgets, write
atomically, deduplicate only after correctness is established, and block before CLI start.

### Slow first turn

**Risk:** a full non-Git baseline can take too long.  
**Mitigation:** progress reporting, cancellation, scoped workers, retained content-addressed blobs,
and the later worktree strategy.

### Concurrent workspace edits

**Risk:** the user or another process changes a file during capture or generation.  
**Mitigation:** record metadata before and after each streamed capture, reject unstable captures,
and use conflict detection during finalization/Keep.

### Unsafe restoration paths

**Risk:** a corrupt manifest could target files outside the workspace.  
**Mitigation:** strict manifest validation, relative paths only, resolved-root containment checks,
and symlink-safe restoration.

### Cleanup deletes the wrong data

**Risk:** an overly broad cleanup could remove user files.  
**Mitigation:** checkpoint storage must have a fixed Forge-owned root, ownership markers, exact
turn IDs, and no recursive deletion based on unresolved paths.

### Worktree semantic drift

**Risk:** the isolated view differs from what the user sees in VS Code.  
**Mitigation:** treat the worktree strategy as a separately reviewed phase with dirty/untracked
state coverage and conflict-aware Keep semantics.

## 11. Review Decisions Required

Before implementation, reviewers should decide:

1. Which existing configuration surface owns checkpoint byte/file budgets?
2. What conservative default budgets are acceptable for the temporary Phase 1 guard?
3. Where should disk-backed checkpoint storage live, and what retention period is acceptable?
4. Should a user ever be offered an explicit “run without Undo” action? This plan recommends no
   by default because it weakens Forge's per-turn safety contract.
5. Is the isolated Git worktree strategy the intended default end state for Git workspaces?
6. Which ignored assets must be visible inside a transaction worktree, and must they be read-only?
7. Should direct CLI chat remain unrestricted, or should a future design mediate its write tools
   through Forge?

## 12. Out of Scope

- Changing Claude Code or Codex authentication.
- Changing CLI model-selection inheritance.
- Reading another extension's private persisted state.
- Removing `.forge` checkpoint exclusions.
- Adding telemetry or sending checkpoint metadata off-device.
- Treating additional directory exclusions as the architectural fix.
- Silently disabling Keep/Undo for large workspaces.
