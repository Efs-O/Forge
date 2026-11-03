import type { HostToWebview } from './messageBridge';
import { approvalLinesForChat, approvalEnvFor, resetChatApprovals } from './chatApprovalRules';
import { approvalPolicyLinesForWorkspace } from './approvalPolicyRules';
import type { ConversationRuntime } from './sessionTypes';
import type { ForgeConfig } from '../config/types';

interface ApprovalSlashCommandDeps {
  getActiveConv: () => ConversationRuntime;
  getConversations: () => ConversationRuntime[];
  getConfig: () => ForgeConfig;
  workspaceRoot?: string;
  getConfigPath?: () => string | undefined;
  persistSession: () => void | Promise<void>;
  post: (message: HostToWebview) => void;
  resetApprovals?: (conversationId: string) => Promise<boolean>;
}

/** The one slash-command entry for listing and resetting this chat's approvals. */
export async function handleApprovalsSlashCommand(
  deps: ApprovalSlashCommandDeps,
  action?: 'reset' | 'invalid',
): Promise<void> {
  const conversation = deps.getActiveConv();
  if (action === 'reset') {
    await resetApprovalsForConversation(deps, conversation.id);
    return;
  }
  if (action === 'invalid') {
    deps.post({
      type: 'notice',
      message: 'Usage: /approvals or /approvals reset',
      conversationId: conversation.id,
    });
    return;
  }
  const configPath = deps.getConfigPath?.();
  const { ctx } = approvalEnvFor({
    getConfig: deps.getConfig,
    ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
    ...(configPath ? { configPath } : {}),
  });
  const lines = [
    ...approvalLinesForChat(conversation.id, conversation),
    ...approvalPolicyLinesForWorkspace(deps.getConfig().approvals, deps.workspaceRoot, ctx),
  ];
  deps.post({
    type: 'notice',
    message: lines.length ? lines.join('\n') : 'No approvals in this chat.',
    conversationId: conversation.id,
    ...(lines.length ? { preformatted: true } : {}),
  });
}

/** Reset exactly the addressed chat, including approved fetch hosts, then save it. */
export async function resetApprovalsForConversation(
  deps: ApprovalSlashCommandDeps,
  conversationId: string,
): Promise<boolean> {
  let saved: boolean;
  try {
    if (deps.resetApprovals) {
      saved = await deps.resetApprovals(conversationId);
    } else {
      const conversation = deps.getConversations().find((item) => item.id === conversationId);
      if (!conversation) {
        deps.post({
          type: 'notice',
          message: 'Could not find that conversation to reset approvals.',
          conversationId,
          severity: 'warning',
        });
        return false;
      }
      resetChatApprovals(conversation);
      await deps.persistSession();
      saved = true;
    }
  } catch {
    saved = false;
  }
  deps.post(
    saved
      ? {
          type: 'notice',
          message: 'Approvals reset for this chat. The next gated call asks again.',
          conversationId,
        }
      : {
          type: 'error',
          message: 'Could not save the approval reset for this chat.',
          conversationId,
        },
  );
  return saved;
}
