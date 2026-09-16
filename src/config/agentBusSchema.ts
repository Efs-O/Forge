import { z } from 'zod';

/**
 * `agent_bus:` — messaging between Forge and the Claude Code / Codex sessions
 * already running (docs/plans/AGENT_MESSAGING_PLAN.md). Absent or disabled
 * means no `ask_live_session` tool and no `/agent/*` routes, so a config
 * without it keeps the tool list, and with it the KV prefix, unchanged.
 */
export const AgentBusConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The Claude session asked when a call names none (its /rename name).
     *  Unset: the only live session open in this workspace. */
    claude_session: z.string().min(1).max(60).optional(),
    /** `pipe`: write to the session's own message pipe (free, instant).
     *  `relay`: a one-shot `claude -p` sends it with SendMessage (~$0.10 each),
     *  for a Claude Code whose pipe format Forge does not speak. */
    claude_transport: z.enum(['pipe', 'relay']).default('pipe'),
    /** Claude executable for the relay: a bare name on PATH or an absolute path. */
    claude_cli: z.string().min(1).default('claude'),
    /** Model the relay runs; it only calls SendMessage, so the cheapest works. */
    relay_model: z.string().min(1).default('haiku'),
    /** Thread id of an open Codex session (`codex resume <id>` in a terminal,
     *  with a writable sandbox that includes the bus folder). Needed only for
     *  `ask_live_session` with `target: codex`. */
    codex_thread: z.string().min(1).optional(),
    /** Codex executable: a bare name on PATH or an absolute path. */
    codex_cli: z.string().min(1).default('codex'),
  })
  .optional();

/** `agent_bus:` block (validated by agentBusSchema.ts). */
export type AgentBusConfig = NonNullable<z.infer<typeof AgentBusConfigSchema>>;
