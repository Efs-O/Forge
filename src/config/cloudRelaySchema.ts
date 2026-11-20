import { z } from 'zod';
import { isOllamaCloudModel } from '../llm/ModelRouteClassifier';
import { mergeGroupsIntoModel } from './ConfigResolver';
import type { ForgeConfig, ModelConfig } from './types';

/** What this desktop will render for a laptop (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md).
 *  Absent means the five media routes answer 404: a paid backend is served only
 *  when its name is listed here, because the listing is the owner's standing consent. */
export const CloudRelayMediaSchema = z
  .object({
    enabled: z.boolean().default(false),
    image_backends: z.array(z.string().min(1)).default([]),
    upscale: z.boolean().default(false),
    video_engines: z.array(z.string().min(1)).default([]),
    music_engines: z.array(z.string().min(1)).default([]),
    queue_limit: z.number().int().min(1).default(2),
    job_ttl_minutes: z.number().int().min(1).default(60),
  })
  .strict();

export type CloudRelayMediaConfig = z.infer<typeof CloudRelayMediaSchema>;

/** Desktop-side allowlist and loopback port for laptop cloud requests. */
export const CloudRelayConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(8797),
    max_body_mb: z.number().int().min(1).default(32),
    models: z.array(z.string().min(1)).min(1),
    media: CloudRelayMediaSchema.optional(),
  })
  .strict()
  .optional();

export type CloudRelayConfig = NonNullable<z.infer<typeof CloudRelayConfigSchema>>;

/** Cross-block checks kept with the relay schema so schema.ts stays cohesive. */
export function validateCloudRelayConfig(
  config: ForgeConfig,
  defaultControlPort: number,
  ctx: z.RefinementCtx,
): void {
  const relay = config.cloud_relay;
  if (!relay) return;
  const controlPort = config.control_server?.port ?? defaultControlPort;
  if (relay.port === controlPort) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cloud_relay', 'port'],
      message: `cloud_relay.port must differ from control_server.port (both ${controlPort})`,
    });
  }
  if (config.model_starter && relay.port === config.model_starter.port) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cloud_relay', 'port'],
      message: `cloud_relay.port must differ from model_starter.port (both ${config.model_starter.port})`,
    });
  }
  for (const name of relay.models) {
    const entry = config.models.find((model) => model.name === name);
    // A name whose model has been deleted is not a schema error: it is a
    // leftover, reported by name in the config warning (`modelReferences.ts`)
    // and left out of the effective allowlist here, so a laptop request for it
    // gets the relay's refusal plus the reason. This list is a security
    // allowlist: the type check below stays strict, and a name that DOES exist
    // but is not a keyed cloud model (or a non-loopback Ollama cloud model)
    // still refuses the whole config.
    if (!entry) continue;
    const model = mergeGroupsIntoModel(config, entry as unknown as ModelConfig);
    if (model.provider === 'ollama') {
      const host = model.endpoint ? endpointHost(model.endpoint) : '';
      if (!isOllamaCloudModel(model) || !isLoopbackHost(host)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cloud_relay', 'models'],
          message: `cloud_relay model "${name}" must be an Ollama cloud model (name ending in :cloud or -cloud) with a loopback endpoint`,
        });
      }
    } else if (
      !['openrouter', 'openai', 'openai-compatible'].includes(model.provider ?? '') ||
      !model.api_key_secret
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cloud_relay', 'models'],
        message: `cloud_relay model "${name}" must be a keyed cloud provider model`,
      });
    }
  }
}

function endpointHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
