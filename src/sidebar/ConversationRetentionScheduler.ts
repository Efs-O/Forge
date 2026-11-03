/** Conversation inactivity timestamps, Keep open state, and the bounded expiry timer. */

import * as vscode from 'vscode';
import { z } from 'zod';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import { subscribeConversationSettled } from './workerChatWake';

export const DEFAULT_AUTO_ARCHIVE_MINUTES = 30;
export const MAX_AUTO_ARCHIVE_MINUTES = 1440;
const MINUTE_MS = 60_000;
const autoArchiveMinutesSchema = z.number().int().min(0).max(MAX_AUTO_ARCHIVE_MINUTES);

export type RetentionBlockState = 'clear' | 'blocked' | 'unknown';

export interface ConversationRetentionSchedulerDeps {
  getSidebar: () => SidebarRuntime;
  setSidebar: (next: SidebarRuntime) => void;
  persistSession: (changedId?: string) => void | Promise<boolean>;
  persistSidebar: (next: SidebarRuntime) => Promise<boolean>;
  post: (message: HostToWebview) => void;
  blockState: (id: string) => RetentionBlockState;
  archiveExpired: (id: string, expectedActivityAt: number) => boolean | Promise<boolean>;
  getSetting?: () => unknown;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  onInvalidSetting?: (message: string) => void;
}

function activityAt(conversation: ConversationRuntime, now: number): number {
  const value = conversation.retention_activity_at;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now
    ? value
    : now;
}

export function isConversationExpired(
  conversation: ConversationRuntime,
  minutes: number,
  now: number,
): boolean {
  return minutes > 0 && now >= activityAt(conversation, now) + minutes * MINUTE_MS;
}

/** One timer for the nearest eligible background deadline. */
export class ConversationRetentionScheduler {
  private readonly now: () => number;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancelTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  private minutes: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerGeneration = 0;
  private started = false;
  private disposed = false;
  private refreshing = false;
  private expiring = false;
  private readonly lastKnownBlockState = new Map<string, Exclude<RetentionBlockState, 'unknown'>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly deps: ConversationRetentionSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.scheduleTimeout =
      deps.scheduleTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimeout = deps.cancelTimeout ?? ((timer) => clearTimeout(timer));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.backfillActivityTimestamps();
    this.applySetting(this.readSetting(), true);
    this.listeners.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('forge.sessions.autoArchiveMinutes')) {
          this.applySetting(this.readSetting(), false);
        }
      }),
      subscribeConversationSettled((id) => {
        if (!this.deps.getSidebar().conversations.some((conversation) => conversation.id === id))
          return;
        this.markActivity(id);
        this.refresh();
      }),
    );
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    for (const listener of this.listeners) listener.dispose();
    this.listeners.length = 0;
  }

  /** Record user-facing activity without coupling it to updatedAt/history order. */
  markActivity(id: string): void {
    const sidebar = this.deps.getSidebar();
    const conversation = sidebar.conversations.find((item) => item.id === id);
    if (!conversation) return;
    const now = this.now();
    this.retryAfter.delete(id);
    if (conversation.retention_activity_at === now) return;
    // Turns keep a ConversationRuntime reference and mutate transcript and
    // accounting fields on it while streaming. Preserve that object identity
    // when updating the independent retention clock.
    conversation.retention_activity_at = now;
    this.deps.setSidebar({ ...sidebar, conversations: [...sidebar.conversations] });
    this.persistChanged(id);
    this.refresh();
  }

  /** Persist Keep open before the UI reports the new state as accepted. */
  async setKeepOpen(id: string, keepOpen: boolean): Promise<boolean> {
    // Reserve a fresh grace period before the persistence await. An expiry
    // callback already queued for the old deadline will fail its timestamp
    // revalidation while this pin is being committed.
    this.markActivity(id);
    const current = this.deps.getSidebar();
    const conversation = current.conversations.find((item) => item.id === id);
    if (!conversation || conversation.keep_open === keepOpen) return Boolean(conversation);
    const now = this.now();
    const nextConversation = {
      ...conversation,
      keep_open: keepOpen,
      ...(!keepOpen ? { retention_activity_at: now } : {}),
    };
    const nextSidebar = {
      ...current,
      conversations: current.conversations.map((item) =>
        item.id === id ? nextConversation : item,
      ),
    };
    let committed: boolean;
    try {
      committed = await this.deps.persistSidebar(nextSidebar);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.reportPersistenceFailure(
        `Could not confirm saving the chat retention setting. ${detail}`,
      );
      return false;
    }
    if (!committed) {
      this.reportPersistenceFailure('Could not confirm saving the chat retention setting.');
      return false;
    }
    if (this.deps.getSidebar() !== current) {
      if ((await this.deps.persistSession()) === false) {
        this.reportPersistenceFailure(
          'Could not restore the latest chat state after a concurrent change. The chat remains open.',
        );
        return false;
      }
      this.reportPersistenceFailure(
        'The chat changed before its retention setting could be applied. Try again.',
      );
      return false;
    }
    // The committed retention fields belong on the live object. A turn can
    // still hold and mutate that runtime while the disk write is in flight.
    conversation.keep_open = keepOpen;
    if (!keepOpen) conversation.retention_activity_at = now;
    this.deps.setSidebar({ ...current, conversations: [...current.conversations] });
    this.refresh();
    return true;
  }

  isExpired(conversation: ConversationRuntime, now = this.now()): boolean {
    return this.minutes !== undefined && isConversationExpired(conversation, this.minutes, now);
  }

  isEnabled(): boolean {
    return this.minutes !== undefined && this.minutes > 0;
  }

  /** Called when view, queue, remote, or other eviction signals may have changed. */
  refresh(): void {
    if (!this.started || this.disposed || this.refreshing || this.expiring) return;
    let rescheduleAfterRefresh = false;
    this.refreshing = true;
    try {
      const sidebar = this.deps.getSidebar();
      const liveIds = new Set(sidebar.conversations.map((conversation) => conversation.id));
      for (const id of this.lastKnownBlockState.keys()) {
        if (!liveIds.has(id)) this.lastKnownBlockState.delete(id);
      }
      for (const id of this.retryAfter.keys()) {
        if (!liveIds.has(id)) this.retryAfter.delete(id);
      }
      const now = this.now();
      const candidates: Array<{ conversation: ConversationRuntime; deadline: number }> = [];
      let changedId: string | undefined;
      let changedAt: number | undefined;
      for (const conversation of sidebar.conversations) {
        const state = this.stateFor(conversation, sidebar.activeConversationId);
        if (state !== 'unknown') {
          const previous = this.lastKnownBlockState.get(conversation.id);
          if (previous === 'blocked' && state === 'clear') {
            this.lastKnownBlockState.set(conversation.id, state);
            changedId = conversation.id;
            changedAt = now;
            break;
          }
          this.lastKnownBlockState.set(conversation.id, state);
        }
        if (
          state !== 'clear' ||
          this.minutes === undefined ||
          this.minutes === 0 ||
          conversation.keep_open === true
        ) {
          continue;
        }
        candidates.push({
          conversation,
          deadline: Math.max(
            activityAt(conversation, now) + this.minutes * MINUTE_MS,
            this.retryAfter.get(conversation.id) ?? 0,
          ),
        });
      }
      if (changedId !== undefined && changedAt !== undefined) {
        this.writeActivityAt(changedId, changedAt);
        rescheduleAfterRefresh = true;
      } else {
        this.scheduleNearest(candidates, now);
      }
    } finally {
      this.refreshing = false;
    }
    if (rescheduleAfterRefresh) this.refresh();
  }

  private stateFor(conversation: ConversationRuntime, activeId: string): RetentionBlockState {
    if (conversation.id === activeId || conversation.keep_open === true) return 'blocked';
    return this.deps.blockState(conversation.id);
  }

  private scheduleNearest(
    candidates: Array<{ conversation: ConversationRuntime; deadline: number }>,
    now: number,
  ): void {
    this.clearTimer();
    if (this.minutes === undefined || this.minutes === 0 || candidates.length === 0) return;
    const nearest = candidates.reduce(
      (minimum, candidate) => Math.min(minimum, candidate.deadline),
      Infinity,
    );
    const generation = this.timerGeneration;
    this.timer = this.scheduleTimeout(
      () => {
        if (this.disposed || generation !== this.timerGeneration) return;
        this.timer = undefined;
        void this.expireDue();
      },
      Math.max(0, nearest - now),
    );
  }

  private async expireDue(): Promise<void> {
    if (this.expiring || this.disposed) return;
    this.expiring = true;
    try {
      const now = this.now();
      const sidebar = this.deps.getSidebar();
      const due = sidebar.conversations.filter(
        (conversation) =>
          this.stateFor(conversation, sidebar.activeConversationId) === 'clear' &&
          conversation.keep_open !== true &&
          this.isExpired(conversation, now),
      );
      for (const conversation of due) {
        const expectedActivityAt = activityAt(conversation, now);
        try {
          const archived = await this.deps.archiveExpired(conversation.id, expectedActivityAt);
          if (!archived)
            this.deferFailedArchiveIfStillEligible(conversation.id, expectedActivityAt, now);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.reportPersistenceFailure(
            `Could not archive an expired chat. It remains open. ${detail}`,
          );
          this.deferFailedArchiveIfStillEligible(conversation.id, expectedActivityAt, now);
        }
      }
    } finally {
      this.expiring = false;
    }
    this.refresh();
  }

  private clearTimer(): void {
    this.timerGeneration += 1;
    if (this.timer !== undefined) {
      this.cancelTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private backfillActivityTimestamps(): void {
    const sidebar = this.deps.getSidebar();
    const now = this.now();
    let changed = false;
    for (const conversation of sidebar.conversations) {
      if (
        conversation.retention_activity_at !== undefined &&
        activityAt(conversation, now) === conversation.retention_activity_at
      ) {
        if (conversation.keep_open !== undefined) continue;
        changed = true;
        conversation.keep_open = false;
        continue;
      }
      changed = true;
      conversation.retention_activity_at = now;
      conversation.keep_open = conversation.keep_open === true;
    }
    if (!changed) return;
    this.deps.setSidebar({ ...sidebar, conversations: [...sidebar.conversations] });
    this.persistChanged();
  }

  private writeActivityAt(id: string, at: number): void {
    const sidebar = this.deps.getSidebar();
    const conversation = sidebar.conversations.find((item) => item.id === id);
    if (!conversation || conversation.retention_activity_at === at) return;
    this.retryAfter.delete(id);
    conversation.retention_activity_at = at;
    this.deps.setSidebar({ ...sidebar, conversations: [...sidebar.conversations] });
    this.persistChanged(id);
  }

  private persistChanged(id?: string): void {
    try {
      const result = this.deps.persistSession(id);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result)
          .then((ok) => {
            if (ok === false)
              this.reportPersistenceFailure('Could not save chat activity. The chat remains open.');
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.reportPersistenceFailure(
              `Could not save chat activity. The chat remains open. ${detail}`,
            );
          });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.reportPersistenceFailure(
        `Could not save chat activity. The chat remains open. ${detail}`,
      );
    }
  }

  private applySetting(raw: unknown, initial: boolean): void {
    const parsed = autoArchiveMinutesSchema.safeParse(raw);
    if (!parsed.success) {
      this.minutes = undefined;
      this.clearTimer();
      this.deps.onInvalidSetting?.(
        'Forge setting forge.sessions.autoArchiveMinutes must be a whole number from 0 to 1440.',
      );
      return;
    }
    const wasEnabled = this.minutes !== undefined && this.minutes > 0;
    this.minutes = parsed.data;
    if (!initial && !wasEnabled && parsed.data > 0) this.resetAllActivity();
    this.refresh();
  }

  private resetAllActivity(): void {
    const sidebar = this.deps.getSidebar();
    const now = this.now();
    this.retryAfter.clear();
    for (const conversation of sidebar.conversations) conversation.retention_activity_at = now;
    this.deps.setSidebar({ ...sidebar, conversations: [...sidebar.conversations] });
    this.persistChanged();
    this.refresh();
  }

  private readSetting(): unknown {
    return this.deps.getSetting
      ? this.deps.getSetting()
      : vscode.workspace.getConfiguration('forge.sessions').get<unknown>('autoArchiveMinutes');
  }

  private reportPersistenceFailure(message: string): void {
    this.deps.post({ type: 'error', message: `Forge: ${message}` });
  }

  private deferFailedArchiveIfStillEligible(
    id: string,
    expectedActivityAt: number,
    now: number,
  ): void {
    const sidebar = this.deps.getSidebar();
    const conversation = sidebar.conversations.find((item) => item.id === id);
    if (
      !conversation ||
      this.stateFor(conversation, sidebar.activeConversationId) !== 'clear' ||
      conversation.keep_open === true ||
      conversation.retention_activity_at !== expectedActivityAt ||
      !this.isExpired(conversation, now)
    ) {
      return;
    }
    this.retryAfter.set(id, now + MINUTE_MS);
  }
}
