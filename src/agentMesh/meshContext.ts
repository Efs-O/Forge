/**
 * The exchange log read context for Telegram status. Agent messaging sets it
 * once per window; the Telegram `/status` handler reads it to render the scoped
 * board line + "Live sessions" line. Absent (undefined) means the agent bus is
 * not up, so `/status` shows no board line (it never invents one).
 */
export interface BoardContext {
  /** The agent-bus folder. */
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
