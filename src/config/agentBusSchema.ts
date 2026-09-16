import { z } from 'zod';

/**
 * `agent_bus:` — the file mailbox that lets the agent ask a Claude Code session
 * that is already running (docs/plans/AGENT_BUS_TOOL_PLAN.md). Absent or
 * disabled means no `ask_live_session` tool, so a config without it keeps the
 * tool list, and with it the KV prefix, unchanged.
 */
export const AgentBusConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
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
