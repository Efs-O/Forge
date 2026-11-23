import { z } from 'zod';
import * as vscode from 'vscode';
import { agentTargetCatalog, discoverAgentTargets } from '../agentLinks/agentTargets';
import { REMOTE_MEDIA_GROUP } from '../config/remoteMediaSchema';
import type { ForgeConfig } from '../config/types';
import type { RegisteredTool } from './ToolRegistry';

export function makeListAgentTargetsTool(
  getConfig: () => ForgeConfig,
  getWorkspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_agent_targets',
        description:
          'Discover CLI targets for ask_agent. Default: Codex models and supported efforts for a new task. Use kind existing_session for workspace sessions (availability and model/effort unverified). Pass a returned target_id; never edit config to select an agent. Local/cloud: list_delegation_targets.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['new_task', 'existing_session'],
              description:
                'Default new_task lists model/effort pairs without scanning session history. existing_session lists exact workspace session ids.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    autoApprove: true,
    advertise: () => getConfig().agent_bus?.enabled === true,
    handler: async (args, context) => {
      const { kind } = z
        .object({ kind: z.enum(['new_task', 'existing_session']).default('new_task') })
        .strict()
        .parse(args);
      const cwd = getWorkspaceRoot();
      if (!context?.conversation || !cwd)
        return 'Error: list_agent_targets requires an active chat and workspace folder.';
      const { targets, errors } = await discoverAgentTargets(
        getConfig(),
        cwd,
        context.abortSignal,
        kind,
      );
      const listed = agentTargetCatalog.publish(context.conversation.id, cwd, targets);
      // A laptop on the desktop relay sees only its own CLI installs, and a
      // laptop chat that found no target went and dialed the relay's own
      // endpoints — which load and unload the desktop's models. Say both.
      const onTheRelay = getConfig().groups?.[REMOTE_MEDIA_GROUP]?.endpoint !== undefined;
      return JSON.stringify({
        targets: listed.map(({ targetId, ...target }) => ({ target_id: targetId, ...target })),
        errors,
        expires_in_minutes: 10,
        usage:
          'Pass agent and target_id to ask_agent. new_task creates a separate session; existing_session addresses that identity without changing chat links. Model and effort of existing sessions are unknown; use new_task for a specified model/effort. Missing models are unavailable; do not change config or guess ids.',
        ...(onTheRelay
          ? {
              machine_note:
                "These targets run on this machine only. Agents on the desktop this laptop connects to (its Forge chats, Codex and Claude sessions) cannot be reached from here: ask the user to run that task on the desktop. Do not call the desktop relay's endpoints yourself; they load and unload the desktop's models.",
            }
          : {}),
      });
    },
  };
}
