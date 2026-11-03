import { z } from 'zod';
import { BrowserPermissionSchema, DesktopPermissionSchema } from './browserSchema';

/**
 * `permissions:` — what the agent may do, and what it must ask the owner about
 * first. Deny by default: an absent block grants the defaults written here, and
 * a half-written block cannot open a capability the owner never named. The
 * browser and desktop sub-objects come from `browserSchema.ts`, which was split
 * out for the same reason this one now is: `schema.ts` sits at its 500-line
 * `max-lines` cap, and the chat flags (`new_chat`, `steer`,
 * `new_chats_per_hour`) still need room to grow.
 *
 * One key is a TOMBSTONE: `approval_stand_in` is declared, accepts anything, and
 * is refused by name in the refine below whenever it is present. Unknown keys
 * stay stripped exactly as they always were — the declaration exists only so a
 * key Forge removed cannot sit in the owner's file doing nothing while reading
 * as if it configured something. `permissions` is read from both config.yaml
 * and policy.yaml (`policySchema.ts` reuses this schema), so one refusal here
 * covers both files.
 */
const PermissionsShape = z.object({
  approval_timeout_minutes: z.number().int().min(1).max(1440).optional(),
  /** Removed with the approval stand-in in Forge 0.17.117. Declared only so the
   *  refine below can refuse a leftover BY name; it accepts anything, because
   *  the value stops mattering once the key is there, and nothing reads it. */
  approval_stand_in: z.unknown().optional(),
  /**
   * Paths that need approval to READ, on top of the defaults in
   * `tools/secretPaths.ts`. This list can only ADD: removing a default from
   * config does not open the gate, so a bad edit cannot widen the hole.
   * `secret_paths_allow` is the escape hatch — exact files, matched however
   * the agent spells the same file, for a job that genuinely needs one
   * `.env.production`. The "this chat has read a secret"
   * taint still applies to whatever it lets through.
   */
  secret_paths: z.array(z.string().min(1)).optional(),
  secret_paths_allow: z.array(z.string().min(1)).optional(),
  /** What a chat may do to other chats in this window. `new_chat` and `steer`
   *  are off unless the owner says otherwise, because both start or interrupt
   *  work the owner did not ask for; `view` is read-only and always on. */
  chats: z
    .object({
      new_chat: z.boolean().default(false),
      steer: z.boolean().default(false),
      /** How many chats one chat may open with `message_chat action=new` in an
       *  hour. The default is the 2 the tool had while it was hard-coded; raise
       *  it for a supervisor that dispatches several workers at once. Six is the
       *  ceiling, because a new chat also counts as an idle wake and six wakes
       *  an hour is the cap that binds first — a dial above six changes nothing.
       */
      new_chats_per_hour: z.number().int().min(1).max(6).default(2),
    })
    .optional(),
  fs: z
    .object({
      read: z.boolean().default(true),
      write: z.boolean().default(true),
      delete: z.boolean().default(false),
    })
    .optional(),
  net: z
    .object({ search: z.boolean().default(false), fetch: z.boolean().default(false) })
    .optional(),
  exec: z
    .object({
      terminal: z.boolean().default(false),
      headless: z.boolean().default(false),
      shell: z.enum(['pwsh', 'powershell', 'bash']).optional(),
      /** @deprecated Accepted for config compatibility; grants no capability. */
      shell_scripts: z.boolean().default(false),
    })
    .optional(),
  git: z.object({ read: z.boolean().default(true), write: z.boolean().default(false) }).optional(),
  agents: z
    .object({
      delegate: z.boolean().default(false),
      /** @deprecated Inert since dispatch_workers was removed. Still parsed
       *  so an existing config.yaml keeps booting; grants no capability.
       *  Delete once no user config is expected to carry it. */
      cloud_workers: z.boolean().default(false),
    })
    .optional(),
  browser: BrowserPermissionSchema,
  desktop: DesktopPermissionSchema,
});

/**
 * A key Forge REMOVED is a load error, not a stripped line. Zod drops unknown
 * keys by default, so a leftover `permissions.approval_stand_in` — the approval
 * stand-in, deleted in 0.17.117 — would otherwise sit in the owner's file doing
 * nothing while reading as if it still configured something. The key is declared
 * above precisely so this refine can NAME it; every other unknown key is still
 * stripped, exactly as before. `permissions` is read from both config.yaml and
 * policy.yaml, so this one refusal covers both files.
 */
export const PermissionsSchema = PermissionsShape.superRefine((perms, ctx) => {
  if (perms['approval_stand_in'] === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['approval_stand_in'],
    message:
      'permissions.approval_stand_in was removed in Forge 0.17.117 (the approval stand-in no longer exists). Delete it from policy.yaml.',
  });
}).optional();
