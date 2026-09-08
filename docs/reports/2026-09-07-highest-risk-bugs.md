# Forge — Highest-Risk Bugs & Design Flaws (20 verified)

Date: 2026-09-07 (findings 1–19) · extended 2026-09-08 (finding 20)
Scope: crash, data-loss, corrupted-state, and incorrect-agent-behavior risks in the
Forge VS Code extension. "Bug" is read broadly here: breakage, plus dead, duplicate,
and bad code. Every finding was verified against the actual source; file:line
references are given for each.

**Original totals:** 20 findings — 4 CRITICAL, 10 HIGH, 4 MEDIUM, 2 LOW.

> **Maintainer review (2026-09-08):** Of the 21 numbered findings, **14 are
> confirmed bugs** (including crash-resilience and safety-boundary defects),
> **5 are intentional product choices with documented risk**, and **1 is a
> bounded design limitation rather than a defect; 1 (#15) was already fixed.** The secondary LOW EOF
> issue described under #20 is part of that finding, not a 21st numbered bug.
> See the review update at the end of this document for classifications and
> proposed fixes.

**Subsystem coverage:** checkpoint/restore, session persistence, config/auth writers,
file tools, path containment, tool dispatch, agent loop + guards, process spawn,
background execution, command-execution safety boundary, compaction pipeline, and the
`llm/` streaming layer. Not yet examined: `remote/` transport, `delegation/` +
`agents/` CLI runners, `backend/` pool internals, config loader.

Severity legend: **CRITICAL** = unrecoverable data loss or host crash under normal use;
**HIGH** = serious risk under plausible use; **MEDIUM** = correctness/robustness flaw.

---

## 1. Mutating file tools accept arbitrary absolute paths outside the workspace — CRITICAL

**Where:** `src/util/WorkspacePaths.ts:20-41` (`resolveWorkspacePath`), used by every
mutating tool:
- `write_file` / `append_file` — `src/tools/builtinTools.ts:164`, `:198`
- `edit_file` — `src/tools/editFileTool.ts`
- `delete_file` / `move_file` / `create_directory` / `format_file` / `rename_symbol` — `src/tools/fileEditTools.ts:32, 71, 108, …`

**Evidence:** `resolveWorkspacePath(filePath)` is called with **no options**, so
`mustBeInsideWorkspace` is `undefined`. For an absolute path the function does only
`path.normalize(filePath)` (`WorkspacePaths.ts:28`) and returns it unchanged — the
containment check at `:33-36` never runs. The workspace guard exists and is correctly
implemented, but the mutating tools never opt into it.

**Contrast (proof it is an oversight, not a policy):** the read/multimodal/PowerShell
tools *do* enforce containment — `imageTool.ts:74-76`, `videoTool.ts:212`,
`safePowerShellTool.ts:135`, and `LocalDelegationService.ts:133` all pass
`mustBeInsideWorkspace: true` or call `resolveRealWorkspacePath`. The destructive tools
are the *only* ones that don't.

**Concrete failure scenario:** A hallucinating or prompt-injected agent (e.g. content in
a file it read, or a remote-inbox message) issues
`delete_file({ path: "C:\\Users\\me\\Documents", recursive: true })` or
`write_file({ path: "C:\\Users\\me\\.ssh\\config", content: … })`. The path is accepted
verbatim. A confirmation dialog appears (write/delete are gated — see #10), but the user
is habituated to approving workspace writes; the detail line shows the raw path and an
out-of-workspace target is easy to miss. Result: files written or destroyed anywhere the
extension host process can reach.

---

## 2. Relative paths with no workspace folder open resolve against the extension-host CWD — HIGH

**Where:** `src/util/WorkspacePaths.ts:25-31`.

**Evidence:** When `defaultWorkspaceRoot()` returns `undefined` (no folder open) and the
argument is relative, the function returns `path.normalize(filePath)` — a *relative*
string. That string is then handed to `fs.mkdirSync` / `fs.writeFileSync` /
`fs.rmSync`, which resolve it against `process.cwd()` of the extension host — an
arbitrary, user-invisible location (frequently the VS Code install directory or
`C:\Windows\System32`, depending on how the editor was launched).

**Concrete failure scenario:** User opens a single file (no folder). The agent calls
`write_file({ path: "notes.md" })`. The file lands in the host's CWD, not anywhere the
user can see, and a later `read_file({ path: "notes.md" })` may or may not find it
depending on whether the CWD changed. With `delete_file`/`move_file` the same ambiguity
can target a real file in the CWD that has nothing to do with the user's project.

---

## 3. Undo checkpoint capture is uncapped and recursive — extension-host OOM — CRITICAL

**Where:** `src/checkpoint/MemoryCheckpointState.ts:20-49` (`captureMemoryState`);
wired as the capture fn in `CheckpointStack.beginTurn` (`CheckpointStack.ts:169`) and
invoked by `CheckpointSession.snapshotBefore` (`CheckpointStack.ts:64-70`), which
`ToolDispatch.snapshotPaths` calls for **every** mutating tool before it runs.

**Evidence:** `captureMemoryState` walks a directory tree with `readdirSync` and calls
`fs.readFileSync(absolute)` on every file, storing each as an in-memory `Buffer`
(`:44`), with **no size limit and no file-count limit**. The disk-backed store has a
capacity guard (`DiskCheckpointStore.assertStorageCapacity`, `:317`) but that path is
only used for external-CLI workspace rollback — the ordinary tool-mutation checkpoint
path is pure, unbounded memory.

**Concrete failure scenario:** A tool's `mutation.paths` names a large directory —
`move_file` of a folder, or `delete_file(recursive:true)` on `node_modules/`, a data or
model-cache directory. Before the tool executes, `snapshotBefore` walks and buffers the
entire tree into the extension host heap. A multi-GB directory drives the host to OOM
and crashes it **mid-turn**, losing in-flight transcript and leaving the mutation
half-applied with no committed checkpoint to Undo to.

---

## 4. Undo/restore is non-transactional — a failed restore destroys the file — CRITICAL

**Where:** `src/checkpoint/MemoryCheckpointState.ts:51-77` (`restoreMemoryState`);
called per-snapshot from `CheckpointStack.undo` (`CheckpointStack.ts:221-227`).

**Evidence:** `restoreMemoryState` opens with
`if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })`
(`:52`) and *then* rewrites from the captured state (`:56-77`). The delete and the
rewrite are not atomic and not guarded: if `writeFileSync`/`symlinkSync` throws after
the delete (disk full, permission change, path now locked by another process, symlink
creation denied on a non-elevated Windows host), the original is already gone and the
restore is partial. The loop in `undo` collects `failures[]` but by then the damage is
done; there is no rollback of the rollback.

**Concrete failure scenario:** User runs Undo on a turn that created a symlink tree.
`rmSync` removes the current directory; `fs.symlinkSync` throws (Windows without
Developer Mode / SeCreateSymbolicLink privilege). Net effect of pressing "Undo": the
files are deleted and nothing is restored — the safest-seeming action is the most
destructive. This is data loss triggered by a recovery gesture.

---

## 5. `delete_file` permanent mode uses `rmSync` with no recycle-bin fallback — HIGH

**Where:** `src/tools/fileEditTools.ts:113-116`.

**Evidence:** When `to_trash === false`, the handler calls `fs.rmSync(resolved, {
recursive })` directly — irrecoverable. The description invites the model to pass
`to_trash:false` whenever the trash move fails (`:120-126`), so the *error-recovery*
path for a failed trash move is a permanent delete. A model that hits the "network share
has no recycle bin" error and follows its own instructions converts a recoverable delete
into an unrecoverable one. Combined with #1 (arbitrary absolute paths), the blast radius
is the whole reachable filesystem.

**Concrete failure scenario:** Agent tries to tidy a temp dir, trash move fails for an
unrelated reason (file locked), model re-issues with `to_trash:false` per the tool's own
advice, and user data is gone with no Undo (the checkpoint capture itself can OOM — #3).

---

## 6. `edit_file` replaces only the FIRST match with no uniqueness check — HIGH

**Where:** `src/tools/editFileTool.ts:60-62` (description) and
`src/tools/editMatch.ts:50-62` (`findEditMatch` → `content.indexOf(oldStr)`).

**Evidence:** `findEditMatch` returns the first occurrence (`editMatch.ts:51`, and the
line-ending-insensitive fallback at `:59` likewise takes the first `indexOf` hit). There
is no `split(oldStr).length` count and no "matched more than once" rejection anywhere in
the edit path. The tool silently edits whichever copy comes first.

**Concrete failure scenario:** A config with two identical `port: 8080` lines (dev and
prod blocks). The model reads the prod block, builds `old_str` from it, calls `edit_file`
— the *dev* line is changed because it appears first. The diff shown to the user is the
dev line, but a model reasoning from the file's *contents* (not the diff) can be
mislead, and in a non-interactive/remote run nobody inspects the diff at all. The wrong
site is edited and the intended one is untouched.

---

## 7. xAI `auth.json` is written non-atomically — credential-file corruption — HIGH

**Where:** `src/llm/XaiAuth.ts:62` (`fs.writeFileSync(OPENCODE_AUTH_PATH, JSON.stringify(...))`).

**Evidence:** The token refresh reads the whole `auth.json`, mutates the `xai` entry,
and writes it back with a single `writeFileSync` — no temp-file + rename. `ConfigWriter`
does this correctly (`ConfigWriter.ts:84-88`: backup, write to `temporaryPath`, then
replace-with-sharing-violation-protection); `XaiAuth` does not follow that pattern.
`writeFileSync` truncates the target first, so a crash / process kill / disk-full during
the refresh leaves a **truncated or empty** `auth.json`.

**Concrete failure scenario:** Token refresh coincides with a window reload or the host
OOM (see #3). `auth.json` is left half-written; the next `JSON.parse` at `XaiAuth.ts:54`
throws, and because the `catch` only logs a warning (`:64`) the refresh returns a token
but the persisted credential file is now corrupt — xAI auth is broken until the user
re-authenticates manually, with no clear error pointing at the cause.
---

## 8. Tool-loop guard cannot detect loops on tools whose results vary — runaway rounds — HIGH

**Where:** `src/agent/ToolLoopGuard.ts:44-48` (`resultFingerprint`) and the detectors at
`:70-100`; `maxRounds` default 500 (`src/benchmark/arms.ts:218`, `max_tool_rounds ?? 500`).

**Evidence:** Both the identical-cycle and alternating-cycle detectors require the
*result* fingerprint to be byte-equal across rounds
(`record.call === last.call && record.result === last.result`, `:78-79`, and the
alternating equivalent `:91-95`). The mutating pre-guard (`beforeRound`) only fires on a
*repeated mutating* call. Forge ships several tools whose results change every call by
design — `wait` (returns the wall-clock time it finished), `get_system_status` (live
GPU/RAM), `monitor_execution` (cursors + timestamps). A loop that polls one of these
until a condition that never becomes true produces a *different* result fingerprint each
round, so neither detector can ever trip.

**Concrete failure scenario:** The agent is told to "keep checking until the build
passes" and the build never passes. Every `wait`/`monitor_execution` returns fresh
timing, so the guard stays silent and the loop runs to `maxRounds` (hundreds of rounds)
— burning tokens, VRAM time, and wall-clock, with no early bail. The guard is documented
as the protection against exactly this, but its equality test is blind to non-determinism.

---

## 9. Session persistence is fire-and-forget — silent transcript loss on quota failure — HIGH

**Where:** `src/sidebar/sessionPersistence.ts:283-288` (`saveSidebarSession`) and
`:298` (`saveActiveConversationId`).

**Evidence:** Both persist with `void workspaceState.update(...)`. The returned promise
is discarded: a rejection is never awaited, never logged, never retried. VS Code's
Memento `update` rejects when the workspace-state quota is exceeded. The code's own
comment (`:290-296`) records that the session blob was measured at **16 MB** in one
workspace — well within range of the per-workspace storage limit. When the quota trips,
`update` rejects, the transcript is *not* written, and nothing tells the user or the
log. The next reload (`loadSidebarSession`, `:245`) reads the last *successful* blob, so
the most recent conversations silently vanish.

**Concrete failure scenario:** A long session with large tool outputs grows the blob past
quota. The user keeps working (every save silently fails), closes the window, reopens —
the last N turns are gone with no error shown. Data loss with no diagnostic.

---

## 10. `format_file` saves the entire editor buffer, persisting unrelated unsaved edits — MEDIUM

**Where:** `src/tools/fileEditTools.ts` (`makeFormatFileTool` handler) —
`await doc.save()` after `applyEdit`.

**Evidence:** The tool loads the document with `openTextDocument` (no editor shown),
applies the formatter's edits via `applyEdit`, then calls `await doc.save()`. `save()`
flushes the **whole** `TextDocument` buffer to disk, not only the formatter's edits. If
the user had unsaved manual changes in that file, the agent's format call silently
writes those unrelated edits to disk too — a write the user never asked for and was not
shown as a diff (the diff decorations cover the tool's paths, not the user's pending
changes).

**Concrete failure scenario:** User is mid-edit in `config.yaml` with unsaved changes.
Agent runs `format_file` on it. The formatter's whitespace changes and the user's
half-finished manual edit are both committed to disk. The user's "discard my changes"
safety net (an unsaved buffer) is gone, and the checkpoint only captured the
pre-format disk state, so Undo now also reverts the user's own work.

---

## Notes on what is *not* a bug (checked, cleared)

- **Backend/background shutdown is wired correctly.** `extension.ts:465-471` registers
  `pool.stopAll()` and `backgroundExecutionManager.dispose()` as subscriptions, and
  `BackgroundExecutionManager.dispose()` (`:228-238`) clears timers and calls
  `terminateCliProcessTree` on every running job. No orphan-process leak on shutdown.
- **`ConfigWriter` is atomic.** `ConfigWriter.ts:84-88` backs up, writes to a temp path,
  then replaces with sharing-violation protection — the correct pattern that `XaiAuth`
  (#7) fails to follow.
- **Interrupted tool calls are repaired.** `repairInterruptedToolCalls`
  (`sessionPersistence.ts`) closes unanswered `tool_call` ids with an explicit
  unknown-result message, so a reload does not corrupt the strict chat template.
- **Disk-checkpoint restore enforces containment.** `DiskCheckpointRestore.ts:12-13`
  rejects targets outside the workspace root via `isPathInside`.

## Cross-cutting theme

The single highest-leverage fix is threading `mustBeInsideWorkspace` (or
`resolveRealWorkspacePath`) through every mutating tool (#1, #2): the guard already
exists and is used by the read tools, so the destructive tools are inconsistent rather
than the design being wrong. The second is bounding checkpoint capture (#3) and making
restore transactional (#4), which together turn the Undo feature from a potential
data-loss trigger back into the safety net it is meant to be.

---

# Addendum — verified additional findings (same session)

## 11. Disk-checkpoint capacity guard is inert by default — CRITICAL (aggravates #3)

**Where:** `src/checkpoint/CheckpointStack.ts` constructor —
`limits: CheckpointLimits = { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER }`.

**Evidence:** The `assertStorageCapacity` guard in `DiskCheckpointStore` (`:317`) only
means something if real limits are passed. The `CheckpointStack` default is
`Number.MAX_SAFE_INTEGER` for both bytes and file count, so unless a caller overrides,
the disk store's capacity check can never fire. Combined with #3 (uncapped memory
capture), **neither** checkpoint tier is bounded by default — the "disk store has a
capacity guard" mitigation noted under #3 does not apply to default configurations.

---

## 12. Commit re-captures every snapshotted path a second time — doubles the #3 OOM window — HIGH

**Where:** `src/checkpoint/CheckpointStack.ts:190-195` (`commitSession`).

**Evidence:** At commit, the stack re-runs `captureMemoryState(snapshot.filePath)` on
every snapshotted path to diff it against `originalState`
(`!isDeepStrictEqual(snapshot.originalState, captureMemoryState(snapshot.filePath))`).
So the uncapped, unbounded recursive read from #3 executes **twice per turn**: once in
`snapshotBefore`, once at commit — and `isDeepStrictEqual` then holds both Buffer sets
live simultaneously while comparing. A directory that fits in the first capture may
OOM on the second when the modified copy is also resident.

---

## 13. `ToolLoopGuard.beforeRound` permits two executions of an identical destructive call — MEDIUM

**Where:** `src/agent/ToolLoopGuard.ts:57-70`.

**Evidence:** The mutating pre-guard throws only when `length >= 2` and the two prior
records carry the same call fingerprint — its own message says "blocked before a **third**
execution." An identical `delete_file` / `write_file` therefore executes **twice** before
the guard fires. For idempotent writes that is harmless; for non-idempotent or partially
destructive sequences (e.g. `move_file` where the first move succeeded but the result
message was lost to a stream error, prompting an identical retry) the second execution
runs against changed state. Deliberate design, but the hazard is real and undocumented
in the tool descriptions.

---

## 14. `loadSidebarSession` migration writes are also fire-and-forget — MEDIUM (same class as #9)

**Where:** `src/sidebar/sessionPersistence.ts:263, 271, 276` — three
`void workspaceState.update(...)` calls in the load/migration path.

**Evidence:** Same un-awaited pattern as #9. If the quota rejects the
`SESSION_KEY_V1` write after legacy migration (`:271`), the legacy key is *also* cleared
at `:276` (or was already cleared at `:263`) — a rejected blob write beside a
successfully cleared legacy key means the migrated history exists only in memory and
is lost on reload, with no error surfaced anywhere.

---

## 15. Checkpoint stacks of closed (archived) conversations are retained until explicit delete or reload — MEDIUM

**Where:** `src/checkpoint/CheckpointStack.ts:43` (`stacks` map) vs
`src/sidebar/sessionPersistence.ts:249-251` (history slice to `MAX_HISTORY_CONVERSATIONS`)
and the close→archive path, which never calls `checkpoints.disposeConversation`.

**Evidence:** Entries in `this.stacks` — each holding up to `MAX_CHECKPOINT_DEPTH`
checkpoints with **full file-content Buffers** — are removed only by
`disposeConversation` (`:301-307`, called from explicit `deleteConversation`) or
`dispose()` (window reload). Closing a tab archives the conversation to history; its
stack, with all captured contents, stays resident. Archiving past 40 silently drops the
41st conversation from `session.history` with no disposal of anything. Bounded per
window (12 tabs + 40 history × depth), but a long session that repeatedly snapshots
large files across many conversations retains megabytes-to-gigabytes of buffers for
conversations the user can no longer reach.

---

## 16. `write_file` / `edit_file` are non-atomic truncate-then-write — user-file corruption on crash — HIGH

**Where:** `src/tools/builtinTools.ts:168` (`fs.writeFileSync(filePath, content)`),
`:202` (`appendFileSync`), `src/tools/editFileTool.ts:139` (`fs.writeFileSync(filepath, updated)`).

**Evidence:** The same flaw as #7, but on **user files**: every full-file write
truncates the target and streams the new content. A host crash, OOM (see #3 — whose
commit-time capture happens on the same turn), or disk-full mid-write leaves the file
truncated or empty. `append_file` is safe by construction, but `write_file` overwrites
existing content destructively before completion. The checkpoint captured at
`snapshotBefore` is the only recovery — and #3/#12 show that capture is itself the most
likely thing to be what crashed the host. `ConfigWriter.ts:84-88` demonstrates the
correct temp-file + replace pattern exists in this repo; the file tools don't use it.

---

## 17. `move_file` fails outright across volumes (EXDEV), no copy+delete fallback — LOW

**Where:** `src/tools/fileEditTools.ts:75` (`fs.renameSync(src, dst)`).

**Evidence:** `renameSync` throws `EXDEV` when source and destination are on different
filesystems (workspace on `N:`, destination on `C:` — a plausible absolute-path move,
see #1). The tool advertises "Move or rename a file or a directory... Destination parent
directories are created automatically" and creates the parents, then fails at the rename
with a raw `EXDEV: cross-device link not permitted` surfaced as a tool error. No
copy-then-delete fallback. Not data loss (the source survives; the checkpoint covers it),
but the operation the tool promises cannot succeed cross-volume, and the error text
offers the model no path forward.

---

## Ruled out during this pass (checked, not bugs)

- **Checkpoint eviction leak** — `evictBeyondDepth` results **are** released via
  `diskStore.discard(reference)` with error logging (`CheckpointStack.ts:210-214`).
  The leak suspicion applies only to the in-memory stack map (#15), not disk refs.
- **`rename_symbol` partial snapshot** — `mutation.paths` lists one path, but
  `beforeMutate(edit.entries().map(...))` snapshots every file the rename touches
  before `applyEdit`. Covered.
- **Remote-inbox retention** — `retain_days: null` (keep forever) is documented
  config behavior in FORGE.md, not an oversight.

---

# Addendum 2 — Pass: command-execution safety boundary

## 18. Denylist is bypassed by wrapping the command in a shell interpreter — HIGH

**Where:** `src/tools/DenyList.ts:41-67` (`isRecursiveForceDelete`) +
`src/tools/execTools.ts:154-172` (the `exec_command` guard sequence).

**Evidence:** `exec_command` runs four guards on `[command, ...args].join(' ')`:
`checkShellOperators` (only rejects a *bare* operator token like `"&&"`), `checkDenyList`,
`checkPowerShellBan`, and `guardExec`. None of them blocks a shell interpreter as the
*command*. `isRecursiveForceDelete` only treats `rm` as a command when it is the first
token or is preceded by a known wrapper (`COMMAND_PREFIXES = sudo/git/npx/pnpm/yarn/npm/
run/exec`, `DenyList.ts:23`). So:

```
exec_command("bash", ["-c", "rm -rf /some/path"])
```

joins to `"bash -c rm -rf /some/path"`. `rm` is preceded by `-c`, which is **not** in
`COMMAND_PREFIXES`, so the predicate `continue`s and never sees the `-rf`. The arg string
contains no bare operator token, so `checkShellOperators` passes. The command executes.
Same for `sh -c`, and `cmd /c "…"` for anything the Windows regexes don't happen to match
in their flat form.

**Why this is a bug, not a design choice:** the code's *own* rationale contradicts it.
`checkPowerShellBan` (`execHelpers.ts:149-172`) bans `pwsh`/`powershell -Command` with the
exact reasoning "a model-authored script cannot be checked by the denylist, so it is
never run." That rationale applies identically to `bash -c` / `sh -c` — the denylist is
blind to whatever is inside the script string — yet only PowerShell launchers are banned.
The two detectors are also internally inconsistent: `isDestructiveGitCheckout` searches for
`git` *anywhere* in the token list (`DenyList.ts:78`), so it *does* catch a wrapped
`bash -c "git checkout -- ."`, while `isRecursiveForceDelete` refuses to. One wrapped-command
detector exists; the destructive-delete one doesn't.

**Concrete failure scenario:** A prompt-injected or looping agent that has been denied
`rm -rf` directly (the tool refuses and suggests `delete_file`) reaches for
`exec_command("bash", ["-c", "rm -rf …"])`, which the denylist wave through. It is a
recursively-forced, unrecoverable delete the denylist was written to stop, executed with a
`terminal`/`headless` permission the user granted for legitimate builds. (Requires the
`exec.terminal`/`exec.headless` permission, which is deny-by-default — so the blast radius
is gated, but the guard that exists is the one people trust.)

**Fix direction:** treat `bash`/`sh`/`zsh`/`dash`/`cmd`/`cmd.exe`/`busybox` as script
runners and either ban `-c`/`/c` outright (mirroring `checkPowerShellBan`) or run the
denylist over the *script string* argument. Make `isRecursiveForceDelete` use the same
"command word appears after any flag/wrapper" logic as the git detector.

## 19. `guardExec` re-runs the denylist the handler already ran — duplicate call — LOW

**Where:** `src/tools/execTools.ts:159` (`checkDenyList(command, cmdArgs, getBuiltinDenyList())`)
and `:172` (`guardExec(command, cmdArgs)`); `guardExec` itself is
`execHelpers.ts:302-304`, which calls `checkDenyList(command, args, getBuiltinDenyList())`
again.

**Evidence:** In the `exec_command` path the denylist is evaluated twice against the same
inputs — once inline at `:159` (to throw the denylist-specific message with the
`alternative` text) and once via `guardExec` at `:172`. The second call can never fire on
`exec_command` (the first already threw), so it is dead on this path. `guardExec` *is*
needed by `run_tests`/`run_build`, which don't call `checkDenyList` directly — so the
function isn't dead overall, but the double-evaluation inside `exec_command` is redundant
and makes it non-obvious which guard is authoritative. Consolidating to a single
`guardExec` that carries the `alternative` text would remove the duplicate.

---

## Addendum 3 — `llm/` streaming layer (2026-09-08)

### 20. HIGH — A stalled stream is detected but never aborted; the turn hangs forever

**Where:** `src/llm/OpenAIClient.ts` (heartbeat block, ~L186–205) — and every
caller on the primary chat path.

**What the code does.** The streaming loop maintains `lastActivityAt` and a
15-second `heartbeat` interval that computes `idleMs`. When `idleMs >= 15_000`
it sets `streamStallWarned = true` and emits `log.warn(...)`. That is the
entire response to a stall. Nothing calls `controller.abort()`, nothing rejects
the promise, nothing invokes `onError`.

**Who supplies the abort signal.** The only signals reaching
`streamChatCompletion` are:

- `src/sidebar/PromptRun.ts` L134 — `new AbortController()`, published via
  `ctx.setController(ctrl, conversationId)` purely so a Stop button can fire.
  The docstring on `turnServices.ts` L36 is explicit: *"Publishes the controller
  so a global or owning-conversation cancel can abort this run."*
- `src/sidebar/ProviderTurn.ts` / `ModelTurn.ts` — same pattern; grep for
  `AbortSignal.timeout` and `watchdog` across `src/sidebar/**` returns nothing.
- `src/delegation/LocalDelegationService.ts` L84–86 — the **only** place that
  composes a real deadline (`AbortSignal.any([caller, AbortSignal.timeout(120s)])`).

So the delegation path is protected and the primary agent path is not.

**Concrete failure scenario.** llama-server (or an Ollama `:cloud` alias through
the daemon) accepts the connection, returns HTTP 200 with SSE headers, streams
some tokens, then wedges — the known failure modes are a KV-cache eviction
deadlock, a GPU hang that leaves the process alive but non-producing, and the
cloud relay dropping the upstream while keeping the socket open. The client
reads nothing, warns once in the log, and `await`s `reader.read()` forever.
`onDone` never fires, so the `new Promise` in `PromptRun` never settles; the
agent loop never advances; the conversation is stuck with a spinner and an
active turn that holds the backend. The only escape is the user pressing Stop —
and a remote user (phone → Telegram) has no Stop button on that wedged turn and
no signal anything is wrong, because the stall message went to the output log.

**Why this is a design flaw, not just a missing feature.** The heartbeat proves
the author knew idle streams happen — the counter, the warn threshold, and the
`streamStallWarned` flag all exist. The instrumentation was built; the reaction
was not. A 15s warn with no follow-through is strictly worse than no heartbeat,
because it produces a log line that looks like coverage while providing none.

**Fix shape.** Keep the `AbortController` owned by the caller but give the
client an inactivity budget: on the Nth consecutive idle heartbeat (or an
explicit `stallTimeoutMs` option), call `handlers.onError(new Error('stream
stalled after Nms idle'))` and `reader.cancel()` — not `onDone`, which would
let the loop treat a truncated generation as a completed turn.

**Secondary defect in the same block (LOW).** On natural EOF the loop breaks
without flushing `buffer` and without a final `decoder.decode()` call, so a
final SSE frame not terminated by `\n` — and any multi-byte character split
across the last two chunks — is silently dropped before `onDone` fires.
Spec-compliant servers always end frames with a newline, so this only bites the
non-compliant ones; but those are exactly the servers this file already carries
special-case handling for (Ollama compat, `finish_reason: ""`, `error:` lines).

---

# Maintainer review update — 2026-09-08

## Count and classification

**Confirmed bug count: 14 / 21 numbered findings.** This count includes safety,
correctness, persistence, and crash-resilience defects. It does not count deliberate
capabilities merely because they carry risk.

| Finding | Status | Rationale |
| --- | --- | --- |
| #1 | Intentional capability / risk accepted | File tools deliberately support absolute paths; permissions, confirmation, and displayed target are the chosen boundary. |
| #2 | **Confirmed bug** | A relative path without a workspace reaches the invisible extension-host CWD. |
| #3 | **Confirmed bug** | In-memory recursive checkpoint capture has neither byte nor file-count limits. |
| #4 | **Confirmed bug** | Restore deletes the target before a replacement is known to be writable. |
| #5 | Intentional capability / risk accepted | `to_trash: false` intentionally provides permanent deletion; its recovery wording should be safer. |
| #6 | Intentional edit semantic / risk accepted | `edit_file` intentionally replaces the first matching occurrence; callers need a sufficiently unique `old_str`. |
| #7 | **Confirmed bug** | Refresh overwrites credential JSON in place and can leave it corrupted after an interrupted write. |
| #8 | Bounded design limitation | Variable-result polling cannot be recognized as a no-progress equality cycle; `maxRounds` remains the safety bound. |
| #9 | **Confirmed bug** | Rejected Memento writes are discarded and cannot surface or recover from persistence failure. |
| #10 | **Confirmed bug** | Formatting saves the complete dirty buffer, including unrelated user edits. |
| #11 | **Confirmed bug** | Default disk checkpoint limits are effectively unbounded. |
| #12 | **Confirmed bug** | Commit re-captures full snapshots, doubling peak memory and traversal work. |
| #13 | Intentional retry tolerance / risk accepted | Allowing two identical mutating calls accommodates retried calls; the third is blocked. |
| #14 | **Confirmed bug** | Migration also discards rejected Memento updates and may clear the only persisted legacy copy. |
| #15 | Already fixed / ruled out | `ConversationTabs.close()` disposes the conversation's checkpoint stack before archiving it. |
| #16 | **Confirmed bug** | Full-file writes overwrite in place and can truncate a user file on interruption. |
| #17 | Intentional scope consequence | Cross-volume moves are unsupported by `renameSync`; this is low impact and chiefly exposed by intentional absolute-path support. |
| #18 | **Confirmed bug** | Script-runner wrapping bypasses the recursive-delete denylist. |
| #19 | **Confirmed bug** | `exec_command` evaluates the same denylist twice; the second evaluation is unreachable on that path. |
| #20 | **Confirmed bug** | The primary streaming path logs an idle stream but never settles it; its EOF decoder-flush issue is a LOW sub-defect. |
| #21 | **Confirmed bug** | Shared llama.cpp runtime discovery and leasing could race an owner shutdown, giving a borrower a server that is already stopping. |

## Proposed fixes for confirmed bugs

| Finding | Proposed fix |
| --- | --- |
| #2 | Reject relative file-tool paths when no workspace is open (or require an explicit absolute path); do not pass relative strings to Node filesystem calls. |
| #3 + #11 | Give memory and disk checkpoints conservative, explicit byte/file limits; preflight directory captures and fail before allocating beyond the limit. |
| #4 | Restore into a sibling staging path, validate the write, then atomically replace the target where supported; preserve the current target if staging fails. |
| #7 | Reuse the atomic temp-file-and-replace strategy used by `ConfigWriter`, retaining a backup and useful error diagnostic. |
| #9 + #14 | Make persistence operations awaited and serialized, preserve legacy data until the new write succeeds, and surface quota failures clearly in UI/log. |
| #10 | Refuse formatting a dirty document, or require confirmation that explicitly includes existing unsaved state; never silently commit unrelated buffer edits. |
| #12 | Avoid a second full capture: record lightweight mutation metadata/digests during capture, or compare only affected state under the same bounded policy. |
| #16 | Write replacements to a same-directory temporary file, then rename/replace; preserve the original on failure. |
| #18 | Treat `bash`, `sh`, `zsh`, `dash`, `cmd`, `cmd.exe`, and `busybox` with `-c`/`/c` as prohibited script runners, or parse and denylist their script argument. |
| #19 | Retain one authoritative denylist call in `exec_command` and leave `guardExec` for callers that do not pre-check. |
| #20 | Add a primary-stream inactivity deadline: cancel the reader and call `onError` after its budget. On EOF, flush `decoder.decode()` and process buffered SSE data before `onDone`. |
| #21 | Atomically publish owner/lease records and use a drain-and-recheck protocol: an owner first stops accepting borrowers, then checks leases; a borrower acquires a lease and verifies the same active owner before adopting it. |

## Follow-up for intentional choices

- #1: Keep absolute paths, but make out-of-workspace confirmation visually distinct and require the full resolved target in approval text.
- #5: Remove wording that recommends permanent deletion as a general fallback after a failed trash operation; report the original trash failure instead.
- #6: Document first-match behavior and encourage surrounding context in `old_str`; an opt-in `require_unique` parameter can be considered later.
- #8: Keep the round ceiling and consider a separate explicit polling budget for `wait` and monitoring tools.
- #13: Document the two-call retry allowance and show a prominent warning/diff before a repeated destructive call.
- #17: Return an actionable `EXDEV` error explaining that cross-volume moves are unsupported.

## Addendum 4 — shared-runtime borrow/shutdown race (2026-09-08)

### 21. HIGH — A shared runtime could be borrowed while its owner was stopping

**Where:** `src/backend/SharedRuntimeRegistry.ts`, `src/backend/poolAcquisition.ts`, and
`src/backend/BackendPool.ts`.

**Evidence:** The old borrower path read the owner record, health-checked its endpoint,
then created its lease. In the interval, the owner could check for borrowers, observe
none, and stop the server. The late borrower then adopted an endpoint that was already
being torn down. Owner and lease JSON were also written in place, allowing readers to
mistake an interrupted concurrent write for an absent record.

**Implemented fix:** owner and lease records now use staged atomic replacement. Before
stopping, an owner marks its record as draining, which hides it from new borrowers, then
checks leases. A borrower creates a lease and verifies that the same owner is still active;
otherwise it removes that lease and falls back to normal startup. This closes both orderings
of the stop/borrow race without changing the intentional multi-window sharing capability.
