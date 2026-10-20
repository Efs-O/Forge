import type { NATIVE_LAZY_GROUP_NAMES } from '../config/toolGroupNames';
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
 * restate them. Each group's job line is its discovery surface: a model looks
 * for what it needs to do, and a tool name does not always say that. Member
 * names are not listed — they cost 283 tokens on every request (measured on
 * Flash-Next, 2026-10-20) — so a purpose carries the verbs its tools did. A
 * model that already knows a name loses nothing: dispatch runs a registered
 * tool whether or not its group is loaded, a near-miss name gets ToolDispatch's
 * unloaded-group hint, and the load result names the members.
 * Keyed by `NATIVE_LAZY_GROUP_NAMES`, so a new group without one fails to
 * compile. Keep HalluScribe's measured history cue close to its original
 * wording: Qwen found that group unprompted with the longer phrase.
 */
const GROUP_PURPOSE: Readonly<Record<(typeof NATIVE_LAZY_GROUP_NAMES)[number], string>> = {
  agents: 'ask other agents, scheduled jobs, notify the user (Telegram)',
  background: 'list or stop background jobs, timed wait',
  code_intel: 'definitions, references, renames, semantic search',
  computer_use: 'drive a browser or the desktop (screenshots need vision)',
  editor_ui: "the user's open editor, selection, clipboard, diffs",
  files: 'move, mkdir, line-number edits, restore a file',
  git: 'stage, commit, branch as tools (the shell runs git too)',
  halluscribe:
    'search previous AI coding sessions and historical workspace/user context: past implementation decisions, the exact wording of an earlier error or command, prior project history, the user profile/digest',
  media: 'view/generate images, image search, send files',
  memory: 'remember, recall, forget notes kept across conversations',
  notebook: 'Jupyter notebook cells',
  system: 'this PC: power, sleep/wake, status, llama.cpp',
};

function describeGroups(): string {
  return lazyGroupNames()
    .map((group) => {
      const purpose = (GROUP_PURPOSE as Readonly<Record<string, string>>)[group];
      // A group without a job line (an MCP server's) has only its names to show.
      return `${group}: ${purpose ?? lazyGroupMembers(group).join(', ')}`;
    })
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
        'Load a tool group; its tools appear on the next step. Available groups:\n' +
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
      activateLazyGroup(conversationId, group);
      // The description no longer lists members, so the load says what arrived.
      return (
        `${group} tools enabled for this conversation: ${lazyGroupMembers(group).join(', ')}. ` +
        'They are listed on the next step.'
      );
    },
  };
}
