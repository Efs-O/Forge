import { z } from 'zod';

/**
 * Browser + desktop permission sub-objects (plan §4.1). Deny-by-default:
 * `enabled` defaults to false, so a config without these grants no browser or
 * desktop capability. Kept in their own file (with the browser config block)
 * so schema.ts stays under its max-lines budget.
 */
export const BrowserPermissionSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .optional();

export const DesktopPermissionSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .optional();

/** Non-permission browser knobs. `channel` is used as configured (no silent
 *  fallback); `headless` is a config value (tests), never a model arg. */
export const BrowserConfigSchema = z
  .object({
    channel: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
    headless: z.boolean().default(false),
    allowed_origins: z.array(z.string()).optional(),
  })
  .optional();
