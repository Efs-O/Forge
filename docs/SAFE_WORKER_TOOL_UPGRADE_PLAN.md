# Safe Worker and Tool Upgrade Implementation Plan

Status: Phases 0–5 are implemented and covered by automated tests. Phase 6
remains intentionally unimplemented because it requires separate approval after
observing real `replace_in_file` failure rates. Installed-VSIX smoke validation
from the verification matrix remains manual.

## Status

**Proposal for review only. No implementation is authorized by this document.**

This plan upgrades the existing worker workflow without weakening Forge's
workspace boundary, exact-write ownership, permission gate, cloud-egress gate,
checkpoint behavior, or local-backend admission rules. It extends canonical
owners listed in `docs/OWNERS.md`; it does not create parallel implementations.

## Goals

1. Make worker model selection discoverable and exact.
2. Support genuine read-only worker jobs without fake writable paths.
3. Give workers bounded repository-discovery and diagnostic tools.
4. Improve coordinator delegation reliability without silently dispatching.
5. Keep coordinator review focused on verified worker results.
6. Verify the packaged extension, not only the source tree.

## Current Findings

### Model visibility differs by entry point

- `Forge: Dispatch Workers` reads `config.models` and shows the user a picker.
  It filters cloud targets when `permissions.agents.cloud_workers` is disabled.
- The model-invoked `dispatch_workers` definition contains `model: string`; it
  does not give the coordinator an enum or a live catalog of configured names.
- `ConfigResolver` rejects an unknown model and includes all configured base
  model names in the error. A coordinator can recover from that error, but only
  after making a failed tool call.
- Profiles and aliases are resolved canonically by `ConfigResolver`; no new
  matching or alias logic should be created elsewhere.

### Worker tool surface is intentionally narrow

Workers currently receive only:

- `read_file`
- `list_directory`
- `write_file`
- `replace_in_file`

This is safe for a single known file but weak for codebase exploration. The
primary catalog already owns `find_files`, `search_code`, LSP diagnostics, and
symbol tools. Worker support must reuse those registered tools under a stricter
`WorkerAccessPolicy`, not duplicate their handlers.

### Observed packaged-runtime issues

- An installed build failed to start `search_code` because `rg` was not on the
  extension-host `PATH`.
- The current worktree already resolves VS Code's bundled ripgrep before trying
  `PATH`. This needs packaged VSIX validation and tests; do not add a second
  ripgrep resolver.
- A coordinator review inspected the entire dirty worktree after a worker
  returned `completed_no_changes`. Review should be driven by verified changed
  paths and worker status instead.

## Safety Invariants

Every phase must preserve all of the following:

- Worker path arguments are workspace-relative; absolute and escaping paths
  remain rejected.
- Symlinks and missing-parent paths are checked through the canonical workspace
  path guard.
- Workers may write only exact, non-overlapping assigned files.
- Every mutation snapshots before the first write and stays under one turn
  checkpoint with Keep/Undo.
- Cloud workers require `agents.cloud_workers` plus dangerous,
  non-bypassable launch approval.
- Worker results and reads remain per-result and cumulative-budget bounded.
- No worker receives terminal, Git, delete, browser, fetch, MCP, delegation, or
  arbitrary command access.
- No recursive workers and no increase beyond two workers in this upgrade.
- No free-form catch-all tool arguments; every tool retains a strict JSON
  Schema with `additionalProperties: false`.
- No fuzzy model selection or silent fallback to a different model.
- No new dependency or outbound endpoint.

## Phase 0 — Re-establish the Packaged Baseline

Owner: `src/tools/dirTools.ts` and release scripts in `package.json`.

1. Add focused tests for ripgrep resolution covering:
   - VS Code `node_modules.asar.unpacked` layout;
   - regular `node_modules` layout;
   - explicit, surfaced failure when neither bundled nor `PATH` ripgrep starts.
2. Install the newly packaged VSIX and verify `search_code` inside the extension
   host on Windows.
3. Re-test the command-started Stop button during worker generation.
4. Record results in `docs/AGENT_WORKER_ORCHESTRATION_REPORT.md`.

Acceptance:

- `search_code` works in the installed VSIX without assuming `rg` is on PATH.
- Stop is visible for command-started worker runs and cancels the active run.

## Phase 1 — Exact Worker Model Discovery

Owners: `src/tools/dispatchWorkersTool.ts`, `src/config/ConfigResolver.ts`, and
`src/llm/ModelRouteClassifier.ts`.

Add one read-only built-in tool, `list_worker_models`, rather than embedding a
potentially large, stale enum in `dispatch_workers`.

Strict result fields per model:

```json
{
  "name": "gemma4-e4b-it-ud-q4kxl",
  "route": "local-llama",
  "cloud": false,
  "profiles": ["main", "worker"]
}
```

Rules:

- No arguments beyond an empty strict object.
- Uses `permission: "delegate"` with no `additionalPermissions`; reading the
  already-loaded model catalog is not workspace file access.
- Uses the same `advertise: () => getConfig().models.length > 0` condition as
  `dispatch_workers`, so the two tools appear and disappear together.
- Returns exact configured base names and valid profiles using canonical config
  data; never returns secrets, API keys, endpoints, or GGUF paths.
- Hide cloud targets when `cloud-worker` permission is absent, matching the
  direct picker.
- The `dispatch_workers` description tells coordinators to call
  `list_worker_models` when the requested name is not exact.
- Unknown model errors remain explicit. Do not guess, fuzzy-match, or select the
  first model automatically.

Tests:

- local-only catalog without cloud permission;
- local plus cloud catalog with permission;
- profiles and aliases represented without duplicate model logic;
- config hot reload reflected on the next call;
- no sensitive configuration fields in results.

Acceptance:

- A coordinator can discover a valid target before dispatching.
- Direct-command and model-tool eligibility produce the same target set.

## Phase 2 — First-Class Read-Only Workers

Owners: `src/workers/types.ts`, `src/workers/WorkerAccessPolicy.ts`,
`src/workers/WorkerOrchestrationService.ts`, `src/tools/ToolRegistry.ts`, and
`src/tools/dispatchWorkersTool.ts`.

Contract change:

- Add `access: "read" | "write"` to each worker; defaulting is not implicit.
- Keep the JSON Schema flat for small-model reliability: `access` is required;
  `allowed_paths` is optional, with `minItems: 1` when present. Do not use
  `oneOf`, `if`/`then`, or conditional schema variants.
- Enforce the pairing at the runtime request boundary with explicit errors:
  `access: "read"` requires `allowed_paths` to be absent, while
  `access: "write"` requires it to be present and non-empty. Runtime validation
  is authoritative even when a provider does not enforce JSON Schema.

Permission behavior:

- Define the static minimum for `dispatch_workers` as `delegate` + `read`.
  `ToolRegistry.definitions()` uses only that static minimum because tool
  arguments do not exist during advertisement.
- At dispatch time, compute argument-aware additional permissions. Require
  `write` if any worker has `access: "write"`; require no additional permission
  for an all-read request.
- This advertisement/dispatch split is intentional: users with `delegate` +
  `read` must see the tool for read-only work, while a write-shaped call must
  still fail before orchestration when `write` is absent.
- Extend the canonical registry contract with a clearly named dispatch-only
  callback (for example, `additionalPermissionsForArgs`). Do not invoke it from
  advertisement filtering and do not special-case `dispatch_workers` inside
  `ToolDispatch` or `PermissionResolver`.
- Direct-command validation uses the same permission helper.

Read-only enforcement:

- Construct an empty immutable writable set.
- Do not advertise mutation tools to read-only workers.
- Reject mutation calls at both tool scope and access-policy layers.
- Read-only completion is `completed_no_changes`; a claimed edit without
  verified mutation remains untrusted text.

Requests without `access` are rejected with a clear schema error. The worker
contract has not shipped, so there is no legacy request shape to migrate. Forge
must not infer write authority from the presence of `allowed_paths`.

Tests:

- read-only dispatch works with `fs.write: false`;
- the tool is advertised with `delegate` + `read` even without write permission;
- a write-shaped request is blocked at dispatch without write permission;
- read-only workers cannot call or smuggle mutation paths;
- command and model entry points share validation.

## Phase 3 — Bounded Worker Discovery Tools

Owners: existing definitions in `src/tools/dirTools.ts` and
`src/tools/lspTools.ts`; enforcement in `src/workers/WorkerAccessPolicy.ts`.

Pre-plan the file split before adding validators. Keep
`WorkerAccessPolicy.ts` as the owner of writable ownership, changed paths, and
cumulative budgets; move tool-specific argument validation into a focused
module such as `src/workers/WorkerToolValidators.ts`. Add that module and its
concern to `docs/OWNERS.md` in the same change. Neither source file should grow
beyond 350 LOC where practical.

Add existing registered tools to worker scope in this order:

1. `find_files`
2. `search_code`
3. `get_document_symbols`
4. `get_diagnostics` for an explicit file only

Do not expose whole-workspace diagnostics initially.

Policy requirements:

- `context_files` remains an optional list of suggested starting reads for both
  read-only and write workers. It grants no extra access and does not imply
  writable ownership.
- All file/path inputs are workspace-relative and canonicalized.
- Glob scopes cannot escape or enumerate outside the workspace.
- Search and find results contain workspace-relative paths only.
- Diagnostics require an explicit workspace-contained file.
- Existing per-result caps apply, plus cumulative worker result accounting.
- Add explicit maximum result counts and search-context bounds to
  `src/workers/limits.ts`.
- Cancellation reaches ripgrep, VS Code workspace search, and LSP requests where
  the underlying API supports it; late results are ignored after abort.
- Tool handlers remain the canonical primary implementations. Worker-specific
  code validates arguments and transforms results only.

Deferred tools:

- `go_to_definition`, references, hover, and workspace symbols remain deferred
  until the first four tools pass packaged smoke tests.
- Semantic `search_codebase` remains deferred because it introduces embedding
  backend availability and index freshness into worker admission.

Tests:

- traversal and absolute glob/path rejection;
- symlink and sibling-prefix containment;
- result and cumulative-budget exhaustion;
- cancellation during search;
- ripgrep failure is surfaced as `failed_tool`;
- primary-agent behavior remains unchanged.

## Phase 4 — Coordinator Delegation Guidance

Owners: `src/tools/dispatchWorkersTool.ts`, system-prompt injection in
`src/llm/SystemPromptInjector.ts`, and the existing prompt templates.

When `agents.delegate` is enabled, inject a concise orchestration capability
block that tells the coordinator:

- use `dispatch_workers` when the user explicitly asks for a worker;
- consider delegation for independent, bounded subtasks;
- use `list_worker_models` instead of inventing model names;
- choose read access unless mutation is required;
- assign exact, non-overlapping writable paths;
- never claim a worker ran unless the tool returned a run result;
- continue locally when delegation is unnecessary or admission rejects safely.

This phase must not add a host-side natural-language intent classifier. The
model still chooses tools, and the direct command remains an explicit override.
No silent auto-dispatch or model fallback is introduced.

Tests:

- prompt snapshot with delegation enabled/disabled;
- tool description includes discovery and read/write guidance;
- representative native-tool and fallback coordinators call the strict schema;
- a coordinator response cannot manufacture worker activity in the UI.

## Phase 5 — Focused Coordinator Review

Owners: `src/sidebar/AgentLoop.ts` and worker result contracts in
`src/workers/types.ts`.

`WorkerResult.changedPaths` already exists. This phase should reuse that field;
it is primarily `AgentLoop` review-input plumbing, not a new result-contract
design.

Build review input from structured worker results:

- terminal status per worker;
- verified `changedPaths`;
- bounded worker summary/error;
- execution mode and partial-failure state.

Review rules:

- If every worker is `completed_no_changes`, summarize results without running
  a repository-wide diff.
- If paths changed, instruct the coordinator to inspect those exact paths and
  their diffs first.
- Do not include or review unrelated dirty-worktree changes by default.
- Coordinator fixes remain under the same checkpoint and normal permission
  gate.
- If broader inspection is genuinely needed, the coordinator must explain why
  through its normal tool activity rather than receiving hidden extra context.

Tests:

- no-change run does not request global Git review in a deterministic fixture;
- changed-path review receives only verified paths;
- unrelated dirty files are absent from generated review input;
- partial failure still reviews successful verified mutations;
- Keep/Undo covers worker and coordinator writes once.

## Phase 6 — Structured Editing Reliability

Owner: `src/tools/fileEditTools.ts`; worker enforcement remains in
`src/workers/WorkerAccessPolicy.ts`.

Only after discovery and read-only work are stable, add a strict structured
multi-edit operation or extend the existing canonical edit owner. Proposed
shape:

```json
{
  "path": "src/example.ts",
  "operations": [
    {
      "start_line": 12,
      "end_line": 14,
      "replacement_lines": ["const enabled = true;"]
    }
  ]
}
```

Rules:

- Exact assigned path only.
- Ordered, non-overlapping line ranges validated against the current file.
- Maximum operation count and replacement size.
- One synchronous checkpoint snapshot before mutation.
- Reject stale/out-of-range edits; never guess new ranges.
- Return a bounded structured summary with verified mutation metadata.
- No raw unified-diff or shell-command blob argument.

This phase is optional and should be approved separately after observing
`replace_in_file` failure rates on small local workers.

## Explicit Non-Goals

- More than two workers.
- Nested/recursive delegation.
- Worker terminal, Git, browser, fetch, MCP, delete, move, or arbitrary process
  execution.
- Automatic model substitution, fuzzy names, or hidden fallbacks.
- Automatic conflict merging.
- A second search, permission, path, checkpoint, or tool-dispatch subsystem.
- New cloud providers, telemetry, analytics, or background network calls.

## Implementation Order and Commit Boundaries

1. Packaged ripgrep and Stop validation; tests only where implementation exists.
2. `list_worker_models` plus catalog parity tests.
3. Explicit read/write worker contract and dynamic permission support.
4. `find_files` and `search_code` worker scope.
5. Explicit-file symbols and diagnostics.
6. Coordinator delegation prompt guidance.
7. Focused coordinator review.
8. Optional structured edit phase after separate review.

Each numbered step should be independently reviewable and leave `npm run ci`
green. Do not combine the dynamic permission change with discovery-tool scope in
one commit. Every step that adds a source module or moves a concern also updates
`docs/OWNERS.md` in the same commit.

## Verification Matrix

Automated gates after every implementation step:

```bash
npm run ci
```

Release gates after the final accepted step:

```bash
npm run ci
npm run package
git diff --check
```

Required installed-VSIX smoke cases:

- coordinator calls `list_worker_models`, then dispatches an exact local model;
- read-only worker reviews a file with no writable paths;
- write worker edits one exact file and Keep/Undo restores it;
- worker `find_files` and `search_code` stay inside the workspace;
- missing ripgrep fails clearly without hanging;
- Stop during search, model startup, worker generation, approval, and review;
- cloud catalog filtering and dangerous approval;
- two workers with disjoint writes; overlap rejected;
- coordinator no-change review avoids unrelated dirty-worktree diffs.

## Review Decisions Requested

Before implementation, approve or revise these choices:

1. Add `list_worker_models` as a separate tool instead of a dynamic schema enum.
2. Require explicit `access: "read" | "write"` with a flat schema and enforce
   the `allowed_paths` pairing at runtime.
3. Start worker discovery with only find, text search, explicit-file symbols,
   and explicit-file diagnostics.
4. Keep automatic delegation model-driven; retain the direct command as an
   explicit override.
5. Defer structured multi-edit until observed edit failures justify it.
