import { z } from 'zod';
import { usesLocalGpu } from './ModelHeuristics';
import type { ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';

/** Capacity reported by the exact local Strata model a request will use. */
export interface SharedModelSlots {
  capacity: number;
  inFlight: number;
}

export const StrataStatusSchema = z.object({
  service: z.literal('strata'),
  model: z.string(),
  loaded: z.literal(true),
  concurrency: z.object({ serving: z.number().int().positive() }),
  activity: z.object({ in_flight: z.number().int().nonnegative() }),
});

export interface SharedModelSlotsOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Read capacity only for a managed, named local Strata model. */
export async function sharedModelSlots(
  model: ModelConfig | undefined,
  options: SharedModelSlotsOptions = {},
): Promise<SharedModelSlots | undefined> {
  if (
    !usesLocalGpu(model) ||
    model?.provider !== 'openai-compatible' ||
    !model.endpoint ||
    !model.unload_path ||
    !model.model
  )
    return undefined;
  try {
    const url = new URL('/v1/status', model.endpoint);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)])
      : AbortSignal.timeout(3000);
    const response = await (options.fetchImpl ?? fetch)(url, { signal });
    if (!response.ok) {
      getLogger().debug(`[StrataStatus] status read returned HTTP ${response.status}`);
      return undefined;
    }
    const parsed = StrataStatusSchema.safeParse(await response.json());
    if (!parsed.success) {
      getLogger().debug('[StrataStatus] status response did not match the expected schema');
      return undefined;
    }
    if (parsed.data.model !== model.model) {
      getLogger().debug('[StrataStatus] status response reported a different model');
      return undefined;
    }
    return {
      capacity: parsed.data.concurrency.serving,
      inFlight: parsed.data.activity.in_flight,
    };
  } catch (err) {
    getLogger().debug(
      `[StrataStatus] status read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
