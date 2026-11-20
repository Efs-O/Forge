import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TerminalCommandTracker } from '../../src/tools/TerminalCommandTracker';

describe('TerminalCommandTracker user commands', () => {
  const SETTING = 'forge.terminal.watchUserCommands';

  /**
   * The vscode stub answers every setting with its fallback and has no
   * `onDidChangeConfiguration`, so the harness injects both the setting and the
   * configuration event. `injected` lets a test use the real default instead.
   */
  function harness(enabled = true, injected?: TerminalCommandTracker) {
    let on = enabled;
    let started: ((event: vscode.TerminalShellExecutionStartEvent) => void) | undefined;
    let ended: ((event: vscode.TerminalShellExecutionEndEvent) => void) | undefined;
    let configListener:
      | ((event: { affectsConfiguration(section: string): boolean }) => void)
      | undefined;
    const tracker = injected ?? new TerminalCommandTracker(() => on);
    tracker.start(
      {
        onDidStartTerminalShellExecution: (listener) => {
          started = listener;
          return { dispose: vi.fn() } as unknown as vscode.Disposable;
        },
        onDidEndTerminalShellExecution: (listener) => {
          ended = listener;
          return { dispose: vi.fn() } as unknown as vscode.Disposable;
        },
      },
      {
        onDidChangeConfiguration: (listener) => {
          configListener = listener;
          return { dispose: vi.fn() } as unknown as vscode.Disposable;
        },
      },
    );
    const sendStart = (
      terminal: vscode.Terminal,
      execution: vscode.TerminalShellExecution,
    ) => started?.({ terminal, execution } as vscode.TerminalShellExecutionStartEvent);
    const sendEnd = (
      terminal: vscode.Terminal,
      execution: vscode.TerminalShellExecution,
      exitCode: number,
    ) => ended?.({ terminal, execution, exitCode } as vscode.TerminalShellExecutionEndEvent);
    const run = async (
      terminal: vscode.Terminal,
      command: string,
      output: string,
      exitCode: number,
    ) => {
      const execution = execution2(command, output);
      sendStart(terminal, execution);
      sendEnd(terminal, execution, exitCode);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    /** Flip the setting without telling the tracker about it. */
    const setFlag = (value: boolean) => {
      on = value;
    };
    /** Report a configuration change; only for the watched setting when true. */
    const fireConfigChange = (affectsWatchedSetting: boolean) => {
      configListener?.({
        affectsConfiguration: (section: string) =>
          affectsWatchedSetting && section === SETTING,
      });
    };
    const setEnabled = (value: boolean) => {
      setFlag(value);
      fireConfigChange(true);
    };
    return { tracker, run, sendStart, sendEnd, setFlag, fireConfigChange, setEnabled };
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

  it('captures nothing while the setting is off', async () => {
    const { tracker, run } = harness(false);
    await run({ name: 'pwsh' } as vscode.Terminal, 'npm run buidl', "Missing script\n", 1);

    expect(tracker.recentUserCommands()).toEqual([]);
    tracker.dispose();
  });

  it('forgets what was captured when the setting is turned off', async () => {
    const { tracker, run, setEnabled } = harness();
    const terminal = { name: 'pwsh' } as vscode.Terminal;

    await run(terminal, 'echo marker', 'marker\n', 0);
    expect(tracker.recentUserCommands().map((entry) => entry.command)).toEqual(['echo marker']);

    setEnabled(false);
    expect(tracker.recentUserCommands()).toEqual([]);

    // Turning it back on starts from nothing: the marker never comes back.
    setEnabled(true);
    expect(tracker.recentUserCommands()).toEqual([]);

    await run(terminal, 'echo new', 'new\n', 0);
    expect(tracker.recentUserCommands()).toEqual([
      {
        command: 'echo new',
        terminalName: 'pwsh',
        status: 'completed',
        cwd: 'N:/Forge',
        exitCode: 0,
        output: 'new',
        outputTruncated: false,
      },
    ]);
    tracker.dispose();
  });

  it('stops a reader that is still streaming when the setting is turned off', async () => {
    const { tracker, run, sendStart, sendEnd, setEnabled } = harness();
    const terminal = { name: 'pwsh' } as vscode.Terminal;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execution = {
      commandLine: { value: 'echo slow', isTrusted: true, confidence: 2 },
      cwd: { scheme: 'file', fsPath: 'N:/Forge' },
      read: async function* () {
        yield 'first\n';
        await gate;
        yield 'second\n';
      },
    } as unknown as vscode.TerminalShellExecution;

    sendStart(terminal, execution);
    setEnabled(false);
    release();
    sendEnd(terminal, execution, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    setEnabled(true);
    expect(tracker.recentUserCommands()).toEqual([]);

    // The cancelled execution published nothing, before or after the switch.
    await run(terminal, 'echo after', 'after\n', 0);
    expect(tracker.recentUserCommands()).toEqual([
      {
        command: 'echo after',
        terminalName: 'pwsh',
        status: 'completed',
        cwd: 'N:/Forge',
        exitCode: 0,
        output: 'after',
        outputTruncated: false,
      },
    ]);
    tracker.dispose();
  });

  it('keeps the buffer when the change is for another setting', async () => {
    const { tracker, run, setFlag, fireConfigChange } = harness();
    const terminal = { name: 'pwsh' } as vscode.Terminal;

    await run(terminal, 'echo keep', 'keep\n', 0);
    setFlag(false);
    fireConfigChange(false);
    setFlag(true);

    expect(tracker.recentUserCommands().map((entry) => entry.command)).toEqual(['echo keep']);
    tracker.dispose();
  });

  it('captures nothing when the setting is unset', async () => {
    // The real default, and the stub hands back whatever fallback it is given:
    // this pins `default: false` in code.
    const { tracker, run } = harness(true, new TerminalCommandTracker());
    await run({ name: 'pwsh' } as vscode.Terminal, 'npm run buidl', "Missing script\n", 1);

    expect(tracker.recentUserCommands()).toEqual([]);
    tracker.dispose();
  });
});
