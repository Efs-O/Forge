import { z } from 'zod';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import { AgentLinksConfigSchema } from '../config/agentBusSchema';
import { agentKindSchema } from '../agentLinks/chatAgentLinks';
import {
  makeAskAgentHandler,
  renderAskAgentResult,
  type AskAgentRuntime,
} from '../agentLinks/askAgentService';

const requestSchema = z
  .object({
    agent: agentKindSchema,
    message: z.string().min(1).max(6000),
    subject: z.string().min(1).max(160).optional(),
  })
  .strict();

export function makeAskAgentTool(options: {
  getConfig: () => ForgeConfig;
  runtime: AskAgentRuntime;
  workspaceRoot: () => string;
}): RegisteredTool {
  const handler = makeAskAgentHandler({
    getConfig: options.getConfig,
    runtime: options.runtime,
    getLinkConfig: () => AgentLinksConfigSchema.parse(options.getConfig().agent_links),
  });
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_agent',
        description:
          'Ask the Claude, Codex, or Copilot session linked to this chat and wait for its reply. A missing link creates a session for this chat.',
        parameters: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: ['claude', 'codex', 'copilot'] },
            message: { type: 'string', minLength: 1, maxLength: 6000 },
            subject: { type: 'string', minLength: 1, maxLength: 160 },
          },
          required: ['agent', 'message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    advertise: () => options.getConfig().agent_bus?.enabled === true,
    handler: async (args, context?: ToolHandlerContext) => {
      const parsed = requestSchema.parse(args);
      if (
        !context?.conversation ||
        !context.checkpoint ||
        !context.abortSignal ||
        !context.persistConversation
      )
        return 'Error: ask_agent requires an active chat turn and checkpoint.';
      const result = await handler(
        {
          agent: parsed.agent,
          message: parsed.message,
          ...(parsed.subject ? { subject: parsed.subject } : {}),
        },
        {
          conversation: context.conversation,
          checkpoint: context.checkpoint,
          signal: context.abortSignal,
          workspaceRoot: options.workspaceRoot(),
          persistConversation: context.persistConversation,
        },
      );
      return renderAskAgentResult(result);
    },
  };
}
