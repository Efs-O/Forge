import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Idle budgets before a stream is considered stalled.
 *
 * Two budgets, because silence means different things either side of the first
 * byte. Before it, a provider that sends headers early (OpenAI, xAI) may be
 * reasoning with nothing to stream for minutes, and a server without
 * early-error handling may still be prefilling a long prompt. Once bytes flow,
 * a long gap is more suspicious.
 *
 * Shared because every stream client in `llm/` owes the user the same budget.
 * The Ollama-native route had none: a model that wedged after its headers left
 * the turn hanging with no tokens, no error, and no way out, while the OpenAI
 * route on the same box recovered in 120 s. A local OpenAI-compatible server
 * gets a generation probe at the threshold; the 15-minute ceiling bounds a
 * server that keeps claiming it is busy.
 */
export const FIRST_BYTE_STALL_TIMEOUT_MS = 600_000;
export const STREAM_STALL_TIMEOUT_MS = 120_000;
export const STREAM_STALL_CEILING_MS = 900_000;
const WATCHDOG_INTERVAL_MS = 15_000;

export type StallDeltaKind = 'reasoning' | 'content' | 'tool_args' | 'none';
export type StallProbeAnswer =
  | 'alive'
  | 'not-alive'
  | `error: ${string}`
  | 'skipped: not loopback'
  | 'skipped: no probe';

export interface StreamStallDetails {
  last_delta_kind: StallDeltaKind;
  last_delta_ms: number | null;
  idle_ms: number;
  probe: StallProbeAnswer;
}

/** Stable structured details survive existing error-to-string turn paths. */
export class StreamStallError extends Error {
  constructor(readonly stall: StreamStallDetails) {
    super(
      `Stream stalled after ${Math.round(stall.idle_ms / 1000)}s idle ` +
        `[forge_stall=${JSON.stringify(stall)}]`,
    );
    this.name = 'StreamStallError';
  }
}

export type StallProbe = (signal: AbortSignal) => Promise<StallProbeAnswer>;

/**
 * The provider-agnostic idle watchdog shared by stream clients in `llm/`.
 *
 * Call `activity()` on every chunk and `stop()` in the client's `finally`.
 * At an idle threshold, an optional async probe can keep a local stream open
 * while the server is generating. On a stall it cancels the body and raises
 * one error through `onStalled`; the client must not settle the stream again,
 * so `stalled` tells its catch block to ignore the cancelled read's error.
 * A probe resolving after `stop()` cannot settle or cancel the stream.
 */
export class StreamWatchdog {
  /** True once the watchdog has aborted the stream; clients suppress the cancelled read's error. */
  stalled = false;
  private lastActivityAt = Date.now();
  private activityVersion = 0;
  private firstByteAt: number | null = null;
  private lastDeltaKind: StallDeltaKind = 'none';
  private lastDeltaAt: number | null = null;
  private warned = false;
  private stopped = false;
  private probeInFlight = false;
  private readonly probeController = new AbortController();
  private lastProbeAnswer: StallProbeAnswer = 'skipped: no probe';
  private nextProbeAt: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly label: string,
    private readonly startedAt: number,
    private readonly summary: () => string,
    private readonly cancel: () => void,
    private readonly onStalled: (err: Error) => void,
    private readonly probe?: StallProbe,
    private readonly now: () => number = Date.now,
  ) {
    this.nextProbeAt = STREAM_STALL_TIMEOUT_MS;
    this.timer = setInterval(() => void this.check(), WATCHDOG_INTERVAL_MS);
  }

  /** Record bytes arriving, resetting the idle clock, first-byte budget, and probe schedule. */
  activity(): void {
    this.activityVersion += 1;
    this.lastActivityAt = this.now();
    this.warned = false;
    this.firstByteAt ??= this.lastActivityAt;
    this.nextProbeAt = STREAM_STALL_TIMEOUT_MS;
  }

  delta(kind: Exclude<StallDeltaKind, 'none'>): void {
    this.lastDeltaKind = kind;
    this.lastDeltaAt = this.now() - this.startedAt;
  }

  /** Elapsed ms before the first byte, or null when none ever arrived. */
  get ttfbMs(): number | null {
    return this.firstByteAt === null ? null : this.firstByteAt - this.startedAt;
  }

  /** Stop heartbeats and ignore any probe that resolves after the stream settles. */
  stop(): void {
    this.stopped = true;
    this.probeController.abort();
    clearInterval(this.timer);
  }

  private async check(): Promise<void> {
    if (this.stopped || this.stalled) return;
    const now = this.now();
    const idleMs = now - this.lastActivityAt;
    const stallAfterMs =
      this.firstByteAt === null ? FIRST_BYTE_STALL_TIMEOUT_MS : STREAM_STALL_TIMEOUT_MS;
    const line = `${this.label} stream heartbeat ${this.summary()} idle_ms=${idleMs}`;
    if (idleMs >= STREAM_STALL_CEILING_MS) {
      this.end(idleMs, this.lastProbeAnswer, 'reached 15-minute silence ceiling');
      return;
    }
    if (idleMs >= stallAfterMs && this.probe && idleMs >= this.nextProbeAt && !this.probeInFlight) {
      this.probeInFlight = true;
      const activityVersionAtProbeStart = this.activityVersion;
      let answer: StallProbeAnswer;
      try {
        answer = await this.probe(this.probeController.signal);
      } catch (error) {
        answer = `error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        this.probeInFlight = false;
      }
      // stop() owns the reader now. A late probe must not cancel or settle it.
      if (this.stopped || this.stalled || this.activityVersion !== activityVersionAtProbeStart)
        return;
      this.lastProbeAnswer = answer;
      const afterProbeIdle = this.now() - this.lastActivityAt;
      if (answer !== 'alive') {
        this.end(afterProbeIdle, answer);
        return;
      }
      if (afterProbeIdle >= STREAM_STALL_CEILING_MS) {
        this.end(afterProbeIdle, answer, 'reached 15-minute silence ceiling');
        return;
      }
      this.nextProbeAt = afterProbeIdle + STREAM_STALL_TIMEOUT_MS;
      log.warn(
        `${line} — server still generating; waiting for another ${STREAM_STALL_TIMEOUT_MS / 1000}s`,
      );
      return;
    }
    if (idleMs >= stallAfterMs && !this.probe) {
      this.end(idleMs, 'skipped: no probe');
    } else if (idleMs >= 15_000 && !this.warned) {
      this.warned = true;
      log.warn(line);
    } else {
      log.debug(line);
    }
  }

  private end(idleMs: number, probe: StallProbeAnswer, reason?: string): void {
    if (this.stopped || this.stalled) return;
    this.stalled = true;
    clearInterval(this.timer);
    log.error(
      `${this.label} ${this.summary()} — aborting stalled stream${reason ? ` (${reason})` : ''}`,
    );
    this.cancel();
    this.onStalled(
      new StreamStallError({
        last_delta_kind: this.lastDeltaKind,
        last_delta_ms: this.lastDeltaAt,
        idle_ms: idleMs,
        probe,
      }),
    );
  }
}
