import { z } from 'zod';

/**
 * `agent_bus:` — messaging between Forge and the Claude Code / Codex sessions
 * already running (docs/plans/AGENT_MESSAGING_PLAN.md). Absent or disabled
 * means no `ask_live_session` tool and no `/agent/*` routes, so a config
 * without it keeps the tool list, and with it the KV prefix, unchanged.
 */
/** `agent_bus.copilot_model` default; also used when there is no `agent_bus` block. */
export const DEFAULT_COPILOT_MODEL = 'auto';

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
    /** Copilot CLI executable: a bare name on PATH or an absolute path. */
    copilot_cli: z.string().min(1).default('copilot'),
    /** Model for a Forge-owned Copilot session (`--model`). Defaults to
     *  `auto`: with no flag the CLI runs its premium default model on every
     *  call. Applies at the next creation. */
    copilot_model: z.string().min(1).default(DEFAULT_COPILOT_MODEL),
    /** Model for a Forge-owned Codex session (`thread/start` `model`). Unset:
     *  the `~/.codex/config.toml` default. Applies at the next creation. */
    codex_model: z.string().min(1).optional(),
    /** Reasoning effort for a Forge-owned Codex session, passed to the
     *  app-server process as `-c model_reasoning_effort="<v>"`. Unset: the
     *  CLI's own default. Applies at the next creation. */
    codex_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /** Model for a Forge-owned Claude session (`--model`). Unset: the CLI's
     *  own default. Applies at the next creation. */
    claude_model: z.string().min(1).optional(),
    /** Reasoning effort for a Forge-owned Claude session (`--effort`). Unset:
     *  the CLI's own default. Applies at the next creation. */
    claude_effort: z.string().min(1).optional(),
  })
  .optional();

/** `agent_bus:` block (validated by agentBusSchema.ts). */
export type AgentBusConfig = NonNullable<z.infer<typeof AgentBusConfigSchema>>;
