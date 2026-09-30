import type { RegisteredTool } from './ToolRegistry';
import {
  activateLazyGroup,
  hasAvailableLazyGroup,
  isLazyGroupAvailable,
  lazyGroupMembers,
  lazyGroupNames,
} from './lazyToolGroups';

function describeGroups(): string {
  return lazyGroupNames()
    .map((group) => `${group}: ${lazyGroupMembers(group).join(', ')}`)
    .join('\n');
}

/** Demand-load entry point. Real schemas arrive through the next normal tools array. */
export function makeLoadToolGroupTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'load_tool_group',
        description:
          'Load a rare optional tool group for this conversation. Available groups and tools:\n',
        parameters: {
          type: 'object',
          properties: {
            group: { type: 'string', enum: [], description: 'Group to load.' },
          },
          required: ['group'],
          additionalProperties: false,
        },
      },
    },
    describe: () => {
      const groups = lazyGroupNames();
      return {
        type: 'function',
        function: {
          name: 'load_tool_group',
          description:
            'Load a rare optional tool group for this conversation. Available groups and tools:\n' +
            describeGroups(),
          parameters: {
            type: 'object',
            properties: {
              group: { type: 'string', enum: groups, description: 'Group to load.' },
            },
            required: ['group'],
            additionalProperties: false,
          },
        },
      };
    },
    permission: 'read',
    autoApprove: true,
    advertise: hasAvailableLazyGroup,
    handler: async (args, context) => {
      const group = args['group'] as string;
      const conversationId = context?.conversationId;
      if (conversationId === undefined) {
        throw new Error(
          'load_tool_group: no conversation context; continue without loading a group.',
        );
      }
      if (!isLazyGroupAvailable(group)) {
        throw new Error(
          `load_tool_group: group "${group}" is unavailable. It has NOT been enabled; do not retry.`,
        );
      }
      if (group === 'computer_use' && context?.isVisionModel !== true) {
        const model = context?.modelName ?? 'the current model';
        throw new Error(
          `load_tool_group: computer_use is unavailable on non-vision model "${model}".`,
        );
      }
      activateLazyGroup(conversationId, group);
      return `${group} tools enabled for this conversation. They are listed on the next step.`;
    },
  };
}
