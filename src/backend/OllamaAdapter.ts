import { waitForHealthy } from './HealthCheck';

export function normalizeOllamaEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, '').replace(/\/(v1|api)$/, '');
}

function nativeApiBase(endpoint: string): string {
  return `${normalizeOllamaEndpoint(endpoint)}/api`;
}

export async function ensureOllamaReady(endpoint: string, signal?: AbortSignal): Promise<void> {
  const baseUrl = normalizeOllamaEndpoint(endpoint);
  const result = await waitForHealthy(
    { baseUrl, timeoutMs: 10_000 },
    undefined,
    signal,
  );
  if (!result.ok) {
    throw new Error(`Ollama endpoint not reachable at ${baseUrl}: ${result.message}`);
  }
}

export async function releaseOllamaModel(endpoint: string, model: string): Promise<void> {
  const response = await fetch(`${nativeApiBase(endpoint)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      keep_alive: 0,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama release failed for "${model}": HTTP ${response.status} ${body}`.trim());
  }
}
