import type { StallProbeAnswer } from './streamWatchdog';

const PROBE_TIMEOUT_MS = 4_000;
const STATUS_SAMPLE_DELAY_MS = 2_000;
type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Probe only a local inference server; cloud providers keep the watchdog's normal timeout. */
export function createStallProbe(
  baseUrl: string,
  fetchImpl: ProbeFetch = (url, init) => fetch(url, init),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): (signal: AbortSignal) => Promise<StallProbeAnswer> {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (!isLoopback(url.hostname)) return async () => 'skipped: not loopback';
    origin = url.origin;
  } catch {
    return async () => 'skipped: not loopback';
  }

  const getJson = async (endpoint: string, parentSignal: AbortSignal): Promise<unknown> => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${origin}${endpoint}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    }
  };

  return async (signal) => {
    try {
      const slots = await getJson('/slots', signal);
      // With --parallel > 1, this slot may belong to another conversation;
      // the watchdog's 15-minute ceiling bounds the wait.
      if (Array.isArray(slots) && slots.some(isProcessingSlot)) return 'alive';
      const first = await getJson('/v1/status', signal);
      if (!isBusyStatus(first)) return 'not-alive';
      await wait(STATUS_SAMPLE_DELAY_MS);
      if (signal.aborted) return `error: probe cancelled`;
      const second = await getJson('/v1/status', signal);
      return isBusyStatus(second) && second.generated > first.generated ? 'alive' : 'not-alive';
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

function isProcessingSlot(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['is_processing'] === true
  );
}

function isBusyStatus(value: unknown): value is { busy: true; generated: number } {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    status['busy'] === true &&
    typeof status['generated'] === 'number' &&
    Number.isFinite(status['generated'])
  );
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
}
