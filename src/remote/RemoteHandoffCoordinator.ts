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

/**
 * How long a `new-window` target gets before the window that asked for it is
 * allowed to undo the switch. `replace` keeps the 20 s it has always had,
 * because the window that asked is reloading and its claim runs on activation;
 * a new window may not exist yet, so a 20 s timer used to fire while the target
 * was still starting and the source took the chat back out from under it.
 *
 * 90 s is the floor, not a guess: the worst open→activation measured
 * 2026-10-29 was 73 s on a project this machine had not opened recently
 * (`docs/reports/WORKSPACE_SWITCH_PHASE0_TIMINGS.md`), and activation happens
 * **before** the remote store loads, the lease is taken and the handoff is
 * claimed. The same run produced `TAKEOVER_CLAIM_DEADLINE_MS`, which is derived
 * from the same numbers; phase 2's live two-window run measures open→claim end
 * to end and finalises both.
 */
export const NEW_WINDOW_ROLLBACK_MS = 90_000;

export interface HandoffRollbackContext {
  handoffId: string;
  channel: 'telegram' | 'whatsapp';
  chatId: string;
  /** Display names, for a message that says where the chat actually is. */
  targetName: string;
  currentName: string;
  /** `new-window` leaves this window open, so the undo has to say that the
   *  phone is back here and nothing was closed. Absent means `replace`. */
  mode?: 'replace' | 'new-window';
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
  /**
   * Takes the transport lease and brings this window's transports up, which is
   * the whole of undoing a switch that never happened: the lease is what makes
   * it safe to say "you are still here", and `false` means another window is
   * holding it and serving the chat — so that window decides, and a rollback
   * that grabbed a live window's lease would cut off a chat being served.
   */
  takeTransports: () => Promise<boolean>;
  /** Gives back a lease this rollback grabbed but will not use, so the window
   *  that actually claimed the chat can have the transports. */
  releaseTransports: () => Promise<void>;
  sendToChat: (channel: 'telegram' | 'whatsapp', chatId: string, text: string) => Promise<void>;
  notifyLocal: (message: string) => void;
  pollIntervalMs?: number;
  /** How long the target window gets to claim before the source takes the chat
   *  back. Generous: it may be a window still starting up. Present in tests to
   *  drive a rollback without waiting the real time; in production it is absent
   *  and the mode decides (`NEW_WINDOW_ROLLBACK_MS` or the 20 s `replace` has
   *  always had). */
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
   *
   * The wait is per mode — see {@link NEW_WINDOW_ROLLBACK_MS}. A
   * `rollbackDelayMs` from `handoffWatch` overrides both, which is how the
   * tests drive a rollback without waiting 90 s for it.
   */
  armRollback(context: HandoffRollbackContext): void {
    if (this.rollbackTimer) clearTimeout(this.rollbackTimer);
    this.rollbackTimer = setTimeout(
      () => void this.rollback(context),
      this.deps.rollbackDelayMs ??
        (context.mode === 'new-window' ? NEW_WINDOW_ROLLBACK_MS : 20_000),
    );
  }

  /** True while a rollback is armed: this window recorded a departure, stopped
   *  its transports and released the lease, and is waiting for the window it
   *  asked to be opened to take the chat. `RemoteWindowWatch` reads it so a
   *  window that ran a `new-window` switch does not take the phone back one tick
   *  after making it, which would leave a still-starting target with no lease to
   *  take and turn a switch that would have worked into a reported failure.
   *  Cleared by the rollback firing, by `rollbackNow`, and by `dispose()`, so the
   *  gate can never outlive the switch it belongs to. */
  isRollbackArmed(): boolean {
    return this.rollbackTimer !== undefined;
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
        // Lease first, before anything is taken back: a window that is serving
        // this chat right now holds the lease, and stealing it would cut off a
        // chat that is answering. Failing to get it therefore leaves the record
        // alone and sends nothing — whoever holds the lease decides.
        if (!(await this.deps.takeTransports())) return;
        const outcome = await this.deps.store.failUnclaimedWorkspaceHandoff(context.handoffId);
        // 'claimed' or 'completed' means the target window has this chat and has
        // sent (or will send) its own arrival receipt; 'gone' means its record is
        // already pruned. Saying anything here would contradict that, so give
        // the lease back — the window that took the chat over needs it — and
        // send nothing.
        if (outcome !== 'failed') {
          await this.deps.releaseTransports();
          return;
        }
        // The transports are up and the lease is ours, so this window is serving
        // the phone again and can say so on the channel it just restarted.
        await this.deps.sendToChat(context.channel, context.chatId, rollbackMessage(context));
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

/**
 * What the window that started the switch says when it takes the chat back.
 * `replace` keeps the wording it has always had: that window reloads, so there
 * is no other window to mention. `new-window` has to say this window is still
 * open and answering, because the owner was promised a second window and needs
 * to know which of the two is serving the phone.
 */
function rollbackMessage(context: HandoffRollbackContext): string {
  const head =
    `Forge: could not switch to ${context.targetName} — ` + 'its window never took the chat over. ';
  return context.mode === 'new-window'
    ? `${head}You are still in ${context.currentName}, which is still open and answering; ` +
        `the ${context.targetName} window is open too, but it is not serving this chat.`
    : `${head}You are still in ${context.currentName}, on the same chat as before.`;
}
