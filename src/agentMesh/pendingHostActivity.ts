import type { MeshUserNotification } from './meshNotificationPolicy';

/**
 * A11 (COPILOT_AGENT_MESH_PLAN P3) — a bounded, in-memory buffer for terminal
 * mesh notifications when the host-activity facade is not ready.
 *
 * The durable board append is authoritative and must never be made to fail by
 * notification readiness. The sidebar facade can be unavailable when startup
 * recovery emits a `crashed` event (activation/control-server setup can precede
 * sidebar availability — see `setupAgentMessaging`), so a not-ready facade
 * buffers the notification here and retries until the facade is up — exactly
 * once, in order — or the mesh is disposed.
 *
 * This is NOT a second transport or persistence owner: it holds nothing on
 * disk and emits only through the single host-activity path the wiring already
 * owns. When the facade is ready it emits synchronously (no deferral); only an
 * unavailable facade defers, and the retry timer is unref'd so it never holds
 * the process open.
 */
export interface HostActivityFacade {
  emitHostActivity?(n: MeshUserNotification): void;
}

export class PendingHostActivity {
  private readonly queue: MeshUserNotification[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private disposed = false;

  constructor(
    private readonly getFacade: () => HostActivityFacade | undefined,
    private readonly maxPending = 64,
  ) {}

  /**
   * Buffer a terminal notification and try to flush it now. Never throws: a
   * not-ready facade (or a throwing emit) defers the item instead of rejecting
   * the caller, so a crash-recovery `onEvent` can never be aborted by the
   * notification path.
   */
  enqueue(n: MeshUserNotification): void {
    if (this.disposed) return;
    this.queue.push(n);
    // Safety bound: if the facade never becomes ready, do not grow without
    // bound. Drop the oldest so the most recent terminal state is retained.
    while (this.queue.length > this.maxPending) this.queue.shift();
    this.drain();
  }

  /**
   * Emit as many buffered items as the facade will accept, in order. Synchronous
   * when the facade is ready (no deferral); otherwise schedules a bounded retry
   * and returns. A throwing emit is retained (put back at the head) and retried
   * — never dropped, never duplicated.
   */
  private drain(): void {
    if (this.disposed) return;
    let facade: HostActivityFacade | undefined;
    try {
      facade = this.getFacade();
    } catch {
      this.scheduleRetry();
      return;
    }
    const emit = facade?.emitHostActivity;
    if (typeof emit !== 'function') {
      this.scheduleRetry();
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      try {
        emit.call(facade, next);
      } catch {
        // A thrown emit must not drop the item or abort recovery: put it back
        // at the head and retry (no duplicate — it was only shifted out now).
        this.queue.unshift(next);
        this.scheduleRetry();
        return;
      }
    }
    this.retries = 0; // fully drained; reset the backoff
  }

  private scheduleRetry(): void {
    if (this.disposed || this.timer) return;
    const delay = Math.min(250 * 2 ** this.retries, 2000);
    this.retries += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, delay);
    this.timer.unref?.();
  }

  /** Clear the buffer and stop the retry mechanism (extension deactivate). */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue.length = 0;
  }
}
