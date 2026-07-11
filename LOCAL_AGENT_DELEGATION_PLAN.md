# Local Agent Delegation Plan

## Goal

Allow the active Forge agent to ask another configured local model for a bounded,
read-only second opinion and then continue the original conversation with the
result.

Example:

```text
Gemma (primary agent)
  -> ask_local_agent(model: "qwen-coder", task: review, context files)
  -> Qwen returns analysis only
  -> Gemma decides what to do and remains responsible for all tool calls
```

This is consultation, not autonomous multi-agent execution. The delegated model
must not edit files, run commands, call tools, or recursively delegate.

## Recommended Architecture

Implement delegation as a native Forge tool backed by a dedicated
`LocalDelegationService`. Reuse Forge's existing configuration resolution,
`BackendPool`, request normalization, prompt injection, and streaming clients.

Do not require users to install a separate MCP server for the initial feature.
MCP-based delegation can remain an optional future integration for external
orchestrators.

## Critical Runtime Rule

Delegation must never evict or stop the primary model while its agent turn is in
progress. The primary model needs its backend again after the delegated result is
returned.

For the first version:

- delegation to the same loaded base model/profile may reuse its backend;
- delegation to a different local model is allowed only when the backend pool has
  spare capacity and can keep both models loaded;
- otherwise Forge rejects the call with a clear message explaining that
  `max_simultaneous_models` must be at least `2` and sufficient RAM/VRAM is needed;
- Forge must not silently evict the primary backend to satisfy delegation.

Do not implement automatic unload/reload swapping in version one. It adds latency,
failure recovery, and conversation-continuation risks.

### Ollama targets: best-effort only

The non-eviction guarantee is enforceable only for llama.cpp slots, which
`BackendPool` owns. The Ollama daemon manages its own VRAM and may evict or
fail to co-load models regardless of what Forge requests (observed in
practice: gemma4-12b refusing to load while qwen36-27b was resident).
Version one therefore:

- guarantees non-eviction for llama.cpp → llama.cpp delegation;
- treats delegation involving an Ollama target or an Ollama primary as
  best-effort, documented as such, with daemon-side load failures and stalls
  surfaced as visible errors — never silent hangs;
- must not claim in UI or docs that `max_simultaneous_models: 2` alone makes
  delegation safe: slot capacity is not VRAM headroom, and a second
  llama-server spawn can still fail out-of-memory. Spawn failures surface to
  the user with the model name and reason.

## Tool Contract

Add one read-only tool named `ask_local_agent` with a strict JSON schema.

Suggested arguments:

```json
{
  "model": "qwen-coder@reviewer",
  "task": "Review the supplied files for correctness and return findings.",
  "context_files": ["src/example.ts", "test/example.test.ts"],
  "focus": ["correctness", "edge-cases"],
  "max_output_tokens": 4096
}
```

Rules:

- `model` is required and must resolve to a configured local llama.cpp or Ollama
  model. Cloud providers are rejected.
- `task` is required, length-bounded, and treated as untrusted prompt content.
- `context_files` is optional, count-bounded, workspace-contained, and read-only.
- `focus` uses a small enum such as `correctness`, `security`, `tests`,
  `architecture`, `performance`, or `second-opinion`.
- `max_output_tokens` has a conservative upper bound.
- `additionalProperties` is `false`.
- The tool returns text analysis only.

Resolved: the bounded `task` string is consistent with the "no free-form blob
args" hard stop. That rule bans schema-less catch-all arguments (a single
`args: string` carrying encoded JSON), not bounded single-purpose string
fields — existing tools already accept file `content` and exec `command`
strings. `task` stays a length-bounded string under
`additionalProperties: false`; no structured-objective contraption, no rule
change.

## Phase 1: Characterize Backend-Pool Safety

### Work

- Add a read-only pool query that reports whether a model is already loaded and
  whether acquiring another model would require eviction.
- Keep capacity decisions owned by `BackendPool`; do not duplicate its model or
  eviction logic in the delegation service.
- Identify the caller's base model separately from its request-time profile.
- Define same-backend behavior for two profiles of one model.

### Acceptance criteria

- The service can determine whether delegation is safe without mutating pool
  state.
- A second-model request cannot evict the active primary model.
- Tests cover capacity `1`, capacity `2`, same model, and different models.

## Phase 2: Implement `LocalDelegationService`

### Responsibilities

- Resolve aliases and `model@profile` using the existing config resolver.
- Reject xAI, OpenAI, OpenRouter, generic OpenAI-compatible, and Ollama cloud
  entries. Initial delegation is local-only.
- Acquire or reuse a safe backend through `BackendPool`.
- Read explicitly requested workspace files with size and count limits.
- Build a consultation system prompt that states:
  - return analysis only;
  - do not claim to have edited or executed anything;
  - do not request or emit tool calls;
  - cite context filenames when reporting findings.
- Send a request with no tool definitions.
- Normalize sampling and provider-specific request fields using existing owners.
- Stream internally into a bounded result buffer.
- Support cancellation using the primary turn's `AbortSignal`.
- Release any delegation hold without stopping a backend still needed elsewhere.

### Suggested limits

- Maximum context files: 8.
- Maximum bytes per file: 256 KiB.
- Maximum combined context: 1 MiB.
- Maximum task length: 4,000 characters.
- Maximum result length: 32,000 characters — enforced via the existing
  `capResultText` owner (currently in `mcpBridge.ts`; hoist it into a small
  neutral module both callers import, and update `docs/OWNERS.md`). Do not
  introduce a sibling cap constant.
- Maximum output tokens: configurable but capped conservatively.
- Maximum delegation duration: one named timeout constant. A hung delegated
  model must not hold the primary turn hostage; timeout aborts the delegated
  request via the same `AbortSignal` plumbing and surfaces a visible error.

These values should be named constants in the delegation service and covered by
tests, not hidden fallbacks spread across modules.

## Phase 3: Register the Tool Safely

### Work

- Add the tool definition in one dedicated module such as
  `src/tools/localAgentTool.ts`.
- Inject `LocalDelegationService` through `registerAllTools`; do not access global
  extension state from the handler.
- Assign a distinct `delegate` capability rather than misclassifying it as
  filesystem `read`.
- Extend config permissions with an explicit switch:

```yaml
permissions:
  agents:
    delegate: false
```

- Default delegation to disabled for existing and newly generated configs.
- Advertise the tool only when delegation is enabled and at least one eligible
  local target exists.
- Keep the delegated request tool-free so recursion is impossible.
- Close the MCP bridge bypass: `mcpBridge` currently registers every bridged
  tool with `permission: 'read'`, so a Relay `dispatch_subagent` bridged into
  Forge would sidestep the `delegate` gate entirely. Add an optional
  per-server permission classification to `mcp_servers` config
  (default `read`, unchanged behavior):

```yaml
mcp_servers:
  - name: forgerelay
    tool_permissions:
      dispatch_subagent: delegate
```

  One enforcement point (`PermissionResolver`), two transports (native tool
  and bridged MCP). No parallel permission logic in the bridge.

### Acceptance criteria

- A disabled delegation permission hides and blocks the tool.
- Direct and fallback tool-call paths enforce the same permission.
- The delegated model cannot receive `ask_local_agent` or any other tools.
- Cloud targets and unknown targets produce clear errors.

## Phase 4: Conversation and UX Behavior

### Work

- Show a tool-activity card containing the target model and consultation focus.
- Clearly label the returned text as delegated analysis in the primary
  conversation.
- Keep the delegated exchange out of the user's main conversation history except
  for the final tool result.
- Add cancellation propagation: stopping the primary turn stops the delegated
  request.
- Report capacity, startup, timeout, and model-template errors without hiding
  them.
- Do not create a separate conversation tab in version one.

## Phase 5: Tests

Add focused tests for:

- alias and profile resolution;
- same-model delegation;
- different-model delegation with capacity available;
- rejection when delegation would evict the primary model;
- local Ollama and direct llama.cpp routing;
- rejection of Ollama cloud and direct cloud providers;
- permission disabled/enabled behavior;
- workspace path traversal rejection;
- file count, file size, task length, result length, and token limits;
- cancellation during model startup and streaming;
- delegated requests containing no tool definitions;
- recursive delegation being impossible;
- backend holds being released after success and failure.

## Phase 6: Documentation and Configuration

- Add a disabled delegation example to `config/config.example.yaml`.
- Explain the VRAM/RAM implications of loading two local models.
- Explain that profiles of the same base model share a backend and are cheaper
  than loading a second GGUF.
- Document that delegated agents are advisory and cannot modify the workspace.
- Add the new service and tool to `docs/OWNERS.md`.

## Reuse Map (anti-duplication)

Every capability below has an existing owner. Extend the owner; never create
a sibling.

| Need | Owner — reuse, do not rebuild |
| --- | --- |
| `model@profile` / alias resolution | `src/config/ConfigResolver.ts` |
| Capacity / non-evicting acquire | `src/backend/BackendPool.ts` (add `peek`/`tryAcquire` to it) |
| Request shaping, sampling merge | `RequestNormalizer`, `SamplingMerge`, `ChatClient` |
| Streaming clients | `OpenAIClient` / `OllamaNativeClient` |
| Workspace containment for `context_files` | read-tool path guard + `DenyList` |
| Result capping | `capResultText` (hoisted to neutral module) |
| Permission gate | `PermissionResolver` — one new `delegate` entry |
| Cancellation | primary turn's existing `AbortSignal` |

New modules are exactly three: `LocalDelegationService`,
`src/tools/localAgentTool.ts`, and the hoisted result-cap module. Each stays
under the 350 LOC limit.

### Explicitly not built

- No MCP server or MCP transport in Forge for this feature.
- No delegation UI beyond the existing tool-activity card.
- No second config surface, model registry, or catalog cache.
- No new sampling/normalization/streaming logic.
- No coupling to Forge Relay: the Relay coordinator plan
  (`FORGE_COORDINATOR_PLAN.md` in the forge-relay repo) interacts with Forge
  only via the existing control-server HTTP API.

## Quality Gates

```bash
npm run ci
npm run package
```

Also perform a manual smoke test with:

1. one model consulting another profile of itself;
2. two local models with `max_simultaneous_models: 2`;
3. capacity `1`, confirming a clear rejection rather than eviction;
4. cancellation during delegation;
5. delegation disabled in permissions.

## Not Included in Version One

- Delegated file writes or terminal commands.
- Multiple delegated agents running in parallel.
- Automatic voting or consensus.
- Recursive delegation.
- Automatic primary-model eviction and reload.
- Cloud-model delegation.
- Long-lived child-agent conversation histories.
- Delegated agents sharing the primary agent's entire conversation automatically.

## Definition of Done

- The primary local agent can request bounded analysis from an explicitly chosen
  configured local model.
- The secondary model receives only the task and explicitly selected context.
- The secondary model has no tools and cannot modify workspace state.
- The primary backend is never evicted to satisfy delegation.
- Permission, capacity, cancellation, and resource failures are visible.
- All automated gates and manual smoke cases pass.
