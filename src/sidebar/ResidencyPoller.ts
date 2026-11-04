import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Polls backend model residency and reports it only when it actually changes.
 *
 * Owns the one timer behind the sidebar's model list. Extracted from
 * SidebarProvider because it is a closed concern -- a timer, a last-seen
 * signature, and a visibility rule -- that shares no state with the rest of the
 * view.
 */
export class ResidencyPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSignature = '';
  private lastRefreshAt = 0;
  private refreshInFlight = false;

  constructor(
    private readonly signature: () => string,
    private readonly onChanged: () => void,
    private readonly intervalMs: number,
    private readonly refresh?: () => Promise<void>,
    private readonly refreshEveryMs = 10_000,
  ) {}

  /** Poll only while someone can see the result. */
  sync(visible: boolean): void {
    if (visible) this.start();
    else this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.lastRefreshAt = Date.now();
    this.timer = setInterval(() => {
      if (!this.timer) return;
      const current = this.signature();
      if (current !== this.lastSignature) {
        this.lastSignature = current;
        this.onChanged();
      }
      this.maybeRefresh();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastRefreshAt = Date.now();
  }

  private maybeRefresh(): void {
    const refresh = this.refresh;
    if (!refresh || this.refreshInFlight) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < this.refreshEveryMs) return;
    this.lastRefreshAt = now;
    this.refreshInFlight = true;
    void Promise.resolve()
      .then(() => refresh())
      .catch((error: unknown) => log.error('[ResidencyPoller] refresh failed', error))
      .finally(() => {
        this.refreshInFlight = false;
      });
  }
}
