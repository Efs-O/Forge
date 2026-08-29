import * as vscode from 'vscode';

const MAX_OUTPUT_CHARS = 12_000;
/** Per-command cap for user-typed commands. Several are carried at once. */
const MAX_USER_OUTPUT_CHARS = 4_000;
/** How many of the user's own recent commands are retained. */
const MAX_USER_COMMANDS = 5;
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

/** A command the user typed themselves, in any terminal. */
export interface UserTerminalCommand {
  command: string;
  terminalName: string;
  status: 'running' | 'completed';
  cwd?: string | undefined;
  exitCode?: number | undefined;
  output?: string | undefined;
  outputTruncated: boolean;
}

interface CapturedOutput {
  output?: string | undefined;
  outputTruncated: boolean;
}

interface TrackedUserCommand extends UserTerminalCommand {
  execution: vscode.TerminalShellExecution;
  readTask?: Promise<void> | undefined;
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

/** Read live so toggling the setting takes effect without a reload. */
function userCaptureEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('forge')
    .get<boolean>('terminal.watchUserCommands', true);
}

function stripTerminalEscapes(text: string): string {
  const osc = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
  const csi = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return text.replace(osc, '').replace(csi, '');
}

/**
 * Captures two things from VS Code's shell-integration events: the outcome of
 * commands Forge pasted into terminals it created, and — so the agent can
 * correct a command that just failed — the commands the user ran themselves.
 *
 * Only executions that start after activation are seen; no scrollback or
 * terminal history is ever read, and the user's own commands are captured only
 * while `forge.terminal.watchUserCommands` is enabled.
 */
export class TerminalCommandTracker implements vscode.Disposable {
  private readonly byTerminal = new Map<vscode.Terminal, TrackedCommand>();
  private readonly byConversation = new Map<string, TrackedCommand>();
  private readonly byUserExecution = new Map<vscode.TerminalShellExecution, TrackedUserCommand>();
  /** Oldest first; trimmed to MAX_USER_COMMANDS. */
  private readonly userCommands: TrackedUserCommand[] = [];
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

  /** The user's own recent commands, newest first. */
  recentUserCommands(): UserTerminalCommand[] {
    return this.userCommands
      .map((entry) => ({
        command: entry.command,
        terminalName: entry.terminalName,
        status: entry.status,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
        ...(entry.output ? { output: entry.output } : {}),
        outputTruncated: entry.outputTruncated,
      }))
      .reverse();
  }

  captureStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const tracked = this.byTerminal.get(event.terminal);
    if (tracked && sameCommand(tracked.command, event.execution.commandLine.value)) {
      tracked.status = 'running';
      tracked.execution = event.execution;
      tracked.actualCwd = cwdOf(event.execution.cwd);
      tracked.readTask = this.readOutput(tracked, event.execution, MAX_OUTPUT_CHARS);
      return;
    }
    // Anything else in this terminal is something the user ran themselves —
    // including a command they typed into a terminal Forge created.
    this.captureUserStarted(event);
  }

  async captureEnded(event: vscode.TerminalShellExecutionEndEvent): Promise<void> {
    const tracked = this.byTerminal.get(event.terminal);
    if (tracked && tracked.execution === event.execution) {
      await tracked.readTask;
      tracked.status = 'completed';
      tracked.exitCode = event.exitCode;
      tracked.actualCwd = cwdOf(event.execution.cwd) ?? tracked.actualCwd;
      return;
    }
    const user = this.byUserExecution.get(event.execution);
    if (!user) return;
    this.byUserExecution.delete(event.execution);
    await user.readTask;
    user.status = 'completed';
    user.exitCode = event.exitCode;
    user.cwd = cwdOf(event.execution.cwd) ?? user.cwd;
  }

  private captureUserStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!userCaptureEnabled()) return;
    const command = event.execution.commandLine.value.trim();
    if (!command) return;
    const record: TrackedUserCommand = {
      command,
      terminalName: event.terminal.name,
      status: 'running',
      outputTruncated: false,
      execution: event.execution,
      ...(cwdOf(event.execution.cwd) ? { cwd: cwdOf(event.execution.cwd) } : {}),
    };
    this.userCommands.push(record);
    while (this.userCommands.length > MAX_USER_COMMANDS) {
      const dropped = this.userCommands.shift();
      if (dropped) this.byUserExecution.delete(dropped.execution);
    }
    this.byUserExecution.set(event.execution, record);
    record.readTask = this.readOutput(record, event.execution, MAX_USER_OUTPUT_CHARS);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.byTerminal.clear();
    this.byConversation.clear();
    this.byUserExecution.clear();
    this.userCommands.length = 0;
  }

  private async readOutput(
    tracked: CapturedOutput,
    execution: vscode.TerminalShellExecution,
    limit: number,
  ): Promise<void> {
    let output = '';
    for await (const chunk of execution.read()) {
      if (output.length >= limit) {
        tracked.outputTruncated = true;
        continue;
      }
      const remaining = limit - output.length;
      output += chunk.slice(0, remaining);
      if (chunk.length > remaining) tracked.outputTruncated = true;
    }
    const clean = stripTerminalEscapes(output).trim();
    if (clean) tracked.output = clean;
  }
}

/** One extension-wide tracker, started and disposed by extension activation. */
export const terminalCommandTracker = new TerminalCommandTracker();
