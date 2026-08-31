import type { RegisteredTool } from './ToolRegistry';
import { activateLazyGroup, isLazyGroupAvailable } from './lazyToolGroups';

/**
 * `load_tool_group` — the demand-load entry point for a lazy MCP tool group
 * (see `lazyToolGroups.ts`). Its whole job is to flip one per-conversation
 * flag; the group's real schemas arrive through the normal `tools` array on
 * the very next round, so this must never restate them.
 *
 * The description is the entire permanent cost of the experiment, so it buys
 * exactly one thing: enough signal for the model to recognise a
 * historical-context task. Keep it short.
 */
export function makeLoadToolGroupTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'load_tool_group',
        description:
          'Load an optional group of tools that is not advertised by default. ' +
          'Use group="halluscribe" for tools that search previous AI coding ' +
          'sessions and historical workspace/user context: past implementation ' +
          'decisions, the exact wording of an earlier error or command, prior ' +
          'project history, or the user profile/digest. The tools appear on the ' +
          'next step; call them then.',
        parameters: {
          type: 'object',
          properties: {
            group: {
              type: 'string',
              enum: ['halluscribe'],
              description: 'Group to load.',
            },
          },
          required: ['group'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    // Structurally bounded: one enum argument, and the only effect is which
    // schemas the next request advertises. Nothing is read, written, or spawned.
    autoApprove: true,
    // No lazy group is bridged in (server unconfigured or failed to connect):
    // advertising a tool whose only outcome is an error teaches the model a
    // capability that does not exist.
    advertise: () => isLazyGroupAvailable('halluscribe'),
    handler: async (args, context) => {
      const group = args['group'] as string;
      const conversationId = context?.conversationId;
      if (conversationId === undefined) {
        throw new Error(
          'load_tool_group: no conversation context for this call, so the group cannot be ' +
            'activated. Continue without it.',
        );
      }
      if (!isLazyGroupAvailable(group)) {
        throw new Error(
          `load_tool_group: tool group "${group}" is unavailable — its MCP server is not ` +
            'configured, or failed to connect. It has NOT been enabled; do not retry. ' +
            'Answer from the workspace and the current conversation instead.',
        );
      }
      activateLazyGroup(conversationId, group);
      return `${group} tools enabled for this conversation. They are listed on the next step.`;
    },
  };
}
