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

/**
 * Apply the `forge.logLevel` VS Code setting.
 *
 * The setting is contributed in package.json and appears in the settings UI,
 * but nothing read it until 0.13.0 — a user who set it to `debug` got `info`
 * and no indication why. Config.yaml's `log_level` still wins where present
 * (`extension.ts` applies it after this, and again on hot reload), so this
 * only fills the gap for the common case of a config that does not set it.
 */
export function initLogger(_context: unknown): void {
  const setting = vscode.workspace.getConfiguration('forge').get<string>('logLevel');
  if (setting && setting in LEVELS) logger.setLevel(setting as LogLevel);
}

export function getLogger(): Logger {
  return logger;
}
