# Source Split — Round 2 (the eleven files at the cap)

Status: plan, 2026-09-23. Implementer: Codex, full auto, in a worktree. Reviewer: Claude
(reviews the finished branch once; no live monitoring).

Follows `docs/plans/SOURCE_SPLIT_PLAN.md` (round 1, done). Same rules; read its header
and "Standing constraint A" before starting.

## Problem

Eleven source files sit at exactly 500 lines, the `max-lines` hard stop. Any feature
touching them fails `npm run ci`, so the next change to any of them turns into an
unplanned split under deadline, which is how bad splits happen. Measured with `wc -l`
on `4dab0b9`:

| File | Lines |
| --- | --- |
| `src/sidebar/SidebarProvider.ts` | 500 |
| `src/sidebar/AgentLoop.ts` | 500 |
| `src/sidebar/ToolDispatch.ts` | 500 |
| `src/sidebar/SlashCommandHandler.ts` | 500 |
| `src/remote/RemoteRuntime.ts` | 500 |
| `src/remote/RemoteRequestStore.ts` | 500 |
| `src/remote/RemoteController.ts` | 500 |
| `src/jobs/agentTask.ts` | 500 |
| `src/jobs/JobScheduler.ts` | 500 |
| `src/extension.ts` | 500 |
| `src/config/types.ts` | 500 |

Goal: each file ends **at or below 450 lines**, giving room for the next feature, and every
cut follows a real seam. CLAUDE.md's rule is concerns per file, not lines. A cut that needs a
context object threaded through call sites only to shed lines is **rejected**. In that case
the file stays, and the plan records why and where its next feature goes instead.

## Rules (all phases)

- Pure moves. Behaviour, public exports, message/prompt ordering, persisted shapes and
  lifecycle events stay unchanged. Moved code is moved verbatim, apart from the minimum
  needed to turn a method into a function (`this.x` becomes a parameter).
- Callers keep their imports where practical: if a moved export has outside importers,
  re-export it from the original file rather than editing every importer. `config/types.ts`
  and `messageBridge.ts` are import surfaces and **must** re-export.
- Tests are not edited except import paths. A test that needs a behaviour change means the
  move was not pure: revert that file and record it under "Outcome".
- Every new module gets its `docs/OWNERS.md` row in the same commit.
- **One commit per file**, message `refactor(<area>): <what moved> out of <File>`, staged
  by name (never `git add -A`). `npm run ci` is green before each commit. A test that fails
  in a file you did not touch: rerun it alone with `npx vitest run <file>`; if it passes
  alone, it is a known flake (AgentRoutes, TelegramContact*, JobSchedulerOwnership). Note it
  and continue.
- No new dependencies, no config changes, no CHANGES.md entry (nothing user-visible).
- If a candidate seam below turns out not to be real, do not force it. Look for the
  file's best real seam instead. If none exists, leave the file and write the verdict,
  with the reason and the named destination for future growth, under "Outcome".

## Candidate seams (verify each before cutting)

Line anchors are from `4dab0b9`. Re-read the file first; the anchors are a map, not a
contract.

1. **`SlashCommandHandler.ts`**: the `/init` Forge-file generator, lines ~275–472:
   `initForge`, `extractMarkdownFromToolCall`, `collectWorkspaceContext`,
   `buildInitForgePrompt`. Move to `src/sidebar/initForgeCommand.ts`; the class keeps a
   one-line delegation. It is self-contained (workspace scan, prompt build, markdown
   extraction), so this is the clearest seam in the set.
2. **`ToolDispatch.ts`**: the delete-confirmation preview, lines ~28–160:
   `DeleteInventory`, `DELETE_PREVIEW_LIMIT`, `DELETE_SCAN_LIMIT`, `describeDelete`,
   `inspectDeleteDirectory`, and `isExistingDirectory` if only they use it. Move to
   `src/sidebar/deletePreview.ts`. `WRITE_PERMISSIONS` stays.
3. **`agentTask.ts`**: the model contract of an agent-task job: `buildPrompt` (method,
   ~308–449) plus `parseResult` (~467) and its helpers. Move to
   `src/jobs/agentTaskPrompt.ts`. `buildPrompt` becomes a function taking the
   deps it reads. If that needs more than ~3 parameters, it is context threading: take
   `parseResult` plus whatever pure helpers qualify and leave `buildPrompt`.
4. **`JobScheduler.ts`**: `runCheck` + `applyBackoff` (~429–500), the pre-run check and
   failure backoff. Verify they do not reach into scheduler lease/timer state; if they do,
   find another seam (e.g. `maybeSleepIfIdle`) or LEAVE.
5. **`AgentLoop.ts`**: `emitAgentProgress` (~414–491), the progress fan-out. Verify
   which fields it reads; move to `src/sidebar/agentProgressEmitter.ts` only if that
   is a small, explicit dependency set.
6. **`SidebarProvider.ts`**: `handleMessage` (~444–491) belongs with
   `src/sidebar/webviewMessageRouter.ts`, which already exists. Also check the
   constructor (~64–235) for wiring that belongs in `sidebarWiring.ts` /
   `sidebarFacadeWiring.ts` (Standing constraint A: SidebarProvider is a facade; wiring goes
   to the wiring files, never to a new sibling).
7. **`extension.ts`**: `activate()` is a single function of ~430 lines. Find 2–3
   self-contained setup blocks (one subsystem each) and move them into setup modules
   following the existing `src/vscode/*Setup.ts` pattern (e.g. `agentMeshSetup.ts`).
   Keep registration order identical, since disposal order and `context.subscriptions`
   order matter.
8. **`config/types.ts`**: the media config interfaces (`ImageBackendConfig`,
   `ImageGenerationConfig`, `ImageSearchConfig`, `VideoConfig`, `VoiceConfig`, ~267–361).
   Move to `src/config/mediaTypes.ts`, re-exported from `types.ts` so that no importer
   changes.
9. **`RemoteController.ts`**: `handle()` is ~237 lines (~232–469). Standing constraint A
   keeps admission and queue logic here. Find a non-admission section inside `handle` (for
   example callback/button routing or control-event handling) that can move to its own
   module. `RemoteCommandHandler.ts` is at 481, so do not grow it. If every branch is
   admission, LEAVE with that verdict.
10. **`RemoteRuntime.ts`**: `validationStatus` (~213–251) is a read-only projection. Verify
    it and move it to `src/remote/remoteValidationStatus.ts`. Standing constraint A keeps
    runtime wiring here, so do not move the transport lifecycle
    (`replace`/`takeOver`/`restore`/`applySerializedStop`).
11. **`RemoteRequestStore.ts`**: every mutator goes through the private `mutate()`, so
    splitting mutators means threading `mutate`, which is rejected. Look for pure
    projections over `RemoteStoreState` (the outbox ordering in `pendingOutbox`,
    `requestHealthForConversation`, `bindingsForWorkspace`) that can become functions of
    the state in `src/remote/remoteRequestQueries.ts`. If that does not reach 450, LEAVE
    and record it.

## Order

Do the files in the numbered order above; the easy, clear seams come first. Each is
independent. A failure on one file does not stop the others: revert it, record it, and move
on.

## State × lifecycle ledger

no durable state (a pure refactor: no files, config fields, leases or queue items are
created or changed; `RemoteRequestStore`'s persisted shape is explicitly out of scope).

## Acceptance criteria

- Each of the eleven files is at or below 450 lines, **or** has a LEAVE verdict under
  "Outcome" with the reason and the named destination for its next feature.
- Every commit is a pure move: `git show --stat` removed and added lines balance within the
  delegation/import overhead, no test changed except imports, and `npm run ci` is green.
- No `.ts`/`.tsx` file in the repo exceeds 500 lines afterwards, including the new modules
  and the re-export surfaces.
- Every new module has an `OWNERS.md` row; no concern gets two owners.
- `config/types.ts` and `messageBridge.ts` importers are unchanged.
- A final `npm run ci` on the branch tip is green, and `git status` is clean.

## Outcome

(Codex fills this in: one line per file: new line count, commit hash, or LEAVE + reason +
growth destination.)
