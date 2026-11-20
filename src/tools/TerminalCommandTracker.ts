import * as vscode from 'vscode';

/** Per-command output cap. Several commands are carried at once. */
const MAX_USER_OUTPUT_CHARS = 4_000;
/** How many of the user's own recent commands are retained. */
const MAX_USER_COMMANDS = 5;
/** The setting that turns the user's own terminal capture on and off. */
const WATCH_USER_COMMANDS = 'forge.terminal.watchUserCommands';
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

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
  /** Set when capture was switched off: stop reading, publish nothing. */
  cancelled?: boolean;
}

interface TrackedUserCommand extends UserTerminalCommand, CapturedOutput {
  execution: vscode.TerminalShellExecution;
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

/** The VS Code surface that reports configuration changes. */
interface ConfigurationEvents {
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(section: string): boolean }) => void,
  ): vscode.Disposable;
}

function cwdOf(uri: vscode.Uri | undefined): string | undefined {
  if (!uri) return undefined;
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

/**
 * Read live so toggling the setting takes effect without a reload. A window
 * whose configuration cannot be read gets the safe answer: capture is off, so
 * nothing the user typed is offered to the model.
 */
function userCaptureEnabled(): boolean {
  try {
    return vscode.workspace
      .getConfiguration('forge')
      .get<boolean>('terminal.watchUserCommands', false);
  } catch {
    return false;
  }
}

function stripTerminalEscapes(text: string): string {
  const osc = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
  const csi = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return text.replace(osc, '').replace(csi, '');
}

/**
 * Captures commands the user ran themselves from VS Code shell-integration.
 *
 * Only executions that start after activation are seen; no scrollback or
 * terminal history is ever read, and the user's own commands are captured only
 * while `forge.terminal.watchUserCommands` is enabled. Switching that setting
 * off forgets what was already captured, and nothing is handed to the model
 * while it is off.
 */
export class TerminalCommandTracker implements vscode.Disposable {
  private readonly byUserExecution = new Map<vscode.TerminalShellExecution, TrackedUserCommand>();
  /** Oldest first; trimmed to MAX_USER_COMMANDS. */
  private readonly userCommands: TrackedUserCommand[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Injected so tests can switch capture without a live configuration. */
  private readonly captureEnabled: () => boolean;

  constructor(captureEnabled: () => boolean = userCaptureEnabled) {
    this.captureEnabled = captureEnabled;
  }

  start(
    events: TerminalExecutionEvents = vscode.window,
    config: ConfigurationEvents = vscode.workspace,
  ): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      events.onDidStartTerminalShellExecution((event) => this.captureStarted(event)),
      events.onDidEndTerminalShellExecution((event) => {
        void this.captureEnded(event);
      }),
      config.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(WATCH_USER_COMMANDS) && !this.captureEnabled()) {
          this.forget();
        }
      }),
    );
  }

  /** The user's own recent commands, newest first; empty while capture is off. */
  recentUserCommands(): UserTerminalCommand[] {
    if (!this.captureEnabled()) return [];
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

  async captureEnded(event: vscode.TerminalShellExecutionEndEvent): Promise<void> {
    const user = this.byUserExecution.get(event.execution);
    if (!user) return;
    this.byUserExecution.delete(event.execution);
    await user.readTask;
    user.status = 'completed';
    user.exitCode = event.exitCode;
    user.cwd = cwdOf(event.execution.cwd) ?? user.cwd;
  }

  captureStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!this.captureEnabled()) return;
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
    this.forget();
  }

  /** Drop everything captured and stop every reader still running. */
  private forget(): void {
    for (const record of this.userCommands) record.cancelled = true;
    for (const record of this.byUserExecution.values()) record.cancelled = true;
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
      if (tracked.cancelled) return;
      if (output.length >= limit) {
        tracked.outputTruncated = true;
        continue;
      }
      const remaining = limit - output.length;
      output += chunk.slice(0, remaining);
      if (chunk.length > remaining) tracked.outputTruncated = true;
    }
    if (tracked.cancelled) return;
    const clean = stripTerminalEscapes(output).trim();
    if (clean) tracked.output = clean;
  }
}

/** One extension-wide tracker, started and disposed by extension activation. */
export const terminalCommandTracker = new TerminalCommandTracker();
