import type { AgentSender } from '../agentLinks/chatAgentLinks';
import { formatMovedSessionNotice } from '../agentLinks/inboundAgentRouting';
import type { InboxMessageOptions, ChatTargetResult } from '../agentBus/agentInbox';
import type { AgentRoutesDeps } from './agentRoutes';
import { AgentRouteHttpError } from './agentRouteFields';

export async function admitInboundMessage(options: {
  from: string;
  sender?: AgentSender;
  messageOptions: InboxMessageOptions;
  deps: AgentRoutesDeps;
}): Promise<{
  messageOptions: InboxMessageOptions;
  target?: Extract<ChatTargetResult, { ok: true }>;
  pendingReplyId?: string;
  queuedBehindRunningTurn?: boolean;
}> {
  const { from, sender, deps } = options;
  let messageOptions = options.messageOptions;
  let target: Extract<ChatTargetResult, { ok: true }> | undefined;
  if (sender) {
    if (!deps.resolveInboundAgent || !deps.pendingReplies)
      throw new AgentRouteHttpError(404, 'inbound agent links are unavailable in this window');
    if (messageOptions.newChat && deps.chatCapBlockers) requireCapacity(deps, true);
    const running = messageOptions.toRunning
      ? deps.resolveChatTarget?.(from, { toRunning: true })
      : undefined;
    if (messageOptions.toRunning && (!running || !running.ok))
      throw new AgentRouteHttpError(409, running?.error ?? 'Forge chat targeting is unavailable');
    const routed = await deps.resolveInboundAgent(sender, {
      ...(messageOptions.conversationId ? { conversationId: messageOptions.conversationId } : {}),
      ...(running?.ok ? { runningConversationId: running.conversationId } : {}),
      ...(messageOptions.newChat ? { newChat: true } : {}),
    });
    target = { ok: true, conversationId: routed.conversationId, title: routed.title };
    const queuedBehindRunningTurn = deps.isChatBusy?.(target.conversationId) ?? false;
    messageOptions = {
      ...messageOptions,
      newChat: false,
      targetConversationId: routed.conversationId,
      sender: routed.sender,
    };
    if (routed.movedFrom)
      deps.showMovedNotice?.(
        routed.movedFrom.conversationId,
        formatMovedSessionNotice(sender.kind, routed.link, routed.title),
      );
    const workspace = deps.workspaceRoot;
    if (!workspace) throw new AgentRouteHttpError(500, 'workspace is unavailable');
    const pending = deps.pendingReplies.create(routed.sender, routed.conversationId, workspace);
    await deps.recordPendingAccepted?.(pending);
    messageOptions.pendingReplyId = pending.exchangeId;
    return { messageOptions, target, pendingReplyId: pending.exchangeId, queuedBehindRunningTurn };
  }
  if (deps.resolveChatTarget && !messageOptions.newChat) {
    const resolved = deps.resolveChatTarget(from, {
      ...(messageOptions.conversationId ? { conversationId: messageOptions.conversationId } : {}),
      ...(messageOptions.toRunning ? { toRunning: true } : {}),
    });
    if (!resolved.ok) throw new AgentRouteHttpError(resolved.status ?? 404, resolved.error);
    target = resolved;
    messageOptions = { ...messageOptions, targetConversationId: target.conversationId };
  } else if (messageOptions.conversationId || messageOptions.toRunning) {
    throw new AgentRouteHttpError(400, 'Forge chat targeting is unavailable in this window');
  }
  if (messageOptions.newChat && deps.chatCapBlockers) requireCapacity(deps, true);
  return { messageOptions, ...(target ? { target } : {}) };
}

function requireCapacity(deps: AgentRoutesDeps, activate: boolean): void {
  const blockers = deps.chatCapBlockers?.({ activate }) ?? [];
  if (blockers.length > 0)
    throw new AgentRouteHttpError(
      409,
      `Forge cannot open a new chat — ${blockers.join(', ')}. Close or archive a chat in that window, then send again. This message was not queued.`,
    );
}
