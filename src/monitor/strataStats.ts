import type { MetricsDocument } from './monitorTypes';

/**
 * Strata's `GET /metrics`, passed through whole.
 *
 * The Monitor panel *is* Strata's Monitor page, so it reads Strata's document: every
 * top-level key (`engine`, `live`, `requests`, `conversation_cache`, `totals`,
 * `monitor_totals`, `hardware`, `hardware_static`, `history`, `forge`, `ups`) goes to the
 * webview untouched rather than being narrowed to the handful of `live` fields an earlier
 * version kept.
 */
export async function readStrataMetrics(
  endpoint: string,
  secret: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricsDocument> {
  const response = await fetchImpl(`${new URL(endpoint).origin}/metrics?requests=all`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    headers: {
      Accept: 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  });
  if (!response.ok) return { error: `/metrics answered HTTP ${response.status}` };
  return (await response.json()) as MetricsDocument;
}
