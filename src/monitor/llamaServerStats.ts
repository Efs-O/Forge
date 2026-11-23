import type { SlotStats } from './monitorTypes';

export function parseLlamaSlots(value: unknown): SlotStats | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots = value.filter(
    (slot): slot is Record<string, unknown> => !!slot && typeof slot === 'object',
  );
  return {
    active: slots.filter((slot) => slot.is_processing === true || slot.state === 1).length,
    total: slots.length,
    slots: slots.map((slot) => ({
      used: finite(slot.n_past) ?? finite(slot.n_prompt_tokens),
      size: finite(slot.n_ctx),
    })),
  };
}

export function parseLlamaPrometheus(text: string): Record<string, number> {
  const wanted = new Set([
    'llamacpp:prompt_tokens_seconds',
    'llamacpp:predicted_tokens_seconds',
    'llamacpp:requests_processing',
    'llamacpp:requests_deferred',
  ]);
  const values: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^\s{]+)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?:\s|$)/.exec(line);
    if (match && wanted.has(match[1])) values[match[1]] = Number(match[2]);
  }
  return values;
}

export async function readLlamaStats(
  baseUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slots?: SlotStats; metrics?: Record<string, number>; error?: string }> {
  const result: { slots?: SlotStats; metrics?: Record<string, number>; error?: string } = {};
  const slotsResponse = await fetchImpl(`${baseUrl}/slots`, { signal: requestSignal(signal) });
  if (slotsResponse.ok) {
    const slots = parseLlamaSlots(await slotsResponse.json());
    if (slots) result.slots = slots;
  } else if (slotsResponse.status !== 404 && slotsResponse.status !== 501)
    result.error = `/slots answered HTTP ${slotsResponse.status}`;
  const metricsResponse = await fetchImpl(`${baseUrl}/metrics`, { signal: requestSignal(signal) });
  if (metricsResponse.ok) result.metrics = parseLlamaPrometheus(await metricsResponse.text());
  else if (metricsResponse.status === 404)
    result.error = result.error ?? "Speed needs llama-server's --metrics flag.";
  else result.error = result.error ?? `/metrics answered HTTP ${metricsResponse.status}`;
  return result;
}

function requestSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(2000)]);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
