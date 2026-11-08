import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Whether THIS window's managed-server residency changes reach the machine-wide
 * change token (`ExternalTurnHolds.bumpExternalResidencyGeneration`).
 *
 * A window that is about to free GPUs re-reads the managed endpoints' residency
 * outside the machine-wide lock, and trusts that token to tell it whether the map
 * the probe filled is still current (BL-032). That trust only holds while every
 * window publishes what it did: with no publisher wired, or after a publication
 * failed, this window can have made another window's map stale without recording
 * it, and a token that never changed then proves nothing. So the answer is false
 * until a publisher is wired, and stays false after a failed publication — a
 * window that cannot say what changed frees conservatively instead of trusting.
 */
export class ResidencyPublisher {
  private hook: (() => void) | undefined;
  private broken = false;

  /** Supply the publisher. Unwired means nothing can be published. */
  wire(hook: (() => void) | undefined): void {
    this.hook = hook;
  }

  /** Publish one residency change, remembering a failure instead of swallowing it. */
  publish(): void {
    const hook = this.hook;
    if (!hook) {
      this.broken = true;
      return;
    }
    try {
      hook();
    } catch (error) {
      this.broken = true;
      log.error('[ExternalModelServers] could not publish a residency change', error);
    }
  }

  /** True only while every change made here is visible to the other windows. */
  trusted(): boolean {
    return this.hook !== undefined && !this.broken;
  }
}
