/**
 * The two halves of a workspace switch that the departure record alone cannot
 * cover, both learned from one silent failure: `/new` recorded the handoff,
 * stopped this window's transports, and called `vscode.openFolder` — which
 * *focused the window that already had that folder open* instead of reloading
 * this one. Nothing reloaded, so nothing ran the activation-time claim, and the
 * transport lease had already been released. No window served the chat, and the
 * chat was told only "switching…".
 *
 * So: a running window watches for a handoff addressed to it and claims it
 * without a restart, and the window that started the switch undoes it if
 * nobody claims. One of the two always fires — the chat is never left in the
 * silence between two windows.
 */

import * as fs from 'fs/promises';
import type { RemoteRequestStore } from './RemoteRequestStore';

export interface HandoffRollbackContext {
  handoffId: string;
  channel: 'telegram' | 'whatsapp';
  chatId: string;
  /** Display names, for a message that says where the chat actually is. */
  targetName: string;
  currentName: string;
}

export interface HandoffCoordinatorDeps {
  store: RemoteRequestStore;
  /** Watched for writes by other windows; the state file itself. */
  storePath: string;
  workspaceId: string;
  /** Runs a task on the runtime's lifecycle chain. Callbacks below must not
   *  serialize again or they would await the entry they run inside. */
  serialize: (task: () => Promise<void>) => Promise<void>;
  /** Claims whatever is addressed to this workspace, starts transports if it
   *  can take the lease, and sends the arrival receipt. */
  claimArrivals: () => Promise<void>;
  /** Puts this window's transports back after a switch that never happened. */
  restoreTransports: () => Promise<void>;
  sendToChat: (channel: 'telegram' | 'whatsapp', chatId: string, text: string) => Promise<void>;
  notifyLocal: (message: string) => void;
  pollIntervalMs?: number;
  /** How long the target window gets to claim before the source takes the chat
   *  back. Generous: it may be a window still starting up. */
  rollbackDelayMs?: number;
}

export class RemoteHandoffCoordinator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private rollbackTimer: ReturnType<typeof setTimeout> | undefined;
  private lastModifiedMs: number | undefined;
  private checking = false;

  constructor(private readonly deps: HandoffCoordinatorDeps) {}

  /** Idempotent: a config reload restarts transports, not the watch. */
  watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.deps.pollIntervalMs ?? 3_000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.rollbackTimer) clearTimeout(this.rollbackTimer);
    this.rollbackTimer = undefined;
  }

  /**
   * Called once this window has recorded a departure and stopped its
   * transports. If the window is still alive when this fires, `openFolder` did
   * not reload it, and either another window has taken the chat over or the
   * switch simply did not happen.
   */
  armRollback(context: HandoffRollbackContext): void {
    if (this.rollbackTimer) clearTimeout(this.rollbackTimer);
    this.rollbackTimer = setTimeout(
      () => void this.rollback(context),
      this.deps.rollbackDelayMs ?? 20_000,
    );
  }

  /** The same undo, without the wait: the folder could not be opened at all. */
  async rollbackNow(context: HandoffRollbackContext): Promise<void> {
    if (this.rollbackTimer) clearTimeout(this.rollbackTimer);
    this.rollbackTimer = undefined;
    await this.rollback(context);
  }

  private async rollback(context: HandoffRollbackContext): Promise<void> {
    this.rollbackTimer = undefined;
    await this.deps
      .serialize(async () => {
        const outcome = await this.deps.store.failUnclaimedWorkspaceHandoff(context.handoffId);
        // 'claimed' means the target window is already serving this chat and
        // has sent its own arrival receipt. Saying anything here would
        // contradict it.
        if (outcome !== 'failed') return;
        await this.deps.restoreTransports();
        await this.deps.sendToChat(
          context.channel,
          context.chatId,
          `Forge: could not switch to ${context.targetName} — its window never took the chat over. ` +
            `You are still in ${context.currentName}, on the same chat as before.`,
        );
      })
      .catch((err) =>
        this.deps.notifyLocal(
          `Forge remote could not undo the workspace switch: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * Gated on the state file's mtime so the window that is busy writing it does
   * not reparse the document every tick, and so an idle window does no work at
   * all between switches.
   */
  private async poll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const modified = await fs
        .stat(this.deps.storePath)
        .then((stats) => stats.mtimeMs)
        .catch(() => undefined);
      if (modified === undefined || modified === this.lastModifiedMs) return;
      this.lastModifiedMs = modified;
      await this.deps.serialize(async () => {
        await this.deps.store.refresh();
        if (!this.deps.store.hasPendingWorkspaceHandoff(this.deps.workspaceId)) return;
        await this.deps.claimArrivals();
      });
    } catch (err) {
      this.deps.notifyLocal(
        `Forge remote could not claim an arriving chat: ${(err as Error).message}`,
      );
    } finally {
      this.checking = false;
    }
  }
}
