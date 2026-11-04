import { z } from 'zod';
import { StrataStatusSchema } from './strataStatus';

export type ExternalModelResidencyProbeResult =
  | { state: 'connection-refused' | 'stale-claim' | 'unloaded' | 'unknown' }
  | { state: 'loaded'; matchesModel: boolean };

const ModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().optional(),
      status: z.object({ value: z.enum(['loaded', 'unloaded']) }),
    }),
  ),
});

const ResidencyStatusSchema = z.object({
  service: z.string().optional(),
  model: StrataStatusSchema.shape.model.optional(),
  loaded: z.boolean().optional(),
});

type JsonReadResult = { state: 'ok'; body: unknown } | { state: 'connection-refused' | 'unknown' };

export interface ExternalResidencyCandidate {
  name: string;
  endpoint: string;
  apiKeySecret?: string | undefined;
}

export interface ExternalResidencyEndpointResult {
  names: string[];
  result: ExternalModelResidencyProbeResult;
}

/** Read only confirmed model state; these endpoints never cause a model load. */
export async function probeExternalModelResidency(
  endpoint: string,
  modelId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ExternalModelResidencyProbeResult> {
  const base = endpoint.replace(/\/+$/, '');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const models = await readJson(`${base}/v1/models`, headers, fetchImpl);
  if (models.state !== 'ok') return models;

  const parsedModels = ModelsSchema.safeParse(models.body);
  if (!parsedModels.success) return { state: 'unknown' };
  const loaded = parsedModels.data.data.filter((entry) => entry.status.value === 'loaded');
  if (loaded.length) {
    return {
      state: 'loaded',
      matchesModel: loaded.some(
        (entry) =>
          (modelId !== undefined && entry.id === modelId) ||
          (parsedModels.data.data.length === 1 && entry.id === undefined),
      ),
    };
  }

  const status = await readJson(`${base}/v1/status`, headers, fetchImpl);
  if (status.state !== 'ok') return status;
  const parsedStatus = ResidencyStatusSchema.safeParse(status.body);
  if (!parsedStatus.success) return { state: 'unknown' };
  if (
    parsedStatus.data.service === 'strata' &&
    parsedStatus.data.model !== undefined &&
    parsedStatus.data.loaded === true
  ) {
    return { state: 'stale-claim' };
  }
  return { state: 'unloaded' };
}

/** Probe distinct managed endpoints in parallel, using the first entry's credentials. */
export async function probeExternalResidencyEndpoints(
  candidates: readonly ExternalResidencyCandidate[],
  secret: (key: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch,
): Promise<ExternalResidencyEndpointResult[]> {
  const endpoints = new Map<
    string,
    Omit<ExternalResidencyEndpointResult, 'result'> & {
      endpoint: string;
      apiKeySecret?: string | undefined;
    }
  >();
  for (const candidate of candidates) {
    const endpoint = candidate.endpoint.replace(/\/+$/, '');
    const group = endpoints.get(endpoint);
    if (group) {
      group.names.push(candidate.name);
    } else {
      endpoints.set(endpoint, {
        endpoint,
        names: [candidate.name],
        apiKeySecret: candidate.apiKeySecret,
      });
    }
  }

  return Promise.all(
    [...endpoints.values()].map(async (group) => {
      try {
        const token = group.apiKeySecret ? await secret(group.apiKeySecret) : undefined;
        return {
          names: group.names,
          result: await probeExternalModelResidency(group.endpoint, undefined, token, fetchImpl),
        };
      } catch {
        return { names: group.names, result: { state: 'unknown' as const } };
      }
    }),
  );
}

async function readJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<JsonReadResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    return isConnectionRefused(error) ? { state: 'connection-refused' } : { state: 'unknown' };
  }
  if (response.status !== 200) return { state: 'unknown' };
  try {
    return { state: 'ok', body: await response.json() };
  } catch {
    return { state: 'unknown' };
  }
}

export function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  return (cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
}
