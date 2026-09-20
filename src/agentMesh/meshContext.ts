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

/**
 * The board's read context (AGENT_MESH_PLAN §3, P2). The mesh wiring sets it
 * once per window; the Telegram `/status` handler reads it to render the scoped
 * board line + "Live sessions" line. Absent (undefined) means the agent bus is
 * not up, so `/status` shows no board line (it never invents one).
 */
export interface BoardContext {
  /** The bus folder (aliases.json, ownership/, exchanges.jsonl). */
  root: string;
  /** This window's workspace root (board scoping). */
  workspace: string;
  /** The exchanges event log path. */
  log: string;
}

let boardContext: BoardContext | undefined;

export function setBoardContext(ctx: BoardContext | undefined): void {
  boardContext = ctx;
}

export function getBoardContext(): BoardContext | undefined {
  return boardContext;
}
