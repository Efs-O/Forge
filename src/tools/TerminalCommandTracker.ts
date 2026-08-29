import * as vscode from 'vscode';

const MAX_OUTPUT_CHARS = 12_000;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

export type TerminalCommandStatus = 'waiting' | 'running' | 'completed';

export interface TerminalCommandObservation {
  command: string;
  intendedCwd: string;
  status: TerminalCommandStatus;
  actualCwd?: string | undefined;
  exitCode?: number | undefined;
  output?: string | undefined;
  outputTruncated: boolean;
}

interface TrackedCommand extends TerminalCommandObservation {
  terminal: vscode.Terminal;
  conversationId?: string | undefined;
  execution?: vscode.TerminalShellExecution | undefined;
  readTask?: Promise<void> | undefined;
}

interface TerminalExecutionEvents {
  onDidStartTerminalShellExecution(
    listener: (event: vscode.TerminalShellExecutionStartEvent) => void,
  ): vscode.Disposable;
  onDidEndTerminalShellExecution(
    listener: (event: vscode.TerminalShellExecutionEndEvent) => void,
  ): vscode.Disposable;
}

function cwdOf(uri: vscode.Uri | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

function sameCommand(left: string, right: string): boolean {
  return left.trim().replace(/\r\n/g, '\n') === right.trim().replace(/\r\n/g, '\n');
}

function stripTerminalEscapes(text: string): string {
  const osc = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
  const csi = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return text.replace(osc, '').replace(csi, '');
}

/**
 * Captures results only for commands Forge pasted into terminals it created.
 * The global shell-integration listeners immediately ignore every other
 * terminal, and no scrollback or terminal history is ever read.
 */
export class TerminalCommandTracker implements vscode.Disposable {
  private readonly byTerminal = new Map<vscode.Terminal, TrackedCommand>();
  private readonly byConversation = new Map<string, TrackedCommand>();
  private readonly subscriptions: vscode.Disposable[] = [];

  start(events: TerminalExecutionEvents = vscode.window): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      events.onDidStartTerminalShellExecution((event) => this.captureStarted(event)),
      events.onDidEndTerminalShellExecution((event) => {
        void this.captureEnded(event);
      }),
    );
  }

  trackPastedCommand(
    terminal: vscode.Terminal,
    command: string,
    intendedCwd: string,
    conversationId?: string,
  ): void {
    const tracked: TrackedCommand = {
      terminal,
      command,
      intendedCwd,
      status: 'waiting',
      outputTruncated: false,
      ...(conversationId ? { conversationId } : {}),
    };
    this.byTerminal.set(terminal, tracked);
    if (conversationId) this.byConversation.set(conversationId, tracked);
  }

  latestForConversation(conversationId: string): TerminalCommandObservation | undefined {
    const tracked = this.byConversation.get(conversationId);
    if (!tracked) return undefined;
    return {
      command: tracked.command,
      intendedCwd: tracked.intendedCwd,
      status: tracked.status,
      ...(tracked.actualCwd ? { actualCwd: tracked.actualCwd } : {}),
      ...(tracked.exitCode !== undefined ? { exitCode: tracked.exitCode } : {}),
      ...(tracked.output ? { output: tracked.output } : {}),
      outputTruncated: tracked.outputTruncated,
    };
  }

  captureStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const tracked = this.byTerminal.get(event.terminal);
    if (!tracked || !sameCommand(tracked.command, event.execution.commandLine.value)) return;
    tracked.status = 'running';
    tracked.execution = event.execution;
    tracked.actualCwd = cwdOf(event.execution.cwd);
    tracked.readTask = this.readOutput(tracked, event.execution);
  }

  async captureEnded(event: vscode.TerminalShellExecutionEndEvent): Promise<void> {
    const tracked = this.byTerminal.get(event.terminal);
    if (!tracked || tracked.execution !== event.execution) return;
    await tracked.readTask;
    tracked.status = 'completed';
    tracked.exitCode = event.exitCode;
    tracked.actualCwd = cwdOf(event.execution.cwd) ?? tracked.actualCwd;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.byTerminal.clear();
    this.byConversation.clear();
  }

  private async readOutput(
    tracked: TrackedCommand,
    execution: vscode.TerminalShellExecution,
  ): Promise<void> {
    let output = '';
    for await (const chunk of execution.read()) {
      if (output.length >= MAX_OUTPUT_CHARS) {
        tracked.outputTruncated = true;
        continue;
      }
      const remaining = MAX_OUTPUT_CHARS - output.length;
      output += chunk.slice(0, remaining);
      if (chunk.length > remaining) tracked.outputTruncated = true;
    }
    const clean = stripTerminalEscapes(output).trim();
    if (clean) tracked.output = clean;
  }
}

/** One extension-wide tracker, started and disposed by extension activation. */
export const terminalCommandTracker = new TerminalCommandTracker();
