import type { MeshOrchestrator } from './meshOrchestrator';

/**
 * Process-wide handle to the agent-mesh orchestrator (AGENT_MESH_PLAN §1, M6).
 *
 * The orchestrator is created once per window by the activation wiring
 * (agentMeshSetup.ts) and needed by the `tell_live_session` tool, which is
 * registered through the long `registerAllTools` signature. A small holder
 * keeps the tool decoupled from that signature: the wiring sets it, the tool
 * reads it. Absent (undefined) means the agent bus is not up, so the tool
 * reports "not available" rather than failing.
 */

let orchestrator: MeshOrchestrator | undefined;

export function setMeshOrchestrator(o: MeshOrchestrator | undefined): void {
  orchestrator = o;
}

export function getMeshOrchestrator(): MeshOrchestrator | undefined {
  return orchestrator;
}
