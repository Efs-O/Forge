import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TerminalCommandTracker } from '../../src/tools/TerminalCommandTracker';

function execution(command: string, output: string): vscode.TerminalShellExecution {
  return {
    commandLine: { value: command, isTrusted: true, confidence: 2 },
    cwd: { scheme: 'file', fsPath: 'N:/Forge' },
    read: async function* () {
      yield output;
    },
  } as unknown as vscode.TerminalShellExecution;
}

describe('TerminalCommandTracker', () => {
  it('captures output only after its tracked Forge terminal command starts', async () => {
    let started: ((event: vscode.TerminalShellExecutionStartEvent) => void) | undefined;
    let ended: ((event: vscode.TerminalShellExecutionEndEvent) => void) | undefined;
    const tracker = new TerminalCommandTracker();
    tracker.start({
      onDidStartTerminalShellExecution: (listener) => {
        started = listener;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      },
      onDidEndTerminalShellExecution: (listener) => {
        ended = listener;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      },
    });
    const terminal = { name: 'Forge' } as vscode.Terminal;
    const run = execution('python render.py', 'Traceback: bad path\n');
    tracker.trackPastedCommand(terminal, 'python render.py', 'N:/Forge', 'conversation-1');

    started?.({ terminal, execution: run } as vscode.TerminalShellExecutionStartEvent);
    ended?.({ terminal, execution: run, exitCode: 2 } as vscode.TerminalShellExecutionEndEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.latestForConversation('conversation-1')).toMatchObject({
      command: 'python render.py',
      status: 'completed',
      exitCode: 2,
      actualCwd: 'N:/Forge',
      output: 'Traceback: bad path',
    });
    tracker.dispose();
  });

  it('ignores unrelated terminals and modified commands', () => {
    const tracker = new TerminalCommandTracker();
    const terminal = { name: 'Forge' } as vscode.Terminal;
    const unrelated = { name: 'User terminal' } as vscode.Terminal;
    tracker.trackPastedCommand(terminal, 'python render.py', 'N:/Forge', 'conversation-1');

    tracker.captureStarted({ terminal: unrelated, execution: execution('python render.py', '') } as vscode.TerminalShellExecutionStartEvent);
    tracker.captureStarted({ terminal, execution: execution('python another.py', '') } as vscode.TerminalShellExecutionStartEvent);

    expect(tracker.latestForConversation('conversation-1')).toMatchObject({ status: 'waiting' });
  });
});
