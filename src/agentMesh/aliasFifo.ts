import type { ExchangeState } from './deliveryState';
import type { MeshAdapter } from './meshAdapter';

/**
 * The per-alias host-side FIFO (AGENT_MESH_PLAN M5).
 *
 * `CodexAppServerSession.send()` **throws** when a turn is already active and
 * resolves only at **turn end**. So a message must never be `send()`-ed while a
 * turn is running, and the caller must never await `send()` directly. The FIFO
 * is the single owner: a message queues as `accepted`, then goes out as
 * `started` (observing adapters) when the turn begins, and `completed`/`failed`
 * when it ends. One active turn per alias, always.
 *
 * The FIFO is in memory, owned by the window that owns the session (M2). If
 * that window dies, queued-but-unsent messages are lost with it; recovery
 * writes a `timeout` event for each `accepted`-but-not-`started` exchange of a
 * dead owner host (the orchestrator's job, not the FIFO's). The FIFO itself
 * never replays a message — a silent duplicate is worse than a reported loss.
 *
 * Board events are reported through `onEvent`, which the orchestrator wires to
 * the exchange log. The FIFO does not touch the filesystem.
 */

export interface FifoMessage {
  exchangeId: string;
  message: string;
}

export interface FifoEvent {
  exchangeId: string;
  state: ExchangeState;
  detail?: string;
}

export interface AliasFifoDeps {
  /** Report a board event (the orchestrator writes it to the exchange log). */
  onEvent: (e: FifoEvent) => void;
  /** The queue bound. Overflow is `rejected` and reported, never dropped. */
  bound?: number;
}

export interface EnqueueResult {
  accepted: boolean;
  /** When rejected: the queue length that caused the overflow. */
  queueLength?: number;
}

export class AliasFifo {
  private readonly queue: FifoMessage[] = [];
  private running = false;
  private disposed = false;
  private readonly bound: number;

  constructor(
    private readonly adapter: MeshAdapter,
    private readonly deps: AliasFifoDeps,
  ) {
    this.bound = deps.bound ?? 20;
  }

  /** Queue a message. Returns whether it was accepted (false on overflow). */
  enqueue(msg: FifoMessage): EnqueueResult {
    if (this.disposed) return { accepted: false, queueLength: 0 };
    if (this.queue.length >= this.bound) {
      this.deps.onEvent({
        exchangeId: msg.exchangeId,
        state: 'rejected',
        detail: `queue full (${this.bound}); message not sent`,
      });
      return { accepted: false, queueLength: this.queue.length };
    }
    this.queue.push(msg);
    this.deps.onEvent({ exchangeId: msg.exchangeId, state: 'accepted' });
    void this.drain();
    return { accepted: true };
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const msg = this.queue.shift() as FifoMessage;
        await this.runOne(msg);
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(msg: FifoMessage): Promise<void> {
    // Observing adapters: the turn begins now, so `started` is truthful here.
    // Non-observing: no `started` — the transport only accepts it.
    if (this.adapter.observesTurns) {
      this.deps.onEvent({ exchangeId: msg.exchangeId, state: 'started' });
    }
    try {
      const result = await this.adapter.send(msg.message);
      if (this.adapter.observesTurns) {
        this.deps.onEvent({
          exchangeId: msg.exchangeId,
          state: result.status === 'completed' ? 'completed' : 'cancelled',
          ...(result.status !== 'completed' && result.finalText
            ? { detail: result.finalText }
            : {}),
        });
      }
      // Non-observing: the exchange stays `accepted`; a later verdict (or the
      // non-terminal deadline) moves it. Nothing to write here.
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.onEvent({
        exchangeId: msg.exchangeId,
        state: 'rejected',
        detail: why,
      });
    }
  }
}
