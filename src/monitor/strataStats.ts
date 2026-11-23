import type { StrataStats } from './monitorTypes';

export function parseStrataMetrics(data: unknown, maxContext?: number): StrataStats {
  const live = (data as { live?: unknown } | null)?.live;
  if (!live || typeof live !== 'object') return {};
  const source = live as Record<string, unknown>;
  const result: StrataStats = {};
  if (typeof source.state === 'string') result.state = source.state;
  copyNumber(source, 'tok_s', result, 'decodeTokS');
  copyNumber(source, 'tok_s_mean', result, 'decodeTokSMean');
  copyNumber(source, 'prefill_tok_s_mean', result, 'prefillTokSMean');
  copyNumber(source, 'prompt_read', result, 'promptRead');
  copyNumber(source, 'prompt_total', result, 'promptTotal');
  copyNumber(source, 'running', result, 'running');
  copyNumber(source, 'parallel', result, 'slots');
  const queued = number(source.queued);
  const waiting = number(source.waiting);
  if (queued !== undefined || waiting !== undefined)
    result.waiting = (queued ?? 0) + (waiting ?? 0);
  const busy = source.state === 'reading' || source.state === 'generating';
  if (result.running === undefined) result.running = busy ? 1 : 0;
  const prompt = number(source.prompt_tokens);
  const generated = number(source.generated);
  if (busy && prompt !== undefined && generated !== undefined)
    result.contextUsed = prompt + generated;
  if (maxContext !== undefined) result.contextSize = maxContext;
  return result;
}

export async function readStrataStats(
  endpoint: string,
  secret: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  maxContext?: number,
): Promise<StrataStats> {
  const response = await fetchImpl(`${new URL(endpoint).origin}/metrics`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    headers: {
      Accept: 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  });
  if (!response.ok) return { error: `/metrics answered HTTP ${response.status}` };
  return parseStrataMetrics(await response.json(), maxContext);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function copyNumber<K extends keyof StrataStats>(
  source: Record<string, unknown>,
  from: string,
  target: StrataStats,
  to: K,
): void {
  const value = number(source[from]);
  if (value !== undefined) target[to] = value as StrataStats[K];
}
