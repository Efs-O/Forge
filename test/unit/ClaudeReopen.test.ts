import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_REOPEN_KEY, consumeClaudeReopen } from '../../src/agentBus/claudeReopen';

const SESSION_ID = '8635a8e0-0b34-4fd7-a12a-3f9a6a800000';

function makeState(value: unknown) {
  let stored = value;
  const get = vi.fn((_key: string) => stored);
  const update = vi.fn(async (_key: string, next: unknown) => {
    stored = next;
  });
  return { get, update, read: () => stored };
}

describe('consumeClaudeReopen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens a fresh entry once and clears the key', async () => {
    const state = makeState({ sessionId: SESSION_ID, expiresAt: Date.now() + 60_000 });
    const open = vi.fn(async () => true);
    const log = { warn: vi.fn(), error: vi.fn() };

    await consumeClaudeReopen(state, open, log);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(SESSION_ID);
    expect(state.read()).toBeUndefined();
    expect(state.update).toHaveBeenCalledWith(CLAUDE_REOPEN_KEY, undefined);
  });

  it('clears and ignores an expired entry', async () => {
    const state = makeState({ sessionId: SESSION_ID, expiresAt: Date.now() - 1 });
    const open = vi.fn(async () => true);
    const log = { warn: vi.fn(), error: vi.fn() };

    await consumeClaudeReopen(state, open, log);

    expect(open).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('clears and ignores a malformed entry', async () => {
    const state = makeState({ sessionId: '../x', expiresAt: Date.now() + 60_000 });
    const open = vi.fn(async () => true);
    const log = { warn: vi.fn(), error: vi.fn() };

    await consumeClaudeReopen(state, open, log);

    expect(open).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does nothing when no entry exists', async () => {
    const state = makeState(undefined);
    const open = vi.fn(async () => true);
    const log = { warn: vi.fn(), error: vi.fn() };

    await consumeClaudeReopen(state, open, log);

    expect(open).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('surfaces an openExternal false result with an error and message', async () => {
    const state = makeState({ sessionId: SESSION_ID, expiresAt: Date.now() + 60_000 });
    const open = vi.fn(async () => false);
    const log = { warn: vi.fn(), error: vi.fn() };
    const showError = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined as never);

    await consumeClaudeReopen(state, open, log);

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0][0]).toContain(SESSION_ID);
    expect(showError).toHaveBeenCalledOnce();
    expect(showError.mock.calls[0][0]).toContain(SESSION_ID);
  });

  it('clears the key before opening', async () => {
    let stored: unknown = { sessionId: SESSION_ID, expiresAt: Date.now() + 60_000 };
    const order: string[] = [];
    const state = {
      get: vi.fn((_key: string) => stored),
      update: vi.fn(async (_key: string, next: unknown) => {
      order.push('clear');
        stored = next;
      }),
    };
    const open = vi.fn(async () => {
      expect(stored).toBeUndefined();
      order.push('open');
      return true;
    });
    const log = { warn: vi.fn(), error: vi.fn() };

    await consumeClaudeReopen(state, open, log);

    expect(order).toEqual(['clear', 'open']);
  });
});
