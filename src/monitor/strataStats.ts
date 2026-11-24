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

/**
 * Strata's `POST metrics/reset`, which is what Strata's own Clear button sends
 * (`serve/web/app.js`, our patch db4d3018c: "Monitor Clear resets the Monitor totals").
 * The totals the page shows are the server's, so only the server can start them again.
 */
export async function resetStrataMetrics(
  endpoint: string,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(`${new URL(endpoint).origin}/metrics/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: '{}',
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return {
        ok: false,
        message: `The server answered ${response.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
