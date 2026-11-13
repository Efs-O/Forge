import type { ToolCall } from './types';
import { argumentsAreIncomplete } from './ToolCallTruncatedError';

/** Partial delta shape for a streamed tool call. index is stream-only. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/** One tool call as it accumulates across streamed deltas. */
export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
  argDeltas: number;
  lastProgressAt?: number;
}

/** A progress report for one call, sent at most once per 250 ms. */
export interface ToolCallProgressReport {
  index: number;
  id: string;
  name: string;
  argChars: number;
  argDeltas: number;
  arguments: string;
}

/**
 * Accumulates streamed `tool_call` fragments by index and settles them once.
 *
 * Every rule here was learned from a real backend. The name arrives whole in the
 * delta that opens a call, so appending every name delta turned it into
 * `search_codesearch_code` — an unknown tool and a wasted round every single
 * time (measured on gemma4:31b-cloud); genuine fragmentation still concatenates.
 * Progress is reported at most twice a second per call, and a call whose
 * arguments began streaming and never parsed is a truncation, not a call.
 */
export class StreamedToolCallAccumulator {
  private readonly calls = new Map<number, AccumulatedToolCall>();
  private flushed = false;
  private deltaCount = 0;

  constructor(
    private readonly onProgress?: (report: ToolCallProgressReport) => void,
    private readonly onCalls?: (calls: ToolCall[]) => void,
  ) {}

  /** True when any delta in this frame carries argument text — the watchdog's cue. */
  static carriesArguments(deltas: readonly ToolCallDelta[]): boolean {
    return deltas.some(
      (call) => typeof call.function?.arguments === 'string' && call.function.arguments.length > 0,
    );
  }

  get size(): number {
    return this.calls.size;
  }

  /** How many tool-call deltas have been folded in, for the request log. */
  get deltas(): number {
    return this.deltaCount;
  }

  apply(deltas: readonly ToolCallDelta[]): void {
    for (const tc of deltas) {
      this.deltaCount += 1;
      const idx = tc.index ?? 0;
      if (!this.calls.has(idx)) {
        this.calls.set(idx, { id: '', name: '', arguments: '', argDeltas: 0 });
      }
      const acc = this.calls.get(idx)!;
      if (tc.id) acc.id = tc.id;
      const incomingName = tc.function?.name;
      if (incomingName && !acc.name.includes(incomingName)) acc.name += incomingName;
      if (tc.function?.arguments) {
        acc.arguments += tc.function.arguments;
        acc.argDeltas += 1;
        this.reportProgress(idx, false);
      }
    }
  }

  /**
   * The first call that cannot have arrived whole, or undefined.
   *
   * `strict` means generation stopped at the output ceiling: there, a call that
   * opened and never began its arguments counts as cut too. Anywhere else a tool
   * that takes no arguments is a legitimate call, so only a call that started
   * streaming JSON can be partial.
   */
  incompleteCall(strict: boolean): AccumulatedToolCall | undefined {
    return [...this.calls.values()].find(
      (acc) => argumentsAreIncomplete(acc.arguments) && (strict || acc.argDeltas > 0),
    );
  }

  /** Hand the calls over, once. A second call is a no-op, so a duplicate
   *  terminal frame can never dispatch the same call twice. */
  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    for (const index of this.calls.keys()) this.reportProgress(index, true);
    if (!this.onCalls || this.calls.size === 0) return;
    const calls: ToolCall[] = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({
        id: acc.id,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.arguments },
      }));
    this.onCalls(calls);
  }

  private reportProgress(index: number, final: boolean): void {
    const acc = this.calls.get(index);
    if (!acc || !this.onProgress || acc.argDeltas === 0) return;
    const now = Date.now();
    if (!final && acc.lastProgressAt !== undefined && now - acc.lastProgressAt < 250) return;
    acc.lastProgressAt = now;
    this.onProgress({
      index,
      id: acc.id,
      name: acc.name,
      argChars: acc.arguments.length,
      argDeltas: acc.argDeltas,
      arguments: acc.arguments,
    });
  }
}
