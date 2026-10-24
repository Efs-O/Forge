import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { RemoteLeaseError } from './RemoteTransportLease';

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
const log = getLogger();

export interface RemoteStartRetryDeps {
  /** Runs a task inside the runtime's lifecycle chain. */
  serialize: (task: () => Promise<void>) => Promise<void>;
  /** False once disposed, disabled, superseded by a newer config, or already serving. */
  wanted: (config: ForgeConfig) => boolean;
  start: (config: ForgeConfig) => Promise<void>;
}

/**
 * Retries a failed remote start: 5 s, 15 s, 60 s, then every 60 s. Without it
 * a start that loses a race (a lock its killed predecessor still held) left
 * the chat silent until a manual reload. A lease refusal is not a failure —
 * another window serves the chat — so it never schedules a retry.
 */
export class RemoteStartRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  constructor(private readonly deps: RemoteStartRetryDeps) {}

  failed(config: ForgeConfig, error: unknown): void {
    if (error instanceof RemoteLeaseError || !this.deps.wanted(config) || this.timer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.deps
        .serialize(async () => {
          if (!this.deps.wanted(config)) return;
          try {
            await this.deps.start(config);
          } catch (retryError) {
            log.error(`[remote] start retry failed: ${(retryError as Error).message}`);
            this.failed(config, retryError);
          }
        })
        .catch((err) => log.error('[remote] start retry could not run', err));
    }, delay);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.attempt = 0;
  }
}
