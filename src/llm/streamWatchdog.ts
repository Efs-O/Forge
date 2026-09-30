import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Idle budget before a stream is abandoned as stalled.
 *
 * Two budgets, because silence means different things either side of the first
 * byte. Before it, a provider that sends headers early (OpenAI, xAI) may be
 * reasoning with nothing to stream for minutes, and a server without
 * early-error handling may still be prefilling a long prompt — neither is a
 * stall. Once bytes flow, a long gap is.
 *
 * Shared because every stream client in `llm/` owes the user the same budget.
 * The Ollama-native route had none: a model that wedged after its headers left
 * the turn hanging with no tokens, no error, and no way out, while the OpenAI
 * route on the same box recovered in 120 s.
 */
export const FIRST_BYTE_STALL_TIMEOUT_MS = 600_000;
export const STREAM_STALL_TIMEOUT_MS = 120_000;

/**
 * The idle watchdog every stream client in `llm/` shares.
 *
 * Call `activity()` on each chunk read and `stop()` in the client's `finally`.
 * On a stall it cancels the body and raises one error through `onStalled`; the
 * client must not settle the stream as well, so `stalled` tells its `catch`
 * block to stay quiet when the cancelled read throws.
 */
export class StreamWatchdog {
  /** True once the watchdog has aborted the stream. */
  stalled = false;
  private lastActivityAt = Date.now();
  private firstByteAt: number | null = null;
  private warned = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly label: string,
    private readonly startedAt: number,
    private readonly summary: () => string,
    cancel: () => void,
    onStalled: (err: Error) => void,
  ) {
    this.timer = setInterval(() => {
      const now = Date.now();
      const idleMs = now - this.lastActivityAt;
      const line = `${this.label} stream heartbeat ${this.summary()} idle_ms=${idleMs}`;
      const stallAfterMs =
        this.firstByteAt === null ? FIRST_BYTE_STALL_TIMEOUT_MS : STREAM_STALL_TIMEOUT_MS;
      if (idleMs >= stallAfterMs) {
        this.stalled = true;
        clearInterval(this.timer);
        log.error(`${line} — aborting stalled stream`);
        cancel();
        onStalled(new Error(`Stream stalled after ${stallAfterMs / 1000}s idle`));
      } else if (idleMs >= 15_000 && !this.warned) {
        this.warned = true;
        log.warn(line);
      } else {
        log.debug(line);
      }
    }, 15_000);
  }

  /** Record bytes arriving: resets the idle clock and the first-byte budget. */
  activity(): void {
    this.lastActivityAt = Date.now();
    this.warned = false;
    this.firstByteAt ??= this.lastActivityAt;
  }

  /** Elapsed ms before the first byte, or null when none ever arrived. */
  get ttfbMs(): number | null {
    return this.firstByteAt === null ? null : this.firstByteAt - this.startedAt;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
