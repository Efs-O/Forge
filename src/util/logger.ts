import * as vscode from 'vscode';
import type { LogLevel } from '../llm/types';

const LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

class Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel = 'info';

  constructor() {
    this.channel = vscode.window.createOutputChannel('Forge');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, msg: string): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }

  trace(msg: string): void {
    this.log('trace', msg);
  }
  debug(msg: string): void {
    this.log('debug', msg);
  }
  info(msg: string): void {
    this.log('info', msg);
  }
  warn(msg: string): void {
    this.log('warn', msg);
  }
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : '';
    this.log('error', `${msg}${detail}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

export const logger = new Logger();

/** No-op in v0.1 — reserved for future per-extension-instance setup. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initLogger(_context: unknown): void {}

export function getLogger(): Logger {
  return logger;
}
