# Agent Worker Orchestration: Current State and Next Steps

## Requested Workflow

The desired workflow is a coordinator model (for example, Qwen 480B) that
delegates two independent coding tasks to two local Gemma 31 workers. Each
worker creates and saves its assigned file, and the coordinator then reviews
the resulting code.

```text
Qwen coordinator
├─ Gemma 31 worker A → creates and saves file A
├─ Gemma 31 worker B → creates and saves file B
└─ Qwen → reviews both completed changes
```

## Current Forge Behavior

Forge currently supports bounded local consultation through
`ask_local_agent`:

```text
Primary model → one local delegate → read-only analysis text → primary model
```

The delegate:

- receives only an explicit task and selected context files;
- has no tools;
- cannot read additional workspace files, write files, or run commands;
- is limited to one consultation per request; and
- returns analysis to the primary conversation rather than changing the
  workspace.

This is deliberate. The current native delegation feature is a safe
consultation mechanism, not a coding-worker system.

MCP servers can also expose tools through Forge, including tools classified as
`delegate`. Forge validates their configured capability and permission before
dispatch. However, an MCP server is not automatically a worker orchestrator,
and the primary model must still choose to emit a tool call.

## Observed UI Limitation

The tested primary models did not reliably invoke `ask_local_agent` even with
the required `permissions.agents.delegate: true` setting and eligible local
targets configured. Instead, they returned prose saying the tool was
unavailable or incorrectly claimed terminal permission was required.

Terminal permission is not required for `ask_local_agent`; only the explicit
`delegate` capability is required. The service, permission gates, cancellation,
capacity protection, and automated tests are present, but model tool-call
compliance is not a reliable user invocation surface.

## Gap to the Requested Workflow

The following capabilities do not exist today:

1. Writable delegated workers.
2. Parallel dispatch of two or more workers.
3. Per-worker workspace/path ownership and conflict detection.
4. Coordinator review after workers complete.
5. A direct user action that starts worker orchestration without relying on the
   primary model to choose a tool call.

## Recommended Design

Add a separate worker-orchestration feature rather than weakening
`ask_local_agent`'s read-only contract.

### 1. Strict worker-dispatch interface

Introduce a strict-schema capability such as `dispatch_local_workers` with:

- explicit local target model for each worker;
- bounded worker count;
- structured task fields;
- explicit, workspace-relative allowed paths for every worker;
- an explicit write capability request; and
- no free-form tool-configuration blob.

### 2. Worker execution loop

Create a dedicated worker loop that grants only the narrow tools needed for its
assigned task. It must not reuse the tool-free consultation loop. Tool calls
remain subject to Forge's existing permission resolver and per-action
confirmation gate.

### 3. Checkpoints and conflict safety

Before each worker write, snapshot the affected path through the canonical
checkpoint stack. Workers must have disjoint path ownership by default.
Conflicting writes should be rejected or serialized, never silently merged.
Keep/Undo must cover all worker changes made for the coordinator turn.

### 4. Parallel lifecycle controls

Use the existing backend capacity/hold machinery to reserve the coordinator and
worker backends without evicting active models. Cancellation, timeout, startup
failure, and worker failure must release every hold and leave a visible result
in the primary conversation.

### 5. Coordinator review

After workers finish, return structured summaries containing worker identity,
changed paths, and final result. The coordinator receives those results and
reviews the completed files; it does not need unrestricted access to worker
internal reasoning.

### 6. Direct user invocation

Provide a command-palette action or sidebar form such as `Forge: Dispatch Local
Workers`. This avoids relying on a primary model to voluntarily issue a tool
call. The action must use the same permission and confirmation gates as any
model-initiated path.

## Optional MCP Direction

An external MCP/Relay worker manager could implement some orchestration, but it
must declare each sensitive tool's permission in `mcp_servers.tool_permissions`
(for example, `delegate`). Native worker orchestration should remain independent
of Relay so Forge retains a local-first path.

## Conclusion

Forge has the safety foundations for orchestration—capability permissions,
checkpointing, cancellation, result capping, backend capacity holds, and MCP
gating—but it does not yet provide writable parallel workers. Preserve the
current read-only `ask_local_agent` contract and build worker orchestration as a
separate, explicitly permissioned feature.
