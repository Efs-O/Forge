# Codex task selection and existing sessions

To ask for a model and effort for one task, Forge calls `list_agent_targets`
(default `kind: new_task`). The installed Codex app-server supplies `model/list`,
including each model's supported reasoning efforts. Forge returns a target id for
each supported pair; no model catalogue or agent nicknames are built into Forge.

`ask_agent` accepts `agent`, `message`, optional `subject`, and optional
`target_id`. A discovered Codex model/effort target starts a separate task session
through the existing CLI driver with `--model` and a process-scoped
`-c model_reasoning_effort=...`. It never changes config, CLI defaults, or the
asking chat's linked agent. The reply identifies the requested model/effort and
CLI-reported session id. These are invocation settings, not proof from a model's
self-description that the provider ran a particular model.

For an existing session, call `list_agent_targets` with
`kind: existing_session`. Forge reuses Claude's live session registry and Codex's
workspace thread discovery. Codex discovery lists stored sessions, not proof of
an active reader. Existing-session model/effort metadata is unknown; a title such
as "Luna" is not evidence of model identity. Select the exact returned target id
when the owner's request identifies an existing session. Forge checks availability
and uses the existing live delivery path; it never resumes or creates another
session when an explicit recipient cannot answer.

Target ids are opaque, memory-only, scoped to the asking chat and workspace, and
expire after ten minutes. Listing again replaces that chat's snapshot. Queued
asks pin their validated selection at acceptance, so a later discovery or expiry
does not invalidate work already accepted. New uses of expired ids are refused.
Rediscovery cannot bypass duplicate protection for the same recipient and brief. A window reload
invalidates all targets. Discovery failure is reported with its cause.

Omitting `target_id` preserves the existing linked-session behavior: contact the
chat's linked Claude, Codex or Copilot session, creating one if no link exists.
The existing delegation permission, unattended policy, capacity, Stop, timeout,
and asynchronous reply lifecycle apply to explicit targets too. Copilot has no
session lister here; its existing linked path remains available. Local/cloud
model discovery continues through `list_delegation_targets` / `ask_local_agent`.

Persistent model defaults, when explicitly requested by the owner, belong under
`agent_bus` in `~/.forge/policy.yaml` once the policy split is enabled. They are
not a way to select an agent for one task. Never add another `agent_bus` block to
workspace config when policy.yaml already owns it: duplicate keys stop activation.

Implementation owners: `agentLinks/agentTargets.ts` (discovery/capabilities),
`agentLinks/selectedAgentAsk.ts` (explicit execution),
`agentMesh/codexDiscovery.ts` (Codex protocol/lifecycle), and the existing
`ask_agent` / CLI driver / live delivery paths.
