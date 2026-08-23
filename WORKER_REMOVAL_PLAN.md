# Worker-role removal (impl plan)

Companion to `RELIABILITY_HARDENING_PLAN.md`, split out because it is a
different kind of change: Phases 1-5 there are reliability fixes; this is a
product decision that happens to delete a failure surface. Sequenced as step 3
in that plan's ordering.

### Rationale

This is a product decision, not a reliability fix — it belongs in this cycle
because it deletes state space rather than because it fixes a bug.

The justification is **value against cost**: the worker-role system does not
provide enough user value to justify its additional execution states,
permission surface, scheduling semantics, UI state and failure modes.
`ask_local_agent` already delivers the genuinely valuable pattern (primary
agent asks a specialist for an opinion, result returns) with none of that
machinery.

Deliberately *not* the justification: "it doesn't fit a single-slot 16 GB
machine." Forge should not architect itself around one hardware configuration.
If the only reason were today's VRAM limit, this deletion would be wrong.

Deleting it closes HIGH-3 and LOW-1 outright.

### Delete

- `src/workers/` — entire directory (960 LOC, 7 files)
- `src/tools/dispatchWorkersTool.ts`, `src/sidebar/WorkerTurn.ts`,
  `src/vscode/workerCommands.ts`, `src/agents/CliWorkerRunner.ts`
- Tests: `WorkerAccessPolicy`, `WorkerLoop`, `WorkerLoopCli`,
  `WorkerOrchestrationService`, `WorkerPrompts`, `WorkerToolRegistry`,
  `CliWorkerRunner`

### Edit

- `src/tools/registerAllTools.ts` — drop the `dispatch_workers` registration.
- `src/sidebar/ToolDispatch.ts` — remove `workerRunner`, `setWorkerRunner`
  (`L177-201`), the dispatch branch (`L328`), the worker-scope guard (`L259`).
  **This file has uncommitted working-tree changes — land or stash first.**
- `src/sidebar/AgentLoop.ts`, `turnServices.ts`, `ModelTurn.ts` — drop wiring.
- `src/sidebar/messageBridge.ts` — remove `WorkerStatusMsg` (`L149-166`) and
  its union member (`L262`).
- `src/backend/BackendPool.ts` — **delete** the public
  `acquireGroupForDelegation` / `DelegationGroupHold` re-export. Verified: its
  only caller is `WorkerOrchestrationService.ts:106`, so it becomes a
  zero-caller public API. *This supersedes the earlier decision to deprecate
  it*: that rested on treating pool wrapper and gate primitive as one thing.
  They are two layers, and `DelegationGate.acquireGroup()` stays **live** —
  `acquire()` implements the single-target path through it
  (`DelegationGate.ts:90-91`). Keep the internal primitive, drop the unused
  public surface. Reliability benefits from a smaller API.
- `src/tools/ToolRegistry.ts` — drop the `WorkerRunRequest` import and the
  `'cloud-worker'` permission member.
- `src/config/schema.ts` — **keep** `permissions.agents.cloud_workers` (`L196`)
  and `'cloud-worker'` in the MCP permission enum (`L24-29`), deprecated by
  comment. Still validated and parsed; grants nothing.
- `src/tools/PermissionResolver.ts` — drop the `cloud-worker` clause (`L40`),
  commenting that the omission is deliberate.
- `package.json` — remove the `forge.dispatchLocalWorkers` contribution.
- `docs/OWNERS.md` — delete the rows for every removed module.

### Config compatibility

An existing `config.yaml` with `permissions.agents.cloud_workers: true` must
not fail Zod validation — a stale key that hard-fails startup turns a removed
feature into an unbootable extension. Keeping the explicit deprecated field
(rather than `.passthrough()`, which would swallow every typo in that object)
gives precise compatibility: known deprecated key accepted and inert, unknown
key still rejected.

Log once at load when the key is present — *"permissions.agents.cloud_workers
is deprecated and has no effect"* — so old configs are self-diagnosing rather
than sending the user to `CHANGES.md`. Add the `CHANGES.md` note too.

### Tests to update, not delete

`PermissionResolver`, `RegisterAllTools`, `ToolDispatch`, `ToolHarness`,
`ToolResultView`, `ControlServer`, `toolSummary`, `ToolRow.dom` — each
references workers incidentally; remove the reference, keep the test.

