import { z } from 'zod';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import { agentKindSchema } from '../agentLinks/chatAgentLinks';
import type { StartAgentAsk } from '../agentLinks/pendingAgentAsks';
import { MAX_QUESTION_CHARS } from '../agentBus/liveSessionLimit';

const requestSchema = z
  .object({
    agent: agentKindSchema,
    message: z.string().min(1).max(MAX_QUESTION_CHARS),
    subject: z.string().min(1).max(160).optional(),
  })
  .strict();

/**
 * `ask_agent` returns as soon as the ask is running: the sidebar's starter owns
 * the run (its own checkpoint and controller) and delivers the reply into the
 * chat as a message, so the asking turn keeps working instead of waiting.
 */
export function makeAskAgentTool(options: {
  getConfig: () => ForgeConfig;
  getStarter: () => StartAgentAsk | undefined;
}): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_agent',
        description:
          'Ask the Claude, Codex, or Copilot session linked to this chat; a missing link creates one. Returns at once; reply arrives here as a message. Keep working; do not ask again. If blocked, end your turn; reply starts a new one. Do not edit files you asked it to change. For local/cloud models, use ask_local_agent.',
        parameters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              enum: agentKindSchema.options,
              description:
                'Choose which linked CLI agent to ask: `claude` is Claude Code, `codex` is Codex CLI, and `copilot` is Copilot CLI. A missing link for the chosen agent creates one.',
            },
            message: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS },
            subject: { type: 'string', minLength: 1, maxLength: 160 },
          },
          required: ['agent', 'message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    /** The message goes to a session this chat does not control, and what comes
     *  back is that session's answer: `untrustedExitPolicy.ts` cards this in a
     *  chat that has read a page or a secret, and lets it run asking nothing in a
     *  clean one. */
    reachesOut: 'cross_chat',
    advertise: () => options.getConfig().agent_bus?.enabled === true,
    handler: async (args, context?: ToolHandlerContext) => {
      const parsed = requestSchema.parse(args);
      if (!context?.conversation) return 'Error: ask_agent requires an active chat turn.';
      const start = options.getStarter();
      if (!start) return 'Error: ask_agent: the Forge sidebar is not ready in this window.';
      return start(context.conversation.id, {
        agent: parsed.agent,
        message: parsed.message,
        ...(parsed.subject ? { subject: parsed.subject } : {}),
      });
    },
  };
}
