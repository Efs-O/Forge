/**
 * Status bar for the selected conversation's active time and model usage.
 * The timer is active-agent time: model work and tools, excluding approvals.
 *
 * Every token here is provider-reported, except the `live*` pair: those are
 * estimated from the running request's streamed text, shown with `~`, and
 * replaced by the server's count when the request ends. `contextTokens` is the
 * same `reportedContextTokens` value the sidebar bar and the HalluMeter bridge
 * show, so the two displays cannot disagree.
 *
 * The bar follows the chat that most recently started a turn until the user
 * picks a chat, so a chat run in the background is the one it reports.
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
  /** Tool calls dispatched in this conversation, successes and failures alike. */
  toolCallCount?: number;
  /** Compactions executed in this conversation (auto or manual), successes only. */
  compactCount?: number;
  /** Title of the followed chat, set only when it is not the one on screen. */
  following?: string;
  /** Estimated thinking tokens the running request has streamed so far. */
  liveReasoningTokens?: number;
  /** Estimated answer tokens the running request has streamed so far. */
  liveAnswerTokens?: number;
}

export class SessionTimeStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly timer: NodeJS.Timeout;
  private lastSignature = '';
  private followed: string | undefined;

  constructor(private readonly getSnapshot: (followed: string | undefined) => SessionTimeSnapshot) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'Forge Session Time';
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  /** Report this chat until the next call; undefined goes back to the visible one. */
  follow(conversationId: string | undefined): void {
    this.followed = conversationId;
  }

  /** Refresh immediately after a conversation switch or generation boundary. */
  refresh(): void {
    const snapshot = this.getSnapshot(this.followed);
    const activeMs = Math.max(0, snapshot.activeMs);
    const signature = [
      activeMs,
      snapshot.inputTokens ?? '',
      snapshot.outputTokens ?? '',
      snapshot.contextTokens ?? '',
      snapshot.currentInputTokens ?? '',
      snapshot.currentOutputTokens ?? '',
      snapshot.requestCount ?? '',
      snapshot.toolCallCount ?? '',
      snapshot.compactCount ?? '',
      snapshot.following ?? '',
      snapshot.liveReasoningTokens ?? '',
      snapshot.liveAnswerTokens ?? '',
    ].join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.item.text = formatSessionStatus({ ...snapshot, activeMs });
    this.item.tooltip = [
      snapshot.following ? `Forge session usage: "${snapshot.following}"` : 'Forge session usage',
      ...(snapshot.following
        ? ['(the chat that last started a turn; pick a chat to show that one instead)']
        : []),
      `Active agent time: ${formatSessionDuration(activeMs)} (approval waits excluded)`,
      `Context in use: ${formatExactTokens(snapshot.contextTokens)}`,
      `Last request: ${formatExactTokens(snapshot.currentInputTokens)} prompt + ${formatExactTokens(snapshot.currentOutputTokens)} completion`,
      `Session input processed: ${formatExactTokens(snapshot.inputTokens)}`,
      `Session output generated: ${formatExactTokens(snapshot.outputTokens)}`,
      `Model requests: ${snapshot.requestCount ?? 0}`,
      `Tool calls: ${snapshot.toolCallCount ?? 0}`,
      `Compactions: ${snapshot.compactCount ?? 0}`,
      ...(snapshot.liveReasoningTokens !== undefined
        ? [
            `Streaming now: ~${snapshot.liveReasoningTokens} thinking + ~${snapshot.liveAnswerTokens ?? 0} answer tokens (estimated from characters; the server's count replaces it when the request ends)`,
          ]
        : []),
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

/** Long enough to tell chats apart, short enough to leave the bar room. */
const FOLLOWING_TITLE_CHARS = 24;

export function formatSessionStatus(snapshot: SessionTimeSnapshot): string {
  const title = snapshot.following;
  const following = title
    ? `$(eye) ${title.length > FOLLOWING_TITLE_CHARS ? `${title.slice(0, FOLLOWING_TITLE_CHARS)}…` : title}  `
    : '';
  const live =
    snapshot.liveReasoningTokens !== undefined
      ? `  $(sync~spin) think ~${formatTokens(snapshot.liveReasoningTokens)} · answer ~${formatTokens(snapshot.liveAnswerTokens ?? 0)}`
      : '';
  return `${following}$(timer) ${formatSessionDuration(snapshot.activeMs)}  $(layers) ctx ${formatTokens(snapshot.contextTokens)} · session out ${formatTokens(snapshot.outputTokens)}${live}`;
}
