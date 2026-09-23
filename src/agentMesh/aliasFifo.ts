import type { ExchangeState } from './deliveryState';
import type { MeshAdapter, TurnResult } from './meshAdapter';

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
  /** Stops the turn when this message is the one running (`ask`). */
  signal?: AbortSignal;
  /**
   * Called exactly once with how this message ended — the turn's result, or a
   * `failed`/`cancelled` one when it never ran. This is how `ask` waits its
   * turn in the FIFO instead of sending past it (M5).
   */
  onResult?: (result: TurnResult) => void;
}

export interface FifoEvent {
  exchangeId: string;
  state: ExchangeState;
  detail?: string;
}

export interface AliasFifoDeps {
  /**
   * Report a board event (the orchestrator writes it to the exchange log).
   * F-03: the `accepted` event is awaited, so it is durable before the caller
   * is told the message was accepted — a crash after the return cannot lose it.
   */
  onEvent: (e: FifoEvent) => Promise<void> | void;
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
  async enqueue(msg: FifoMessage): Promise<EnqueueResult> {
    if (this.disposed) return { accepted: false, queueLength: 0 };
    if (this.queue.length >= this.bound) {
      await this.deps.onEvent({
        exchangeId: msg.exchangeId,
        state: 'rejected',
        detail: `queue full (${this.bound}); message not sent`,
      });
      return { accepted: false, queueLength: this.queue.length };
    }
    this.queue.push(msg);
    // F-03: the durable `accepted` — awaited so it is on disk before the
    // caller is told the message was accepted.
    try {
      await this.deps.onEvent({ exchangeId: msg.exchangeId, state: 'accepted' });
    } catch (err) {
      const index = this.queue.indexOf(msg);
      if (index >= 0) this.queue.splice(index, 1);
      throw err;
    }
    void this.drain();
    return { accepted: true };
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Which session this FIFO delivers to (the adapter's key). */
  get adapterKey(): string | undefined {
    return this.adapter.key;
  }

  /**
   * F-03: whether this queue's adapter observes turns. A non-observing one
   * stays `accepted` until a verdict appears, so the sender binds the exchange
   * id into the message. Asked of the adapter itself, not of ownership: a
   * Claude stand-in observes its turns without being an owned session.
   */
  get observesTurns(): boolean {
    return this.adapter.observesTurns;
  }

  /** Nothing queued and no turn running: safe to replace (a new session key). */
  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  /** True while a turn is running (a message shifted off and in flight). */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Take a still-queued message back (its caller stopped waiting). True when
   * it was queued; false once it has started, where its signal stops it.
   */
  withdraw(exchangeId: string): boolean {
    const index = this.queue.findIndex((m) => m.exchangeId === exchangeId);
    if (index < 0) return false;
    const [msg] = this.queue.splice(index, 1);
    void Promise.resolve(
      this.deps.onEvent({ exchangeId, state: 'rejected', detail: 'the asker stopped waiting' }),
    ).catch(() => undefined);
    msg?.onResult?.({ status: 'cancelled' });
    return true;
  }

  /** A read-only snapshot for the Telegram queue view (F-09). */
  get pendingMessages(): readonly FifoMessage[] {
    return this.queue.map((message) => ({ ...message }));
  }

  /**
   * F-06: a steer. Interrupts the active turn (so the current `send()` resolves
   * as `cancelled` and the drain loop advances), then queues the steer message
   * — which runs next, before any ordinary queued message. A steer to a
   * non-observing adapter has no turn to interrupt, so it is just enqueued.
   */
  async steer(msg: FifoMessage): Promise<EnqueueResult> {
    if (this.disposed) return { accepted: false, queueLength: 0 };
    if (this.queue.length >= this.bound) {
      await this.deps.onEvent({
        exchangeId: msg.exchangeId,
        state: 'rejected',
        detail: `queue full (${this.bound}); steer not sent`,
      });
      return { accepted: false, queueLength: this.queue.length };
    }
    // A steer is admitted at the front of the waiting queue. Interrupt only
    // after its accepted event is durable; a rejected steer must not cancel
    // useful work without delivering its replacement.
    this.queue.unshift(msg);
    try {
      await this.deps.onEvent({ exchangeId: msg.exchangeId, state: 'accepted' });
    } catch (err) {
      const index = this.queue.indexOf(msg);
      if (index >= 0) this.queue.splice(index, 1);
      throw err;
    }
    this.adapter.interrupt?.();
    void this.drain();
    return { accepted: true };
  }

  dispose(): void {
    this.disposed = true;
    // The queue is in memory (M5): on window shutdown, queued-but-unsent
    // messages are lost with the window. Write a terminal `timeout` for each so
    // the board never shows them as in-flight forever (the plan's "recovery
    // writes a timeout for each accepted-but-not-started exchange"). The
    // in-flight message is covered by its own completion/cancellation.
    const pending = this.queue.splice(0);
    for (const msg of pending) {
      this.deps.onEvent({
        exchangeId: msg.exchangeId,
        state: 'timeout',
        detail: 'window shutting down; queued message not sent',
      });
      msg.onResult?.({ status: 'failed', finalText: 'window shutting down; message not sent' });
    }
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const msg = this.queue.shift() as FifoMessage;
        try {
          await this.runOne(msg);
        } catch {
          // A board-event write failed (onEvent is durable and rethrows). The
          // message was already shifted off the queue, so without this the
          // error would break the loop and wedge the FIFO — every later
          // message would never drain. Swallow it and keep draining: the
          // exchange's durable state is incomplete, but the queue must not
          // jam on one bad write.
        }
      }
      if (!this.disposed) this.adapter.onIdle?.();
    } finally {
      this.running = false;
    }
  }

  private async runOne(msg: FifoMessage): Promise<void> {
    // Observing adapters: the turn begins now, so `started` is truthful here.
    // Non-observing: no `started` — the transport only accepts it.
    //
    // These are board PROJECTIONS, not the durable ack (that was written in
    // `enqueue`/`steer`). A failed projection write must not prevent the
    // message from being delivered or wedge the queue, so each is best-effort:
    // `onEvent` rethrows on a failed durable write, and we swallow it here.
    let started = false;
    if (this.adapter.observesTurns) {
      try {
        await this.deps.onEvent({ exchangeId: msg.exchangeId, state: 'started' });
        started = true;
      } catch {
        started = true; // the turn starts regardless; the board just won't show it
      }
    }
    try {
      const result = await this.adapter.send(msg.message, msg.signal ? { signal: msg.signal } : {});
      msg.onResult?.(result);
      if (this.adapter.observesTurns) {
        try {
          await this.deps.onEvent({
            exchangeId: msg.exchangeId,
            state: result.status === 'completed' ? 'completed' : 'cancelled',
            ...(result.status !== 'completed' && result.finalText
              ? { detail: result.finalText }
              : {}),
          });
        } catch {
          // board projection: best-effort
        }
      }
      // Non-observing: the exchange stays `accepted`; a later verdict (or the
      // non-terminal deadline) moves it. Nothing to write here.
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      msg.onResult?.({ status: 'failed', finalText: why });
      // A turn that already started cannot become `rejected` (that state means
      // "never accepted"); it ends `cancelled`. A turn that never started (a
      // non-observing send that threw, or an observing send that threw before
      // the turn began) is `rejected`.
      try {
        await this.deps.onEvent({
          exchangeId: msg.exchangeId,
          state: started ? 'cancelled' : 'rejected',
          detail: why,
        });
      } catch {
        // board projection: best-effort
      }
    }
  }
}
