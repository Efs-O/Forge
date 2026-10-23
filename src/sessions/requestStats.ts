import { performance } from 'perf_hooks';
import { readCachedPromptTokens } from '../llm/promptCacheStats';

export type RequestOutcome = 'ok' | 'error' | 'aborted' | 'truncated';

export interface RequestClientMetrics {
  ttfb_ms?: number;
  first_token_ms?: number;
  total_ms: number;
  chunks: number;
}

export interface OllamaDurationsNs {
  load_duration?: unknown;
  prompt_eval_duration?: unknown;
  eval_duration?: unknown;
  total_duration?: unknown;
}

/** What one HTTP client knows when an agent-loop request has settled. */
export interface RequestStatsInput {
  outcome: RequestOutcome;
  finishReason?: string | null;
  usage?: unknown;
  timings?: unknown;
  ollamaDurations?: OllamaDurationsNs;
  client: RequestClientMetrics;
}

export interface RequestStatsRow {
  type: 'request_stats';
  outcome: RequestOutcome;
  finish_reason?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  server?: {
    prompt_n?: number;
    prompt_ms?: number;
    cache_n?: number;
    predicted_n?: number;
    predicted_ms?: number;
    draft_n?: number;
    draft_n_accepted?: number;
  };
  ollama?: {
    load_ms?: number;
    prompt_eval_ms?: number;
    eval_ms?: number;
    total_ms?: number;
  };
  client: RequestClientMetrics;
  timestamp_ms: number;
  model: string;
}

/** The body and endpoint exactly as sent, plus the finished numbers-only row. */
export interface RequestCapture {
  body: string;
  url: string;
  model: string;
  sentAtMs: number;
  stats: RequestStatsInput;
}

export type RequestStatsHandler = (capture: RequestCapture) => void;

export interface RequestStatsReporter {
  complete(finishReason: string | null): void;
  fail(error: Error): void;
  setUsage(usage: unknown): void;
  setTimings(timings: unknown): void;
  setOllamaDurations(durations: OllamaDurationsNs): void;
}

export interface RequestClientClock {
  firstByte(): void;
  firstToken(): void;
  chunk(): void;
  finish(): RequestClientMetrics;
}

/** Monotonic client timings, measured only around the HTTP stream. */
export function createRequestClientClock(
  now: () => number = () => performance.now(),
): RequestClientClock {
  const started = now();
  let firstByteAt: number | undefined;
  let firstTokenAt: number | undefined;
  let chunks = 0;
  const elapsed = (at: number): number => Math.max(0, at - started);
  return {
    firstByte: () => {
      firstByteAt ??= elapsed(now());
    },
    firstToken: () => {
      firstTokenAt ??= elapsed(now());
    },
    chunk: () => {
      chunks += 1;
    },
    finish: () => {
      const total = elapsed(now());
      return {
        ...(firstByteAt !== undefined ? { ttfb_ms: firstByteAt } : {}),
        ...(firstTokenAt !== undefined ? { first_token_ms: Math.min(firstTokenAt, total) } : {}),
        total_ms: total,
        chunks,
      };
    },
  };
}

const SERVER_TIMING_KEYS = [
  'prompt_n',
  'prompt_ms',
  'cache_n',
  'predicted_n',
  'predicted_ms',
  'draft_n',
  'draft_n_accepted',
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readServerTimings(value: unknown): RequestStatsRow['server'] | undefined {
  const source = record(value);
  if (!source) return undefined;
  const timings: NonNullable<RequestStatsRow['server']> = {};
  for (const key of SERVER_TIMING_KEYS) {
    const field = finiteNumber(source, key);
    if (field !== undefined) timings[key] = field;
  }
  return timings;
}

function nsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round((value / 1_000_000) * 10) / 10;
}

function readOllamaDurations(
  value: OllamaDurationsNs | undefined,
): RequestStatsRow['ollama'] | undefined {
  const source = record(value);
  if (!source) return undefined;
  const durations: NonNullable<RequestStatsRow['ollama']> = {};
  const fields = [
    ['load_duration', 'load_ms'],
    ['prompt_eval_duration', 'prompt_eval_ms'],
    ['eval_duration', 'eval_ms'],
    ['total_duration', 'total_ms'],
  ] as const;
  for (const [from, to] of fields) {
    const milliseconds = nsToMs(source[from]);
    if (milliseconds !== undefined) durations[to] = milliseconds;
  }
  return durations;
}

/** Build the safe session-log row; never copy provider text or unknown keys. */
export function requestStatsRow(
  input: RequestStatsInput,
  model: string,
  timestampMs: number,
): RequestStatsRow {
  const usage = record(input.usage);
  const row: RequestStatsRow = {
    type: 'request_stats',
    outcome: input.outcome,
    client: input.client,
    timestamp_ms: timestampMs,
    model,
  };
  if (input.finishReason) row.finish_reason = input.finishReason;
  const prompt = finiteNumber(usage, 'prompt_tokens');
  if (prompt !== undefined) row.prompt_tokens = prompt;
  const completion = finiteNumber(usage, 'completion_tokens');
  if (completion !== undefined) row.completion_tokens = completion;
  const cached = readCachedPromptTokens(input.usage);
  if (cached !== undefined) row.cached_tokens = cached;
  const server = readServerTimings(input.timings);
  if (server !== undefined) row.server = server;
  const ollama = readOllamaDurations(input.ollamaDurations);
  if (ollama !== undefined) row.ollama = ollama;
  return row;
}

export function requestOutcome(
  finishReason: string | null | undefined,
  error?: unknown,
  aborted = false,
): RequestOutcome {
  if (
    aborted ||
    finishReason === 'cancelled' ||
    (error instanceof Error && error.name === 'AbortError')
  )
    return 'aborted';
  if (
    finishReason === 'length' ||
    (error instanceof Error && error.name === 'ToolCallTruncatedError')
  ) {
    return 'truncated';
  }
  return error === undefined ? 'ok' : 'error';
}

/** Drop query strings and origins before any endpoint is written to disk. */
export function endpointPath(url: string): string {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/iu.exec(url);
  const path = match?.[1] ?? '';
  return path.startsWith('/') ? path : `/${path}`;
}

/** Collects one request's terminal metadata and emits it before done/error. */
export function createRequestStatsReporter(input: {
  body: string;
  url: string;
  model: string;
  sentAtMs: number;
  clientClock: RequestClientClock;
  handler?: RequestStatsHandler | undefined;
  isAborted?: (() => boolean) | undefined;
  onCallbackError: (error: unknown) => void;
}): RequestStatsReporter {
  let finishReason: string | null = null;
  let usage: unknown;
  let timings: unknown;
  let ollamaDurations: OllamaDurationsNs | undefined;
  let reported = false;
  const emit = (error?: unknown): void => {
    if (reported) return;
    reported = true;
    const errorFinishReason =
      error instanceof Error &&
      error.name === 'ToolCallTruncatedError' &&
      typeof (error as Error & { finishReason?: unknown }).finishReason === 'string'
        ? (error as Error & { finishReason: string }).finishReason
        : undefined;
    const terminal = finishReason ?? errorFinishReason;
    const capture: RequestCapture = {
      body: input.body,
      url: endpointPath(input.url),
      model: input.model,
      sentAtMs: input.sentAtMs,
      stats: {
        outcome: requestOutcome(terminal, error, input.isAborted?.()),
        ...(terminal && terminal !== 'cancelled' ? { finishReason: terminal } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(timings !== undefined ? { timings } : {}),
        ...(ollamaDurations !== undefined ? { ollamaDurations } : {}),
        client: input.clientClock.finish(),
      },
    };
    if (!input.handler) return;
    try {
      input.handler(capture);
    } catch (callbackError) {
      input.onCallbackError(callbackError);
    }
  };
  return {
    complete: (reason) => {
      if (reason) finishReason = reason;
      emit();
    },
    fail: (error) => emit(error),
    setUsage: (value) => {
      usage = value;
    },
    setTimings: (value) => {
      timings = value;
    },
    setOllamaDurations: (value) => {
      ollamaDurations = value;
    },
  };
}
