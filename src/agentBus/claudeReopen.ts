import * as vscode from 'vscode';

export const CLAUDE_REOPEN_KEY = 'forge.agentBus.claudeReopen';
export const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const CLAUDE_REOPEN_TTL_MS = 5 * 60 * 1000;

export interface ClaudeReopenEntry {
  sessionId: string;
  expiresAt: number;
}

interface ClaudeReopenState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

interface ClaudeReopenLog {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SESSION_ID_PATTERN.test(value);
}

export function rememberClaudeReopen(
  state: Pick<ClaudeReopenState, 'update'>,
  sessionId: string,
): Promise<void> {
  return Promise.resolve(
    state.update(CLAUDE_REOPEN_KEY, {
      sessionId,
      expiresAt: Date.now() + CLAUDE_REOPEN_TTL_MS,
    } satisfies ClaudeReopenEntry),
  );
}

/** Consume the one-shot reopen request before opening the Claude Code URI. */
export async function consumeClaudeReopen(
  state: ClaudeReopenState,
  open: (sessionId: string) => Thenable<boolean> | Promise<boolean>,
  log: ClaudeReopenLog,
): Promise<void> {
  const entry = state.get<unknown>(CLAUDE_REOPEN_KEY);
  if (entry === undefined) return;

  try {
    await state.update(CLAUDE_REOPEN_KEY, undefined);
  } catch (error) {
    log.error('[agentBus] Could not clear the pending Claude reopen request', error);
    return;
  }

  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('sessionId' in entry) ||
    !('expiresAt' in entry) ||
    !isClaudeSessionId(entry.sessionId) ||
    typeof entry.expiresAt !== 'number' ||
    !Number.isFinite(entry.expiresAt)
  ) {
    log.warn('[agentBus] Ignored malformed pending Claude reopen request');
    return;
  }
  if (entry.expiresAt <= Date.now()) {
    log.warn(`[agentBus] Ignored expired Claude reopen request for session ${entry.sessionId}`);
    return;
  }

  try {
    if (await open(entry.sessionId)) return;
    const message = `Could not reopen Claude Code session ${entry.sessionId} after the window reload.`;
    log.error(message);
    void vscode.window.showErrorMessage(message);
  } catch (error) {
    const message = `Could not reopen Claude Code session ${entry.sessionId} after the window reload.`;
    log.error(message, error);
    void vscode.window.showErrorMessage(message);
  }
}
