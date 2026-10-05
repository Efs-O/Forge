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
    /**
     * Opt in to controlling the ordinary VS Code `code` process (plan Phase 3).
     * No effect while `enabled` is false. Deliberately narrow: it names the
     * `code`/`code.exe` PROCESS only — never a title match, never the
     * `Chrome_WidgetWin_1` window class, and never a fork (`Code - Insiders`,
     * `cursor`, `windsurf`, `codium`, `vscodium`, `devenv`), which stay
     * unconditionally refused. Every input to a Code window still needs its own
     * explicit confirmation, so the opt-in alone cannot drive Forge's chat.
     */
    allow_vscode: z.boolean().default(false),
  })
  .optional();

/** The channel used when `browser:` is absent. Exported so a tool that must
 *  fall back without a config getter reads the same value the schema defaults
 *  to, rather than repeating the literal (CLAUDE.md: prefer explicit config
 *  over hidden fallback behaviour). */
export const DEFAULT_BROWSER_CHANNEL = 'chrome' as const;

/** Non-permission browser knobs. `channel` is used as configured (no silent
 *  fallback); `headless` is a config value (tests), never a model arg. */
export const BrowserConfigSchema = z
  .object({
    channel: z.enum(['chrome', 'msedge', 'chromium']).default(DEFAULT_BROWSER_CHANNEL),
    headless: z.boolean().default(false),
    allowed_origins: z.array(z.string()).optional(),
  })
  .optional();
