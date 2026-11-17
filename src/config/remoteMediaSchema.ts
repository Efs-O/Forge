/**
 * `remote_media` — the laptop half of the desktop media relay
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md, phase 2).
 *
 * It lives in `config.yaml`, not `~/.forge/policy.yaml`: it carries no token and
 * no desktop path, and `policySchema.ts` picks the policy blocks by name, so a
 * key that is not in that list is config-only by construction.
 *
 * The block deliberately holds no address. The relay to ask is the one this
 * laptop already dials for cloud models — `groups['desktop-relay'].endpoint` —
 * so a second relay URL could not drift from the first, and a laptop that
 * changes tailnets changes one field instead of two.
 */
import { z } from 'zod';
import type { ForgeConfig } from './types';

/**
 * The `groups:` entry whose `endpoint` supplies the relay origin. The name is
 * `RELAY_GROUPS.openai` in `src/vscode/desktopConnectPlan.ts`, which is what
 * "Forge: Connect to my desktop" creates; `DesktopConnectMedia.test.ts` pins the
 * two spellings equal, so this copy cannot drift.
 */
export const REMOTE_MEDIA_GROUP = 'desktop-relay';

export const RemoteMediaConfigSchema = z
  .object({
    /** Off by default: a laptop that never asked for this keeps the tool list —
     *  and the KV prefix — exactly as it was. */
    enabled: z.boolean().default(false),
  })
  .strict()
  .optional();

export type RemoteMediaConfig = NonNullable<z.infer<typeof RemoteMediaConfigSchema>>;

/** Cross-block check kept beside the block it reads, the way
 *  `validateCloudRelayConfig` keeps the relay's (`cloudRelaySchema.ts`). */
export function validateRemoteMediaConfig(config: ForgeConfig, ctx: z.RefinementCtx): void {
  if (!config.remote_media?.enabled) return;
  if (config.groups?.[REMOTE_MEDIA_GROUP]?.endpoint) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['remote_media', 'enabled'],
    message:
      `remote_media.enabled: true needs groups.${REMOTE_MEDIA_GROUP}.endpoint: that endpoint's ` +
      'origin is where media jobs go, and this block carries no address of its own. Run "Forge: ' +
      `Connect to my desktop", or add groups.${REMOTE_MEDIA_GROUP}.endpoint.`,
  });
}
