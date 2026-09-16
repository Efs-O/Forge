import { z } from 'zod';

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
  })
  .optional();
