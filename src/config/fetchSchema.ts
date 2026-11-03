import { z } from 'zod';

/**
 * Outbound `web_fetch` settings. `allowed_hosts` entries are exact hostnames or
 * `*.suffix` wildcards, and the default is empty: every host a chat has not
 * approved asks once per chat. A permanent exception is written here by the
 * owner, never by an approval, because an "always allow" clicked once in a chat
 * would otherwise outlive the chat that earned it — which is why there is no
 * such button. Split out of `schema.ts` the way `browserSchema.ts` and
 * `jobsSchema.ts` already were; `jobs.allowed_hosts` is a different gate with
 * different rules (a job is refused outright, `src/jobs/jobsFetch.ts`).
 */
export const FetchConfigSchema = z
  .object({ allowed_hosts: z.array(z.string().min(1)).optional() })
  .optional();
