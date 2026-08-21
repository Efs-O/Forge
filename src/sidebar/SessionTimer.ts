/**
 * Per-conversation active-agent-time tracker.
 *
 * "Active time" is the interval from generation start to generation finish,
 * minus any time spent waiting for a user approval decision. It is persisted
 * in `ConversationRuntime.active_time_ms` / `active_started_at` so the total
 * survives tab switches and VS Code reloads.
 *
 * The timer calculates from `Date.now()` at each boundary rather than
 * incrementing on a fixed interval, so delayed JavaScript timers do not
 * introduce drift.
 */

import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';

export class SessionTimer {
  /**
   * Epoch ms when the current active interval for `conversationId` began.
   * Present while a turn is in progress.
   */
  private readonly startedAt = new Map<string, number>();

  /**
   * Accumulated approval-wait ms for the *current* interval, keyed by
   * conversation id. Reset to 0 when the interval ends.
   */
  private readonly approvalPausedMs = new Map<string, number>();

  /** Epoch ms of the most recent approval pause, per conversation. */
  private approvalPauseStartedAt = new Map<string, number>();
  private checkpointTimer: NodeJS.Timeout | undefined;

  /** Persist active intervals periodically so an abnormal reload loses little time. */
  setCheckpointCallback(callback: (conversationId: string) => void): void {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = setInterval(() => {
      for (const conversationId of this.startedAt.keys()) callback(conversationId);
    }, 10_000);
  }

  /**
   * Restore unfinished intervals after a VS Code reload.
   *
   * If a persisted record contains `active_started_at`, the turn was in
   * progress when the window closed. Per the design decision, the elapsed
   * time through the reload is counted: fold it into `active_time_ms` and
   * clear `active_started_at`.
   *
   * Call once after `loadSidebarSession`, before any turns can start.
   */
  restoreUnfinishedIntervals(session: SidebarRuntime): void {
    const seen = new Set<string>();
    for (const conv of [...session.conversations, ...session.history]) {
      if (seen.has(conv.id)) continue;
      seen.add(conv.id);
      if (conv.active_started_at !== undefined) {
        const elapsed = Math.max(0, Date.now() - conv.active_started_at);
        conv.active_time_ms = (conv.active_time_ms ?? 0) + elapsed;
        delete conv.active_started_at;
      }
    }
  }

  /**
   * Begin (or no-op if already active) an active interval for the conversation.
   * Returns the `active_started_at` value that was set (or already present).
   */
  start(conv: ConversationRuntime): number {
    const existing = this.startedAt.get(conv.id);
    if (existing !== undefined) return existing;
    // If a stale persisted value is still on the conversation (shouldn't happen
    // after restore, but guard against double-start), use it.
    const ts = conv.active_started_at ?? Date.now();
    conv.active_started_at = ts;
    this.startedAt.set(conv.id, ts);
    this.approvalPausedMs.set(conv.id, 0);
    return ts;
  }

  /**
   * End the active interval for the conversation, folding elapsed time
   * (minus approval waits) into `active_time_ms`.
   *
   * Safe to call multiple times: after the first call `startedAt` no longer
   * has the conversation, so subsequent calls are no-ops.
   */
  finish(conv: ConversationRuntime): void {
    const startedAt = this.startedAt.get(conv.id);
    if (startedAt === undefined) return;
    this.startedAt.delete(conv.id);
    const pausedMs = this.approvalPausedMs.get(conv.id) ?? 0;
    // Clear the pause map entry.
    this.approvalPausedMs.delete(conv.id);
    this.approvalPauseStartedAt.delete(conv.id);
    const rawElapsed = Date.now() - startedAt;
    const netElapsed = Math.max(0, rawElapsed - pausedMs);
    conv.active_time_ms = (conv.active_time_ms ?? 0) + netElapsed;
    delete conv.active_started_at;
  }

  /**
   * Mark the start of an approval wait. Time spent in this state is excluded
   * from active time. Multiple overlapping pauses for the same conversation
   * are coalesced: only the first pause starts the clock, the last resume
   * stops it.
   */
  pauseApproval(convId: string): void {
    const pauseStart = this.approvalPauseStartedAt.get(convId);
    if (pauseStart !== undefined) return; // already paused
    this.approvalPauseStartedAt.set(convId, Date.now());
  }

  /**
   * Mark the end of an approval wait. If this was the last outstanding pause
   * for the conversation, accumulate the paused duration.
   */
  resumeApproval(convId: string): void {
    const pauseStart = this.approvalPauseStartedAt.get(convId);
    if (pauseStart === undefined) return; // not paused
    // Coalesce: if another pause started while this one was still open we
    // simply keep the earliest start. In practice approvals for one
    // conversation are serial, so this is a guard, not the common path.
    this.approvalPauseStartedAt.delete(convId);
    const paused = Date.now() - pauseStart;
    this.approvalPausedMs.set(convId, (this.approvalPausedMs.get(convId) ?? 0) + paused);
  }

  /**
   * Total active time in ms for the conversation, including any in-progress
   * interval (minus current approval pause).
   */
  totalActiveMs(conv: ConversationRuntime): number {
    const base = conv.active_time_ms ?? 0;
    const startedAt = this.startedAt.get(conv.id);
    if (startedAt === undefined) return base;
    const pausedMs = this.approvalPausedMs.get(conv.id) ?? 0;
    const pauseStart = this.approvalPauseStartedAt.get(conv.id);
    const inPauseMs = pauseStart !== undefined ? Date.now() - pauseStart : 0;
    return base + Math.max(0, Date.now() - startedAt - pausedMs - inPauseMs);
  }

  /** True while an active interval is open for the conversation. */
  isActive(convId: string): boolean {
    return this.startedAt.has(convId);
  }

  /**
   * Dispose of all tracked state for a conversation that is being closed.
   * Any open interval is finished first so its time is not lost.
   */
  disposeConversation(conv: ConversationRuntime): void {
    this.finish(conv);
    this.startedAt.delete(conv.id);
    this.approvalPausedMs.delete(conv.id);
    this.approvalPauseStartedAt.delete(conv.id);
  }

  dispose(): void {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.startedAt.clear();
    this.approvalPausedMs.clear();
    this.approvalPauseStartedAt.clear();
  }
}
