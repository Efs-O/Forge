import type { SdcppImageBackendConfig } from '../config/types';
import { sdServerSignature } from './sdServerArgs';
import {
  readSdServerRecord,
  sameModelPath,
  writeSdServerRecord,
  type SdServerOwnerRecord,
} from './sdServerOwnerRecord';

export async function verifySdServerAdoption(
  config: SdcppImageBackendConfig,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/sdcpp/v1/capabilities`, {
    method: 'GET',
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    throw new Error(
      `sdcpp port ${config.port} does not answer its capabilities endpoint (HTTP ${response.status}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `sdcpp port ${config.port} returned invalid capabilities JSON: ${errorMessage(error)}.`,
    );
  }
  const modelPath = readModelPath(body);
  if (!modelPath || !sameModelPath(modelPath, config.diffusion_model)) {
    throw new Error(
      `sdcpp port ${config.port} does not report configured diffusion_model ` +
        `"${config.diffusion_model}" (reported: "${modelPath ?? 'unknown'}"). ` +
        'Stop the server or choose another port.',
    );
  }
}

export async function touchAdoptedSdServerRecord(
  recordPath: string,
  config: SdcppImageBackendConfig,
  expected: SdServerOwnerRecord | null,
  now: () => number,
  warn: (message: string) => void,
): Promise<SdServerOwnerRecord> {
  const record = await readSdServerRecord(recordPath, warn);
  if (!record || record.signature !== sdServerSignature(config)) {
    throw new Error(
      `sdcpp adopted owner record "${recordPath}" disappeared or changed; ` +
        'do not retry until the other Forge window is checked.',
    );
  }
  if (!expected || record.pid !== expected.pid || record.pidCreatedAt !== expected.pidCreatedAt) {
    throw new Error(
      `sdcpp owner record "${recordPath}" now describes another process; ` +
        'the other Forge window must be checked before retrying.',
    );
  }
  const updated = { ...record, lastUsedAt: Math.max(record.lastUsedAt, now()) };
  await writeSdServerRecord(recordPath, updated);
  return updated;
}

function readModelPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('model' in value)) return undefined;
  const model = value.model;
  if (typeof model !== 'object' || model === null || !('path' in model)) return undefined;
  return typeof model.path === 'string' ? model.path : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
