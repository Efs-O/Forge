/**
 * Per-conversation turn state: who is streaming, who is cancelling, and what
 * a cancel has to wait for.
 *
 * Split out of `AgentLoop`, which owns the turn itself. Every map here is keyed
 * by conversation id because tabs run independently — a cancel in one must not
 * block or abort another.
 */

import type { BackendController } from '../backend/BackendController';
import { getLogger } from '../util/logger';

const log = getLogger();

export class TurnLifecycle {
  private readonly streamingConvIds = new Set<string>();
  private readonly activeBackends = new Map<string, BackendController>();
  private readonly cancelControllers = new Map<string, AbortController>();
  private readonly settledMap = new Map<string, Promise<void>>();
  private readonly resolveSettledMap = new Map<string, () => void>();
  /** Turns that received cancellation and must finish unwinding before a new
   * request can acquire a backend. This includes worker delegation holds. */
  private readonly cancellingConvIds = new Set<string>();
  private readonly cancellationSettlements = new Set<Promise<void>>();
  /** convId → why the last turn ended short. Set only when the turn was cut off
   *  rather than finished, so auto-compact can decide whether to resume it. */
  private readonly incompleteTurns = new Map<string, string>();

  get streaming(): boolean {
    return this.streamingConvIds.size > 0;
  }

  isStreaming(convId: string): boolean {
    return this.streamingConvIds.has(convId);
  }

  streamingIds(): ReadonlySet<string> {
    return this.streamingConvIds;
  }

  isCancellationPending(convId: string): boolean {
    return this.cancellingConvIds.has(convId);
  }

  /** Registers the turn's abort controller and the promise a cancel awaits. */
  register(convId: string, ctrl: AbortController): void {
    this.cancelControllers.set(convId, ctrl);
    this.settledMap.set(
      convId,
      new Promise<void>((resolve) => this.resolveSettledMap.set(convId, resolve)),
    );
  }

  markStreaming(convId: string): void {
    this.streamingConvIds.add(convId);
  }

  clearStreaming(convId: string): void {
    this.streamingConvIds.delete(convId);
  }

  setBackend(convId: string, backend: BackendController): void {
    this.activeBackends.set(convId, backend);
  }

  clearBackend(convId: string): void {
    this.activeBackends.delete(convId);
  }

  /** Releases the turn: resolves whatever a cancel is waiting on and drops the
   *  controller, so the next request on this conversation starts clean. */
  settle(convId: string): void {
    this.resolveSettledMap.get(convId)?.();
    this.resolveSettledMap.delete(convId);
    this.settledMap.delete(convId);
    this.cancelControllers.delete(convId);
  }

  /** Marks a conversation busy for background work that is not a turn (the
   *  compaction summary). Without this that work streams while the UI and the
   *  send guards both read as idle. */
  beginBackgroundWork(convId: string): () => void {
    this.streamingConvIds.add(convId);
    return () => this.streamingConvIds.delete(convId);
  }

  /** Why the last turn on this conversation stopped short, if it did. */
  incompleteReason(convId: string): string | undefined {
    return this.incompleteTurns.get(convId);
  }

  markIncomplete(convId: string, reason: string): void {
    this.incompleteTurns.set(convId, reason);
  }

  clearIncomplete(convId: string): void {
    this.incompleteTurns.delete(convId);
  }

  async stopStreaming(convId?: string): Promise<void> {
    if (convId) {
      const ctrl = this.cancelControllers.get(convId);
      if (!ctrl) return;
      ctrl.abort();
      try {
        await this.activeBackends.get(convId)?.stop();
      } catch {
        /* abort is authoritative */
      }
      await this.settledMap.get(convId);
      return;
    }
    for (const [id, ctrl] of this.cancelControllers) {
      ctrl.abort();
      try {
        await this.activeBackends.get(id)?.stop();
      } catch (err) {
        log.debug(`[AgentLoop] backend stop during cancel-all failed: ${(err as Error).message}`);
      }
    }
    await Promise.all([...this.settledMap.values()]);
  }

  cancel(convId?: string): Promise<void> {
    const cancelling = convId
      ? this.cancelControllers.has(convId)
        ? [convId]
        : []
      : [...this.cancelControllers.keys()];
    if (cancelling.length === 0) return Promise.resolve();

    for (const id of cancelling) this.cancellingConvIds.add(id);
    const settled = this.stopStreaming(convId)
      .catch((err) => {
        log.debug(`[AgentLoop] cancellation cleanup failed: ${(err as Error).message}`);
      })
      .finally(() => {
        for (const id of cancelling) this.cancellingConvIds.delete(id);
      });
    this.cancellationSettlements.add(settled);
    void settled.finally(() => this.cancellationSettlements.delete(settled));
    return settled;
  }

  /** Wait for cancelled turns to release their backend/delegation resources.
   * Active, non-cancelled conversations remain independent and do not block. */
  async waitForCancelledTurns(): Promise<void> {
    while (this.cancellationSettlements.size > 0) {
      await Promise.all([...this.cancellationSettlements]);
    }
  }
}
