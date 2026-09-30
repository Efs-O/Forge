import type { ToolDefinition } from '../llm/types';
import type { RegisteredTool } from './ToolRegistry';
import {
  activateLazyGroup,
  hasAvailableLazyGroup,
  isLazyGroupAvailable,
  lazyGroupMembers,
  lazyGroupNames,
} from './lazyToolGroups';

/**
 * `load_tool_group` flips one per-conversation flag; the real schemas arrive
 * through the normal `tools` array on the next round, so this tool must never
 * restate them. Its permanent description is the group's discovery surface.
 * Keep HalluScribe's measured history cue close to its original wording: Qwen
 * found that group unprompted with the longer phrase.
 */
const GROUP_PURPOSE: Readonly<Record<string, string>> = {
  computer_use: 'control browser tabs and the desktop',
  editor_ui: 'inspect and navigate editor files, selection, and clipboard',
  halluscribe:
    'search previous AI coding sessions and historical workspace/user context: past implementation decisions, the exact wording of an earlier error or command, prior project history, the user profile/digest',
  media: 'view images and video, or generate and search for images',
  memory: 'save and recall durable project and user memories',
  notebook: 'read and edit notebook cells',
  system: 'install llama.cpp and inspect or control computer power',
};

function describeGroups(): string {
  return lazyGroupNames()
    .map(
      (group) =>
        `${group}: ${GROUP_PURPOSE[group] ?? 'use these tools'}; tools: ${lazyGroupMembers(group).join(', ')}`,
    )
    .join('\n');
}

function buildDefinition(groups?: string[]): ToolDefinition {
  const groupSchema: { type: 'string'; description: string; enum?: string[] } = {
    type: 'string',
    description: 'Group to load.',
  };
  if (groups?.length) groupSchema.enum = groups;
  return {
    type: 'function',
    function: {
      name: 'load_tool_group',
      description:
        'Load an optional tool group for this conversation. Each group description gives its purpose and tools. ' +
        'After loading, its tools appear on the next step. Available groups and tools:\n' +
        describeGroups(),
      parameters: {
        type: 'object',
        properties: { group: groupSchema },
        required: ['group'],
        additionalProperties: false,
      },
    },
  };
}

/** Demand-load entry point. Real schemas arrive through the next normal tools array. */
export function makeLoadToolGroupTool(): RegisteredTool {
  return {
    // Valid even before any native tool or MCP server has registered. The
    // runtime description supplies the currently available enum at advertise time.
    definition: {
      type: 'function',
      function: {
        name: 'load_tool_group',
        description:
          'Load an optional tool group for this conversation. After loading, its tools appear on the next step.',
        parameters: {
          type: 'object',
          properties: { group: { type: 'string', description: 'Group to load.' } },
          required: ['group'],
          additionalProperties: false,
        },
      },
    },
    describe: () => buildDefinition(lazyGroupNames()),
    permission: 'read',
    // Structurally bounded: one group name, and the only effect is which
    // schemas the next request advertises. Nothing is read, written, or spawned.
    autoApprove: true,
    // No optional group is available (MCP server unconfigured/failed, or no
    // grouped tools registered): advertising this would promise a capability
    // that cannot load.
    advertise: hasAvailableLazyGroup,
    handler: async (args, context) => {
      const group = args['group'] as string;
      const conversationId = context?.conversationId;
      if (conversationId === undefined) {
        throw new Error(
          'load_tool_group: no conversation context, so the group cannot be activated. ' +
            'Continue using the workspace and conversation.',
        );
      }
      if (!isLazyGroupAvailable(group)) {
        const why =
          group === 'halluscribe'
            ? 'its MCP server is not configured or failed to connect'
            : 'the group has no registered tools';
        throw new Error(
          `load_tool_group: group "${group}" is unavailable because ${why}; do not retry. ` +
            'Answer from the workspace and the conversation instead.',
        );
      }
      if (group === 'computer_use' && context?.isVisionModel !== true) {
        const model = context?.modelName ?? 'the current model';
        throw new Error(
          `load_tool_group: computer_use is unavailable on non-vision model "${model}"; ` +
            'do not retry. Answer from the workspace and the conversation instead.',
        );
      }
      activateLazyGroup(conversationId, group);
      return `${group} tools enabled for this conversation. They are listed on the next step.`;
    },
  };
}
