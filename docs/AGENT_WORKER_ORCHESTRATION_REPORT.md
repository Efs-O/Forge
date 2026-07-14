# Worker Orchestration Implementation Plan

## Status

**Implementation complete in the current worktree. `npm run ci` and
`npm run package` pass on 2026-07-13 (37 test files / 266 tests); interactive
Extension Development Host smoke cases remain before a release-ready
declaration.**

Implementation tracking:

| Area | Status |
| --- | --- |
| Phase 0 canonical owners/refactors | Implemented; primary and worker paths share `ToolCallingLoop` |
| Backend group admission and serial fallback | Implemented |
| Exact-path worker access policy and budgets | Implemented |
| Worker loop and orchestration service | Implemented |
| Direct command and model tool | Implemented |
| Typed worker status UX | Implemented |
| Automated coverage and release gates | Passed: 37 test files / 266 tests; VSIX packaged |
| Live local/cloud/UI smoke matrix | Pending manual Extension Development Host verification |

The detailed unchecked items below remain the acceptance-review matrix; they
are intentionally not used as a second, drifting implementation-status list.

This revision supersedes the earlier local-only draft. Changes from that
draft: worker targets may be any configured Forge model (local or cloud),
workers read the whole workspace (workspace-contained and budgeted),
same-backend capacity shortfalls run labelled-serial while impossible
residency is rejected explicitly, the timeout model is one generous run
backstop plus Stop, and the direct user command is the primary v1 entry
point (the model tool is secondary). Cloud worker targets require a new
opt-in `agents.cloud_workers` permission.

```text
Coordinator model (any configured primary)
├─ worker A (local or cloud model) → edits its assigned file(s)
├─ worker B (local or cloud model) → edits its assigned file(s)
└─ coordinator → reviews completed changes and worker summaries
```

`ask_local_agent` remains a separate, bounded, read-only consultation
mechanism. Do not broaden it and do not reimplement completed items from
`COMBINED_UNFINISHED_IMPLEMENTATION_PLAN.md`.

## Design Stance

The shape follows Claude Code subagents: broad read access, trust the
review step, one cancel button. Forge keeps extra machinery only where it
faces a constraint Claude Code does not have:

1. **Local backends are finite.** Local workers can evict each other or the
   coordinator. Local targets need atomic group admission via
   `DelegationGate`. Cloud targets have no such constraint and skip
   admission entirely.
2. **Local worker models are weak.** Write access is limited to exact,
   coordinator-assigned files so a small model cannot wander.
3. **Keep/Undo is a Forge product feature.** All worker writes join the
   coordinator turn's single checkpoint.

Everything else stays simple on purpose.

## Current Baseline (must be reused)

- `LocalDelegationService` / `ask_local_agent` (read-only consultation);
- `BackendPool` + `DelegationGate` atomic non-evicting holds;
- `ChatClient` routing (llama.cpp, Ollama local/cloud, xAI, OpenRouter,
  OpenAI-compatible incl. Cerebras), request normalization, sampling merge;
- `ToolRegistry`, `PermissionResolver`, strict schemas, native/fallback tool
  parsing, per-action confirmation flow;
- mutation metadata, `CheckpointStack`, diff cards, Keep/Undo;
- primary-turn cancellation and `src/tools/resultCap.ts`;
- MCP per-tool permission classification; localhost `ControlServer`.

Known finding (2026-07-13): local primary models did not reliably call even
the simple `ask_local_agent` tool. Therefore the direct command — not the
model tool — is the supported v1 entry point, and it is built first.

## Version-One Product Contract

- A run contains one or two workers (`MAX_WORKERS = 2`).
- Each worker names **any configured Forge model**: local llama.cpp, local
  Ollama, Ollama cloud tag, or an opt-in cloud provider (xAI, OpenRouter,
  OpenAI-compatible). Only already-configured targets are eligible; no new
  endpoints or secrets.
- Local targets pass `DelegationGate` group admission (pin, no eviction).
  Cloud targets skip admission. Mixed runs admit only the local subset.
- Concurrency contract — **labelled serial where safe, otherwise explicit
  rejection** (serial execution cannot create residency):
  - all local workers on one resident backend with `n_parallel` too low:
    run serially with a visible "running serially" label;
  - distinct local models that cannot be resident together with the
    coordinator: reject clearly before any mutation (no backend
    stop/reload swapping — Forge has no run-owned sequential lease);
  - cloud workers are always independently concurrent.
- Workers may call `read_file` and `list_directory` anywhere inside the
  workspace — enforced as **workspace-contained paths at dispatch** by
  `WorkerAccessPolicy` (the primary agent's absolute-path tool behavior is
  unchanged) — and `write_file` / `replace_in_file` only on their exact
  assigned writable paths.
- No terminal, delete, move, git, network, MCP, delegation, memory, UX, or
  user-prompt tools for workers.
- Every write passes the existing permission resolver, confirmation UI,
  mutation metadata, checkpoint, diff, and cancellation path. Concurrent
  approval requests queue FIFO, one card at a time, labelled with worker ID,
  model, and target path.
- Worker internal messages are not added to the primary conversation. A
  worker's result is its status, final text, and **changed paths verified
  from mutation metadata** — never from the worker's own claims.
- All worker mutations in one coordinator turn form one Keep/Undo
  checkpoint. Partial results stay visible; nothing is silently rolled back.
- One worker's failure does not cancel its sibling. Stop cancels the run.
- One run-level timeout backstop covers startup and generation. Backend
  loading shows a distinct "loading model…" activity state.
- After workers settle, the coordinator receives the structured results and
  performs a normal review continuation (default review prompt when
  `review_task` is omitted).

### Non-goals

- No recursion, no more than two workers, no worker terminal/test/build/git
  actions, no automatic merging of overlapping writes, no backend eviction
  to make a run fit, **no sequential backend stop/swap lease**, no
  long-lived worker tabs, no Relay dependency, no new MCP server, no VRAM
  estimator (slot admission is enforced; memory headroom stays best-effort).

## Authorization

`dispatch_workers` is advertised on the static minimum of `agents.delegate` and
`fs.read`. Dispatch-time validation additionally requires `fs.write` when any
worker has `access: "write"`; an all-read run does not require write permission.
Runs containing any **cloud worker target** additionally require a new
`permissions.agents.cloud_workers`, **defaulting to `false`** — the
existing `delegate` permission was granted for local read-only consultation
and must not silently authorize autonomous workspace egress (worker reads
never prompt, and clanker mode bypasses non-dangerous confirmations). An
LLM-supplied argument can never grant authority. Extend the canonical
registry so a tool can require multiple permissions; advertisement and
dispatch check the same complete static set. Map `agents.cloud_workers` to a
new `cloud-worker` `ToolPermission`. Because cloud authorization depends on
the selected model arguments, the tool remains advertised for eligible local
targets without `cloud-worker`; the handler/service performs the additional
runtime check when any selected route is cloud. The direct picker hides cloud
targets unless `cloud-worker` is granted.

Cloud-worker runs show a launch approval naming the provider, endpoint
label, task, and that workspace file contents may leave the machine. This
approval is **dangerous-class: not bypassed by clanker mode**. Add canonical
argument-aware permission and approval metadata to `RegisteredTool` so `ToolDispatch` does
not hardcode `dispatch_workers`; direct and model entry points both use the
same `ToolApprovalService`. Per-write confirmation and round/token caps bound
autonomous provider spend.

## Dispatch Schema

One model-invoked tool `dispatch_workers`; every object uses
`additionalProperties: false`.

| Field | Contract |
| --- | --- |
| `workers` | required array, 1–2 entries |
| `workers[].id` | required, unique, `^[a-zA-Z0-9_-]{1,40}$` |
| `workers[].model` | required, any configured Forge model |
| `workers[].task` | required, 1–4,000 characters |
| `workers[].access` | required, `read` or `write` |
| `workers[].context_files` | optional, ≤16 relative paths — prompt hints ("start by reading these"), not a read restriction |
| `workers[].allowed_paths` | absent for `read`; required with 1–8 unique relative paths for `write` |
| `workers[].max_output_tokens` | optional int, 1–4,096; default 1,024 — per model completion |
| `review_task` | optional, ≤2,000 characters; default review prompt applied when absent |

Runtime validation rejects absolute paths, traversal, symlink escapes,
directories in `allowed_paths`, and **write/write overlap between workers**
after canonicalization. Missing writable files are valid; containment is
checked via the nearest existing real parent, re-checked at creation time.
The complete worked JSON example lives in the tool description — local
models call tools far more reliably with an inline example.

`list_worker_models` is a separate read-only-over-config tool guarded only by
`agents.delegate`. It uses the same advertisement predicate as
`dispatch_workers`, reports exact configured names plus route/profile/alias
metadata, and omits cloud routes unless `cloud_workers` is enabled.

## Runtime Limits (`src/workers/limits.ts`)

| Limit | Value |
| --- | ---: |
| maximum workers | 2 |
| task chars / review chars | 4,000 / 2,000 |
| context-file hints per worker | 16 |
| writable files per worker | 8 |
| output tokens per completion (default / cap) | 1,024 / 4,096 |
| tool rounds / tool calls per worker | 8 / 16 |
| max bytes per read file (checked before read) | 256 KiB |
| max cumulative read bytes per worker | 2 MiB |
| max chars per tool result (via `resultCap.ts`) | 24,000 |
| max cumulative tool-result chars per worker | 96,000 |
| max directory entries per `list_directory` result | 500 |
| final worker text | 24,000 chars |
| whole-run timeout backstop | 600 s |

Read/result budgets exist because intermediate tool results are otherwise
unbounded: `read_file` slurps whole files, oversized results have previously
blown 32K slot contexts, and for cloud workers read volume is egress volume.
The backstop covers startup, approval waits, and generation. Expiry surfaces
as an explicit timeout result, never disguised as completion. Stop is the
primary control.

## Architecture and New Modules

| Concern | Canonical owner |
| --- | --- |
| Neutral workspace containment | `src/util/WorkspacePaths.ts` |
| Local/direct-cloud/Ollama-cloud route classification | `src/llm/ModelRouteClassifier.ts` |
| Cloud base-URL + credential resolution | `src/llm/CloudRequestResolver.ts` |
| Reusable model/tool round loop | `src/agent/ToolCallingLoop.ts` |
| Confirmation lifecycle + FIFO queue | `src/sidebar/ToolApprovalService.ts` |
| Worker types (incl. `WorkerRunContext`), limits, prompt contract | `src/workers/types.ts`, `src/workers/limits.ts` |
| Worker read/list/write access policy | `src/workers/WorkerAccessPolicy.ts` |
| One worker's scoped execution | `src/workers/WorkerLoop.ts` |
| Validation, admission, fan-out, settle | `src/workers/WorkerOrchestrationService.ts` |
| Model-invoked tool | `src/tools/dispatchWorkersTool.ts` |
| Direct command workflow | `src/vscode/workerCommands.ts` |

Split before any file exceeds 350 LOC. Do not add worker logic to the
already oversized `AgentLoop.ts`, `SidebarProvider.ts`,
`nativeCommands.ts`, or `ControlServer.ts`.

## Phase 0 — Consolidation (before any worker code)

### P0.1 Canonical workspace path guard

- [ ] Create `src/util/WorkspacePaths.ts` by moving (not copying) behavior
      from `resolveToolPath` and the delegation symlink check: relative
      resolution, realpath containment, missing-file containment via nearest
      existing parent; Windows case/separator-safe.
- [ ] Migrate `builtinTools.ts`, `fileEditTools.ts`, `dirTools.ts`,
      `lspTools.ts`, `uxTools.ts`, `ToolDispatch`, and
      `LocalDelegationService`; delete the superseded helpers.
- [ ] Tests: traversal, sibling-prefix, case, separator, symlink,
      missing-parent.

### P0.2 Diff/config ownership

- [ ] Keep wire diff types in `messageBridge.ts`; import from `DiffUtils.ts`
      and remove its duplicates. Add `StarterConfig.ts` to `docs/OWNERS.md`.

### P0.3 Extract the confirmation lifecycle

- [ ] Move pending-confirmation storage, posting, resolution, reveal,
      clanker handling, and cancellation cleanup from `AgentLoop.ts` into
      `ToolApprovalService.ts`; add FIFO queuing (one card at a time,
      worker-labelled). Cancelling a run resolves its pending approvals as
      declined — no orphan promise or spinner.

### P0.4 Extract the reusable tool-calling loop ⚠ highest-regression-risk step

- [ ] Move the provider stream-round loop, native/fallback selection,
      structured-output stripping, repeated-call protection, round limit,
      and tool-result continuation from `AgentLoop.ts` into
      `ToolCallingLoop.ts` with injected request construction, tools, scoped
      dispatch, cancellation, and activity callbacks.
- [ ] Land as its own commit; primary `AgentLoop` adopts it first, and all
      existing primary-agent tests must pass before and after. Never create
      a second streaming/fallback loop in `WorkerLoop.ts`.

### P0.5 Turn-scoped checkpoints

- [ ] `CheckpointStack.beginTurn` returns a `CheckpointSession` owning that
      turn's pending snapshots; pass it into `ToolDispatch`. All workers in
      a run share the coordinator turn's session; snapshot stays synchronous
      before each first mutation and must be race-safe across interleaved
      async worker loops. Commit once after the turn settles; preserve all
      existing checkpoint tests.

### P0.6 Multi-permission requirements and tool scopes

- [ ] Add `additionalPermissions?: readonly ToolPermission[]` to
      `RegisteredTool`; one helper enforces the full set in `definitions()`
      and `dispatch()`, and confirmation detection considers the full set.
- [ ] Add argument-aware approval metadata to `RegisteredTool`; use it to
      mark cloud-containing `dispatch_workers` calls dangerous without adding
      a tool-name special case to `ToolDispatch`.
- [ ] Add an explicit allowed-tool-name scope to `ToolRegistry`/
      `ToolDispatch`; scoped dispatch rejects out-of-scope tools.
- [ ] Test hidden/blocked behavior when `delegate` or `write` is absent,
      native and fallback paths.
- [ ] Add `agents.cloud_workers` (default `false`) to the config schema and
      map it to a new `cloud-worker` capability in `PermissionResolver`.

### P0.7 Extract cloud request resolution

- [ ] Create `src/llm/CloudRequestResolver.ts` returning
      `{ baseUrl, apiKey }` per model, with `SecretStorage` injected —
      `ChatClient` requires the caller to supply both, and that logic is
      currently duplicated in `AgentLoop` (~196–213) and
      `ControlChatProxy` (~53–95).
- [ ] Migrate `AgentLoop` and `ControlChatProxy` to it; workers use the same
      owner — never a third copy. Credentials never appear in worker
      requests-as-stored, results, logs, or config.

### P0.8 Canonical model-route classification

- [ ] Add `src/llm/ModelRouteClassifier.ts` returning `local-llama`,
      `local-ollama`, `ollama-cloud`, or `direct-cloud`.
- [ ] Detect Ollama `-cloud` / `:cloud` tags in this owner and migrate the
      existing consultation eligibility check to it. `ConfigResolver` still
      owns alias/profile resolution; it does not own route classification.
- [ ] Use the classifier for backend admission, `cloud-worker` enforcement,
      cloud approval, direct-picker filtering, and UX labels.

## Phase 1 — Backend Admission (local targets only)

Extend `DelegationGate`; no worker-specific pool.

- [ ] Resolve each worker target through `ConfigResolver`, then classify it
      through `ModelRouteClassifier`; direct-cloud targets bypass admission
      and dispatch through `ChatClient` with `CloudRequestResolver`.
      Ollama-cloud targets use the local daemon transport but are treated as
      cloud for permission, approval, egress labelling, and documentation.
- [ ] Add `acquireGroup(primaryModel, localTargets, signal)` — one
      idempotent group hold; `acquireForDelegation` becomes a compatibility
      wrapper. Normalize via `ConfigResolver`/`BackendPool.poolKey`;
      deduplicate shared base models.
- [ ] In one synchronous admission segment: verify capacity, pin the local
      coordinator when applicable, pin unique targets, claim slots without
      eviction. On failure, release everything and name the failed target.
- [ ] Concurrency probe: workers sharing one resident llama.cpp base run in
      parallel only when the running backend's effective `n_parallel` covers
      them (expose via `BackendPool`); otherwise run them **serially under
      the same hold with a visible "running serially" label**.
- [ ] Distinct local models that cannot all be resident alongside the
      coordinator: **reject clearly before execution** — no backend
      stop/swap, no eviction, no unlabelled behavior. Ollama concurrency
      stays best-effort and is labelled.
- [ ] Release the group hold in `finally` after all workers settle.

Acceptance: cloud-only run needs no hold; shared-base parallel with
sufficient `n_parallel`; labelled serial with `n_parallel = 1` on one
backend; residency-impossible run rejected naming the target; already-loaded
targets reused; no eviction ever; cancellation/startup failure releases all
pins.

## Phase 2 — Worker Access Policy

One immutable `WorkerAccessPolicy` per worker, enforced at tool dispatch
(not just in the prompt), covering all five surfaces: read-file paths,
listed directories, write paths, static mutation metadata, and dynamic
`beforeMutate` paths.

- [ ] Reads/lists: require workspace-contained paths (P0.1 guard; reject
      absolute/escaping paths for workers). The primary agent's existing
      absolute-path tool behavior is not changed.
- [ ] Writes: exact assigned files only; reject write/write overlap between
      workers after canonicalization; re-check parent containment at
      creation time.
- [ ] Enforce per-file size before reading and cap every tool result via
      `resultCap.ts`; track cumulative read/result budgets per worker.
- [ ] Record changed paths only from verified mutation metadata.

## Phase 3 — Worker Loop

- [ ] `WorkerLoop` = thin configuration of `ToolCallingLoop`: existing
      config resolution, `ChatClient`, sampling merge, normalization.
- [ ] Tools: `read_file`, `list_directory` (workspace-contained, read-only,
      budgeted), `write_file`, `replace_in_file` (exact paths) — dispatched
      through canonical `ToolDispatch` under `WorkerAccessPolicy`, the
      approval service, and the shared checkpoint session.
- [ ] System prompt: names the exact writable paths, lists `context_files`
      as suggested starting reads, requires tool calls for writes, forbids
      claiming unperformed work, requests a concise final summary.
- [ ] First declined mutation approval is terminal `declined` for that
      worker. A success claim without a verified mutation is
      `completed_no_changes`.
- [ ] Bound rounds, calls, tokens, and final text. Store no worker
      chain-of-thought.

Terminal statuses: `completed`, `completed_no_changes`, `declined`,
`cancelled`, `timed_out`, `failed_startup`, `failed_model`, `failed_tool`.

## Phase 4 — Orchestration Service

Both entry points share one invocation-scoped context so checkpoint
behavior cannot diverge:

```ts
interface WorkerRunContext {
  checkpoint: CheckpointSession;
  conversationId: string;
  abortSignal: AbortSignal;
  toolDispatch: ScopedToolDispatch;
}
```

- [ ] `AgentLoop` is the sole checkpoint-lifecycle owner. The direct-command
      path uses a new public `AgentLoop.runWorkerTurn(...)` that begins the
      session, builds the `WorkerRunContext`, executes the run, performs
      coordinator review, and commits exactly once in `finally`. A
      model-invoked tool is already inside `AgentLoop.runTurn`, so it reuses
      that existing session through an extended `ToolHandlerContext` and
      never begins or commits a nested turn.
- [ ] `WorkerOrchestrationService` (injected config, backend, worker-loop,
      activity, clock) consumes the context and **never begins or commits
      checkpoints itself**.
- [ ] Order: permission → schema → eligibility → access policy → admission →
      run (parallel or labelled-serial) with `Promise.allSettled`;
      per-worker history and cancellation combined from the primary signal
      and the run backstop; sibling failures independent; hold released in
      `finally`.
- [ ] Result: run ID, per-worker id/model/status/summary/error, verified
      changed paths, execution mode (parallel/serial/best-effort), aggregate
      status (`completed` / `partial` / `failed` / `cancelled`), rendered
      through one formatter capped by `resultCap.ts`.

## Phase 5 — Entry Points and UX (direct command first)

### P5.1 Direct command (primary v1 entry point)

- [ ] `forge.dispatchLocalWorkers` — `Forge: Dispatch Workers` in
      `package.json`, registered in `src/vscode/workerCommands.ts`.
- [ ] QuickPick/InputBox flow: 1–2 workers, model (any configured), task,
      writable paths, optional context hints and review task; one final
      summary confirmation before starting (does not replace per-write
      approval).
- [ ] Calls `AgentLoop.runWorkerTurn(...)` (Phase 4), which owns the
      checkpoint session and coordinator review through a small public
      `SidebarProvider.dispatchWorkerRun(...)` forwarding facade — the
      command never accesses the private `AgentLoop`, service, or checkpoints
      directly. No active coordinator → setup
      message, no execution. Stop aborts startup, streams, approvals, and
      review.

### P5.2 Model-invoked tool (secondary)

- [ ] `src/tools/dispatchWorkersTool.ts` with the strict schema and inline
      worked example; statically requires `delegate` + `read` + `write` via
      P0.6 and dynamically requires `cloud-worker` when any target is cloud;
      advertised for authorized eligible local targets, or cloud targets when
      `cloud-worker` is enabled; receives the
      `WorkerRunContext` via the extended `ToolHandlerContext`; returns the
      structured result to the primary loop for natural review continuation.
      Validate per coordinator model in smoke tests — do not assume local
      coordinators will call it.

### P5.3 Conversation UX

- [ ] Typed bridge events for run/worker status; show worker ID, model,
      status, elapsed time, execution mode ("running serially", "loading
      model…", best-effort), and verified changed paths. Every error is a
      terminal state — never a stuck spinner. One checkpoint bar per
      coordinator turn; coordinator review labelled separately from worker
      summaries.

## Phase 6 — Tests

- [ ] Schema bounds/uniqueness/`additionalProperties`; static multi-permission
      advertisement + dispatch; scoped registry rejects out-of-scope tools.
- [ ] Path canonicalization (Windows/POSIX), traversal, symlink, missing
      parent; write/write conflict rejection; worker read/list of absolute
      or out-of-workspace paths rejected while primary tools are unchanged.
- [ ] Admission: cloud bypass, shared-base parallel, labelled serial on one
      backend, explicit rejection when residency is impossible, group
      rollback on startup failure, hold release on every outcome.
- [ ] Permissions: disabled `fs.read`, `fs.write`, or `delegate` hides and
      blocks the tool; cloud targets are hidden/blocked without
      `cloud_workers` while authorized local targets remain available; cloud
      launch approval is not bypassed by clanker mode.
- [ ] Worker loop: native + fallback parity, out-of-scope tool rejection,
      round/call/text limits, per-completion token limits,
      per-file and cumulative read budgets, tool-result caps,
      declined-approval terminality, `completed_no_changes` on unverified
      claims, verified changed paths.
- [ ] `CloudRequestResolver`: one owner serves `AgentLoop`,
      `ControlChatProxy`, and workers; no credential appears in worker
      results or logs.
- [ ] Checkpoints: parallel disjoint writes share one checkpoint; Undo
      restores both; partial failure keeps the successful worker's change;
      repeated writes snapshot original content; interleaved async snapshot
      race test.
- [ ] Approval queue: FIFO under concurrency; cancellation flushes the
      queue as declined.
- [ ] Integration: barrier-proven concurrent start with fake streaming
      clients; MCP fixture unreachable from worker scope; command and tool
      paths hit the same service; primary `AgentLoop` unchanged after P0.4.
- [ ] Manual smoke: shared-base parallel (`n_parallel: 2`); labelled serial
      (`n_parallel: 1`); residency-impossible rejection; one local + one
      Cerebras worker; two cloud workers; cloud run without `cloud_workers`
      blocked; cloud launch approval visible in clanker mode; declined +
      approved mixed run with one checkpoint; Stop during
      startup/generation/approval/review; path escape and overlap attempts;
      Keep and Undo across both workers.

## Phase 7 — Documentation

- [ ] README: consultation vs. worker orchestration; exact write ownership;
      partial failure and Keep/Undo; labelled serial vs. explicit rejection;
      slot/`n_parallel`/VRAM limits; the `cloud_workers` permission and that
      **cloud workers send file contents to the configured provider and
      consume provider tokens autonomously**.
- [ ] Disabled-by-default example in `config/config.example.yaml` (existing
      permissions only, no secrets). Document the command and the tool.
- [ ] Add new canonical modules to `docs/OWNERS.md` as they land.

## Implementation Order

1. Green baseline; preserve unrelated worktree changes.
2. Phase 0 (P0.4 as its own commit, tests green before and after).
3. Admission with cloud bypass and labelled serial fallback.
4. Worker access policy and validation.
5. `WorkerLoop` on the extracted loop.
6. `WorkerOrchestrationService` and structured results.
7. **Direct command + coordinator continuation.**
8. Model tool.
9. UX, docs, ownership, full test matrix.
10. `npm run ci`, `npm run package`, manual smoke cases.

Each step leaves `npm run ci` green. Verify at the end: no file over
350 LOC, no new dependency or outbound endpoint, no secrets in config/git,
`rg` finds exactly one workspace resolver, diff-type owner, permission
resolver, confirmation owner, checkpoint stack, result cap, and
streaming/fallback loop.

## Definition of Done

- One or two workers — any mix of configured local and cloud models — edit
  disjoint exact paths; same-backend shortfalls run labelled-serial,
  impossible residency is rejected explicitly, and nothing is ever evicted.
- Every worker action is constrained by permissions (incl. `cloud_workers`
  for cloud targets), tool scope, `WorkerAccessPolicy`, read/result budgets,
  FIFO confirmation, one turn checkpoint owned by `runWorkerTurn`, and
  cancellation, with identical native/fallback and command/tool behavior.
- Verified changed paths come from mutation metadata; the coordinator
  reviews structured results after workers settle.
- `ask_local_agent` is unchanged; duplicates removed; every new concern has
  one documented owner; all automated gates and manual smoke cases pass.

## Next-Session Handoff

Implementation and automated gates are complete. Resume with the interactive
Extension Development Host smoke matrix; do not reopen the architecture unless
a smoke failure demonstrates a concrete defect. The exact worktree state,
remaining cases, and resume sequence are recorded in
`docs/WORKER_ORCHESTRATION_HANDOFF.md`.
