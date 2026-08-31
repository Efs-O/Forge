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

  constructor(
    private readonly signature: () => string,
    private readonly onChanged: () => void,
    private readonly intervalMs: number,
  ) {}

  /** Poll only while someone can see the result. */
  sync(visible: boolean): void {
    if (visible) this.start();
    else this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const current = this.signature();
      if (current === this.lastSignature) return;
      this.lastSignature = current;
      this.onChanged();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
