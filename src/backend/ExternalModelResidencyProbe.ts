export type ExternalResidencyProbeResult = 'connection-refused' | 'unloaded' | 'unchanged';

/** Read only confirmed model state; this endpoint never causes a model load. */
export async function probeExternalModelResidency(
  endpoint: string,
  modelId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ExternalResidencyProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/models`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    if (isConnectionRefused(error)) return 'connection-refused';
    if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
      return 'unchanged';
    }
    throw error;
  }
  if (response.status !== 200) return 'unchanged';

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'unchanged';
  }
  if (typeof body !== 'object' || body === null || !('data' in body)) return 'unchanged';
  const dataValue = (body as { data?: unknown }).data;
  if (!Array.isArray(dataValue)) return 'unchanged';
  const data = dataValue as unknown[];
  const matching = data.find(
    (entry) => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === modelId,
  );
  const entry = matching ?? (data.length === 1 ? data[0] : undefined);
  if (typeof entry !== 'object' || entry === null || !('status' in entry)) return 'unchanged';
  const status = entry.status;
  return typeof status === 'object' &&
    status !== null &&
    'value' in status &&
    status.value === 'unloaded'
    ? 'unloaded'
    : 'unchanged';
}

export function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  return (cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
}
