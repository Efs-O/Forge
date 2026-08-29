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

describe('TerminalCommandTracker user commands', () => {
  function harness() {
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
    const run = async (
      terminal: vscode.Terminal,
      command: string,
      output: string,
      exitCode: number,
    ) => {
      const execution = execution2(command, output);
      started?.({ terminal, execution } as vscode.TerminalShellExecutionStartEvent);
      ended?.({ terminal, execution, exitCode } as vscode.TerminalShellExecutionEndEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { tracker, run };
  }

  function execution2(command: string, output: string): vscode.TerminalShellExecution {
    return {
      commandLine: { value: command, isTrusted: true, confidence: 2 },
      cwd: { scheme: 'file', fsPath: 'N:/Forge' },
      read: async function* () {
        yield output;
      },
    } as unknown as vscode.TerminalShellExecution;
  }

  it('captures a command the user ran in their own terminal', async () => {
    const { tracker, run } = harness();
    const terminal = { name: 'pwsh' } as vscode.Terminal;

    await run(terminal, 'npm run buidl', "Missing script: 'buidl'\n", 1);

    expect(tracker.recentUserCommands()).toEqual([
      {
        command: 'npm run buidl',
        terminalName: 'pwsh',
        status: 'completed',
        cwd: 'N:/Forge',
        exitCode: 1,
        output: "Missing script: 'buidl'",
        outputTruncated: false,
      },
    ]);
    tracker.dispose();
  });

  it('returns the user commands newest first and keeps only the last five', async () => {
    const { tracker, run } = harness();
    const terminal = { name: 'pwsh' } as vscode.Terminal;

    for (let index = 0; index < 7; index += 1) {
      await run(terminal, `echo ${index}`, `${index}\n`, 0);
    }

    expect(tracker.recentUserCommands().map((entry) => entry.command)).toEqual([
      'echo 6',
      'echo 5',
      'echo 4',
      'echo 3',
      'echo 2',
    ]);
    tracker.dispose();
  });

  it('does not double-count the command Forge pasted, but does track what the user types after it', async () => {
    const { tracker, run } = harness();
    const terminal = { name: 'Forge' } as vscode.Terminal;
    tracker.trackPastedCommand(terminal, 'npm test', 'N:/Forge', 'conversation-1');

    await run(terminal, 'npm test', 'ok\n', 0);
    await run(terminal, 'git status', 'clean\n', 0);

    expect(tracker.latestForConversation('conversation-1')).toMatchObject({
      command: 'npm test',
      exitCode: 0,
    });
    expect(tracker.recentUserCommands().map((entry) => entry.command)).toEqual(['git status']);
    tracker.dispose();
  });

  it('ignores a blank command line', async () => {
    const { tracker, run } = harness();
    await run({ name: 'pwsh' } as vscode.Terminal, '   ', '', 0);
    expect(tracker.recentUserCommands()).toEqual([]);
    tracker.dispose();
  });
});
