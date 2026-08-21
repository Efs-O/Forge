/**
 * Status bar for the selected conversation's active time and model usage.
 * The timer is active-agent time: model work and tools, excluding approvals.
 */

import * as vscode from 'vscode';

export interface SessionTimeSnapshot {
  activeMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export class SessionTimeStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly timer: NodeJS.Timeout;
  private lastSignature = '';

  constructor(private readonly getSnapshot: () => SessionTimeSnapshot) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'Forge Session Time';
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  /** Refresh immediately after a conversation switch or generation boundary. */
  refresh(): void {
    const snapshot = this.getSnapshot();
    const activeMs = Math.max(0, snapshot.activeMs);
    const signature = `${activeMs}|${snapshot.inputTokens ?? ''}|${snapshot.outputTokens ?? ''}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    const input = formatTokenCount(snapshot.inputTokens);
    const output = formatTokenCount(snapshot.outputTokens);
    this.item.text = `$(timer) ${formatSessionDuration(activeMs)}  $(symbol-number) ${input} in / ${output} out`;
    this.item.tooltip = [
      'Forge session usage',
      `Active agent time: ${formatSessionDuration(activeMs)} (approval waits excluded)`,
      `Input tokens: ${formatExactTokenCount(snapshot.inputTokens)}`,
      `Output tokens: ${formatExactTokenCount(snapshot.outputTokens)}`,
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}

export function formatSessionDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1000) return String(Math.max(0, Math.floor(value)));
  if (value < 1_000_000) return `${trimUnit(value / 1_000)}k`;
  if (value < 1_000_000_000) return `${trimUnit(value / 1_000_000)}M`;
  return `${trimUnit(value / 1_000_000_000)}B`;
}

function trimUnit(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
}

function formatExactTokenCount(value: number | undefined): string {
  return value === undefined ? 'unavailable' : Math.max(0, Math.floor(value)).toLocaleString();
}
