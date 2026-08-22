/**
 * Status bar for the selected conversation's active time and model usage.
 * The timer is active-agent time: model work and tools, excluding approvals.
 *
 * Every token here is provider-reported. `contextTokens` is the same
 * `reportedContextTokens` value the sidebar bar and the HalluMeter bridge show,
 * so the two displays cannot disagree.
 */

import * as vscode from 'vscode';
import { formatTokens, formatExactTokens } from '../util/formatTokens';

export interface SessionTimeSnapshot {
  activeMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt + completion of the last request: the context now in the slot. */
  contextTokens?: number;
  /** Prompt half of that last request. */
  currentInputTokens?: number;
  /** Completion half of that last request. */
  currentOutputTokens?: number;
  requestCount?: number;
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
    const signature = [
      activeMs,
      snapshot.inputTokens ?? '',
      snapshot.outputTokens ?? '',
      snapshot.contextTokens ?? '',
      snapshot.currentInputTokens ?? '',
      snapshot.currentOutputTokens ?? '',
      snapshot.requestCount ?? '',
    ].join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.item.text = formatSessionStatus({ ...snapshot, activeMs });
    this.item.tooltip = [
      'Forge session usage',
      `Active agent time: ${formatSessionDuration(activeMs)} (approval waits excluded)`,
      `Context in use: ${formatExactTokens(snapshot.contextTokens)}`,
      `Last request: ${formatExactTokens(snapshot.currentInputTokens)} prompt + ${formatExactTokens(snapshot.currentOutputTokens)} completion`,
      `Session input processed: ${formatExactTokens(snapshot.inputTokens)}`,
      `Session output generated: ${formatExactTokens(snapshot.outputTokens)}`,
      `Model requests: ${snapshot.requestCount ?? 0}`,
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

export function formatSessionStatus(snapshot: SessionTimeSnapshot): string {
  return `$(timer) ${formatSessionDuration(snapshot.activeMs)}  $(layers) ctx ${formatTokens(snapshot.contextTokens)} · session out ${formatTokens(snapshot.outputTokens)}`;
}
