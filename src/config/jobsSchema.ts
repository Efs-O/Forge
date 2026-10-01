import { z } from 'zod';
import type { ForgeConfig } from './types';

export const GpuGateConfigSchema = z.object({
  /** nvidia-smi indices of the GPUs local models use. */
  gpus: z.array(z.number().int().nonnegative()).min(1),
  max_util_percent: z.number().min(0).max(100).default(1),
  max_idle_vram_mb: z.number().nonnegative().default(1024),
  sample_seconds: z.number().int().positive().default(15),
});

/**
 * `jobs:` — absent means no scheduler, no lease, no `manage_jobs` tool, no
 * Telegram job commands. The KV prefix is unchanged for configs without it,
 * the same as `image_generation`.
 *
 * `allowed_hosts` is the outbound-network gate (D5): a job may only fetch from
 * a host listed here. Empty (the default) means no job may touch the network.
 * B5 adds the asset-download redirect host, measured then, not guessed now.
 */
export const JobsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Outbound fetch gate. A job fetches only from a host in this list. */
    allowed_hosts: z.array(z.string().min(1)).default([]),
    /** How many jobs may run at once. 1 is safe for a single GPU. */
    max_concurrent: z.number().int().min(1).max(8).default(2),
    /** Let an unattended job drive a CLI agent (Claude Code / Codex) on the user's seat. */
    allow_cli_agents: z.boolean().default(false),
    /**
     * Model for agent tasks that name none. Hand-edited only: unlike
     * `active_model`, no chat-tab switch moves it.
     */
    default_model: z.string().min(1).optional(),
    /** Optional sampled safety gate for agent tasks on local GPUs. */
    gpu_gate: GpuGateConfigSchema.optional(),
  })
  .optional();

/**
 * The model an agent task with no `model` of its own runs on:
 * `jobs.default_model`, else `active_model` (the behaviour before the field).
 */
export function jobDefaultModel(config: ForgeConfig): string | undefined {
  return config.jobs?.default_model ?? config.active_model ?? undefined;
}
