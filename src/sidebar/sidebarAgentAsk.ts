import { randomUUID } from 'crypto';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import { AgentLinksConfigSchema } from '../config/agentBusSchema';
import type { ForgeConfig } from '../config/types';
import { makeAskAgentHandler, type AskAgentRequest } from '../agentLinks/askAgentService';
import { makeAskAgentRuntime } from '../agentLinks/askAgentRuntime';
import type { AgentLink } from '../agentLinks/chatAgentLinks';
import { findConversation, type SidebarRuntime } from './sessionTypes';

export function createSidebarAgentAsk(options: {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  checkpoints: CheckpointStack;
  workspaceRoot?: string;
  persist(): void;
}) {
  const controllers = new Map<string, AbortController>();
  const handler = makeAskAgentHandler({
    getConfig: options.getConfig,
    runtime: makeAskAgentRuntime({ getConfig: options.getConfig }),
    getLinkConfig: () => AgentLinksConfigSchema.parse(options.getConfig().agent_links),
  });

  return {
    cancel: (conversationId: string) => controllers.get(conversationId)?.abort(),
    async ask(
      conversationId: string,
      request: AskAgentRequest,
      signal: AbortSignal,
      onSessionLinked?: (link: AgentLink) => void,
      onAccepted?: (link: AgentLink) => void,
    ): Promise<import('../agentLinks/askAgentService').AskAgentResult> {
      const conversation = findConversation(options.getSidebar(), conversationId);
      if (!conversation) throw new Error('The bound chat is not available in this window.');
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      controllers.set(conversationId, controller);
      const checkpoint = options.checkpoints.beginTurn(
        `remote-agent-${randomUUID()}`,
        conversationId,
      );
      try {
        return await handler(request, {
          conversation,
          checkpoint,
          signal: controller.signal,
          workspaceRoot: options.workspaceRoot ?? '',
          persistConversation: options.persist,
          ...(onSessionLinked ? { onSessionLinked } : {}),
          ...(onAccepted ? { onAccepted } : {}),
        });
      } finally {
        options.checkpoints.commitTurn(checkpoint);
        if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
        signal.removeEventListener('abort', abort);
        options.persist();
      }
    },
  };
}
