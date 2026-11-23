import type { NATIVE_LAZY_GROUP_NAMES } from '../config/toolGroupNames';
import type { ToolDefinition } from '../llm/types';
import type { RegisteredTool } from './ToolRegistry';
import {
  activateLazyGroup,
  hasAvailableLazyGroup,
  isLazyGroupAvailable,
  isListedLazyGroup,
  isSchemasInResult,
  lazyGroupMembers,
  lazyGroupNames,
  textCallCatalog,
} from './lazyToolGroups';

/**
 * `load_tool_group` flips one per-conversation flag. In normal mode the real
 * schemas arrive through the `tools` array on the next round, so the result
 * never restates them; with tool_groups.schemas_in_result the list stays fixed,
 * so the result carries them instead. Each line names its members after the
 * purpose, so a model asked for a tool by name can find its group. A model that
 * already knows a name loses nothing: dispatch runs a registered tool whether or
 * not its group is loaded, a near-miss name gets ToolDispatch's unloaded-group
 * hint, and the load result names the members too.
 * Keyed by `NATIVE_LAZY_GROUP_NAMES`, so a new group without one fails to
 * compile. Keep HalluScribe's measured history cue close to its original
 * wording: Qwen found that group unprompted with the longer phrase.
 */
const GROUP_PURPOSE: Readonly<Record<(typeof NATIVE_LAZY_GROUP_NAMES)[number], string>> = {
  agents: 'ask other agents, scheduled jobs, notify the user (Telegram)',
  background: 'list or stop background jobs, timed wait',
  code_intel: 'rename symbols, apply code actions, format files, semantic search',
  computer_use: 'drive a browser or the desktop (screenshots need vision)',
  editor_ui: "the user's open editor, selection, clipboard, diffs",
  // `create_directory` is gone (2026-10-29, lane B item B3): `write_file` makes
  // the folders it writes into, so "mkdir" here would have sent a model looking
  // for a folder to a group that no longer holds one.
  files: 'move or rename a file, line-number edits, restore a file from a commit',
  git: 'git status, log, diff, blame and show, plus stage, commit and branch as tools (the shell runs git too)',
  halluscribe:
    'search previous AI coding sessions and historical workspace/user context: past implementation decisions, the exact wording of an earlier error or command, prior project history, the user profile/digest',
  // The check-your-own-output cue and "headless" are measured (2026-11-05): on
  // the same voxel-scene prompt one model never loaded media because "do not
  // open a browser" read to it as "you cannot look", and verified blind.
  media:
    'view images (including a picture of a page, chart or scene you rendered, to check your own visual work), generate and upscale images, reverse image search, generate videos and music, inspect video stills, render HTML to a PNG or preview (headless, opens no browser window), export documents, send files',
  memory: 'remember, recall, forget notes kept across conversations',
  notebook: 'Jupyter notebook cells',
  system: 'this PC: power, sleep/wake, status',
};

function describeGroups(): string {
  return lazyGroupNames()
    .map((group) => {
      const purpose = (GROUP_PURPOSE as Readonly<Record<string, string>>)[group];
      const members = lazyGroupMembers(group).join(', ');
      // MCP groups have no purpose line, so keep their existing names-only form.
      return purpose ? `${group}: ${purpose} (${members})` : `${group}: ${members}`;
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
        'Load a tool group; the result says how to call its tools. Available groups:\n' +
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

/**
 * One JSON schema per line, in the order the members were advertised, from the
 * turn's own text-call catalog: the allowed, budget-filtered definitions this
 * chat may actually call. A member the catalog does not hold is refused here and
 * named on the last line, so the result never teaches a call that cannot run.
 * A repeat call returns the same text — that is the recovery path after
 * excerpting or compaction took the schemas out of the transcript.
 */
function withResultSchemas(
  group: string,
  offered: readonly string[],
  notOffered: readonly string[],
  conversationId: string,
): string {
  const catalog = new Map(textCallCatalog(conversationId).map((d) => [d.function.name, d]));
  const withSchema = offered.filter((name) => catalog.has(name));
  const refused = offered.filter((name) => !catalog.has(name));
  const lines = withSchema
    .map((name) => {
      const def = catalog.get(name)!;
      return JSON.stringify({
        name: def.function.name,
        description: def.function.description,
        parameters: def.function.parameters,
      });
    })
    .join('\n');
  return [
    `${group} tools enabled for this conversation: ${withSchema.join(', ')}. They are not added ` +
      `to your tool list; call them like your other tools, with these schemas:\n${lines}`,
    ...(refused.length > 0
      ? [`Not allowed in this chat, so not listed: ${refused.join(', ')}.`]
      : []),
    ...(notOffered.length > 0
      ? [`Not set up in this window, so not listed: ${notOffered.join(', ')}.`]
      : []),
  ].join('\n');
}

/**
 * Demand-load entry point. In normal mode the schemas arrive through the next
 * tools array; with tool_groups.schemas_in_result they come in the result.
 * `isAdvertised` lets the caller drop members the next request will not
 * actually offer — a tool whose `advertise()` returns false, such as
 * `image_search` on a machine with no `image_search` config block. With no
 * argument, every member counts as advertised, so callers that do not care keep
 * the old behaviour.
 */
export function makeLoadToolGroupTool(
  isAdvertised?: (toolName: string) => boolean,
): RegisteredTool {
  return {
    // Valid even before any native tool or MCP server has registered. The
    // runtime description supplies the currently available enum at advertise time.
    definition: {
      type: 'function',
      function: {
        name: 'load_tool_group',
        description:
          'Load an optional tool group for this conversation. The result says how to call its tools.',
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
      // `advertise` decides which schemas the next request really offers, so the
      // reply must not name a member that will not arrive: on a laptop with no
      // `image_search` block the load text listed it and the model called it.
      const isMemberAdvertised = isAdvertised ?? (() => true);
      const members = lazyGroupMembers(group);
      const offered = members.filter(isMemberAdvertised);
      const notOffered = members.filter((name) => !isMemberAdvertised(name));
      if (offered.length === 0) {
        throw new Error(
          `load_tool_group: group "${group}" is unavailable because none of its tools ` +
            'is set up in this window; do not retry. ' +
            'Answer from the workspace and the conversation instead.',
        );
      }
      // A group this chat's tool list already holds -- loaded while the flag was
      // off, or eager by default or through `tool_groups.eager` -- stays listed.
      // Adding it to the result-schema set would hide tools the model has been
      // calling, and this turn's catalog holds only unlisted tools, so its
      // schemas would come back named as "not allowed in this chat".
      if (isSchemasInResult(conversationId) && !isListedLazyGroup(conversationId, group)) {
        activateLazyGroup(conversationId, group, { schemasInResult: true });
        return withResultSchemas(group, offered, notOffered, conversationId);
      }
      activateLazyGroup(conversationId, group);
      // The description no longer lists members, so the load says what arrived.
      const enabled =
        `${group} tools enabled for this conversation: ${offered.join(', ')}. ` +
        'They are listed on the next step.';
      return notOffered.length === 0
        ? enabled
        : `${enabled} Not set up in this window, so not listed: ${notOffered.join(', ')}.`;
    },
  };
}
