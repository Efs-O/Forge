import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TerminalCommandTracker } from '../../src/tools/TerminalCommandTracker';

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

  it('captures commands from every terminal', async () => {
    const { tracker, run } = harness();
    const firstTerminal = { name: 'pwsh' } as vscode.Terminal;
    const secondTerminal = { name: 'bash' } as vscode.Terminal;
    await run(firstTerminal, 'npm test', 'ok\n', 0);
    await run(secondTerminal, 'git status', 'clean\n', 0);

    expect(tracker.recentUserCommands().map((entry) => entry.command)).toEqual([
      'git status', 'npm test',
    ]);
    tracker.dispose();
  });

  it('ignores a blank command line', async () => {
    const { tracker, run } = harness();
    await run({ name: 'pwsh' } as vscode.Terminal, '   ', '', 0);
    expect(tracker.recentUserCommands()).toEqual([]);
    tracker.dispose();
  });
});
