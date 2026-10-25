import { isIP } from 'node:net';
import { mergeGroupsIntoModel, resolveRequestModel } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';

const STATUS_TIMEOUT_MS = 2_500;

export interface ModelSpeedSnapshot {
  model: string;
  at: string;
  predictedPerSecond: number;
  promptPerSecond: number;
  predictedN: number;
  promptN: number;
}

type SpeedFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Read the endpoint's completed-request snapshot once when /speed is requested.
 * Only a configured, loopback OpenAI-compatible endpoint exposing the expected
 * status shape is supported; this never contacts a cloud provider.
 */
export function createRemoteModelSpeedReader(
  config: ForgeConfig,
  fetchImpl: SpeedFetch = (url, init) => fetch(url, init),
): (modelName: string, signal: AbortSignal) => Promise<ModelSpeedSnapshot | undefined> {
  return async (modelName, parentSignal) => {
    let endpoint: URL;
    let expectedModel: string;
    try {
      const model = mergeGroupsIntoModel(config, resolveRequestModel(config, modelName));
      if (model.provider !== 'openai-compatible' || !model.endpoint) return undefined;
      endpoint = new URL(model.endpoint);
      if (
        endpoint.protocol !== 'http:' ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        !isLoopback(endpoint.hostname)
      ) {
        return undefined;
      }
      expectedModel = model.model ?? model.name;
    } catch {
      return undefined;
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    parentSignal.addEventListener('abort', onAbort, { once: true });
    if (parentSignal.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const statusUrl = new URL('/v1/status', endpoint.origin).toString();
      const response = await fetchImpl(statusUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return parseSpeedSnapshot(await response.json(), expectedModel);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onAbort);
    }
  };
}

function parseSpeedSnapshot(value: unknown, expectedModel: string): ModelSpeedSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const status = value as Record<string, unknown>;
  const at = normalizeTimestamp(status['at']);
  if (status['model'] !== expectedModel || at === undefined) return undefined;
  const timings = status['last_timings'];
  if (typeof timings !== 'object' || timings === null) return undefined;
  const fields = timings as Record<string, unknown>;
  const predictedPerSecond = positiveFinite(fields['predicted_per_second']);
  const promptPerSecond = positiveFinite(fields['prompt_per_second']);
  const predictedN = nonNegativeInteger(fields['predicted_n']);
  const promptN = nonNegativeInteger(fields['prompt_n']);
  if (
    predictedPerSecond === undefined ||
    promptPerSecond === undefined ||
    predictedN === undefined ||
    promptN === undefined
  ) {
    return undefined;
  }
  return { model: expectedModel, at, predictedPerSecond, promptPerSecond, predictedN, promptN };
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  let timestamp: number;
  if (typeof value === 'string') {
    timestamp = Date.parse(value);
  } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    timestamp = value < 100_000_000_000 ? value * 1_000 : value;
  } else {
    return undefined;
  }
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}
