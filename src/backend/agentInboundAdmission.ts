import type { AgentSender } from '../agentLinks/chatAgentLinks';
import {
  formatAlsoLinkedNotice,
  InboundAgentChatNotOpenError,
} from '../agentLinks/inboundAgentRouting';
import type { InboxMessageOptions, ChatTargetResult } from '../agentBus/agentInbox';
import type { AgentRoutesDeps } from './agentRoutesDeps';
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
    let routed: Awaited<ReturnType<NonNullable<AgentRoutesDeps['resolveInboundAgent']>>>;
    try {
      routed = await deps.resolveInboundAgent(sender, {
        ...(messageOptions.conversationId ? { conversationId: messageOptions.conversationId } : {}),
        ...(running?.ok ? { runningConversationId: running.conversationId } : {}),
        ...(messageOptions.newChat ? { newChat: true } : {}),
      });
    } catch (error) {
      if (error instanceof InboundAgentChatNotOpenError)
        throw new AgentRouteHttpError(404, error.message);
      throw error;
    }
    target = { ok: true, conversationId: routed.conversationId, title: routed.title };
    // A `--new` from a linked session opened its chat through `resolveInboundAgent`,
    // which never passes `openBusChat`, so this is where it gets Clanker. Read
    // `newChat` here: the next block is what clears it.
    if (messageOptions.newChat) deps.armBusChat?.(routed.conversationId, from);
    const queuedBehindRunningTurn = deps.isChatBusy?.(target.conversationId) ?? false;
    messageOptions = {
      ...messageOptions,
      newChat: false,
      targetConversationId: routed.conversationId,
      sender: routed.sender,
    };
    if (routed.alsoLinkedFrom)
      deps.showAlsoLinkedNotice?.(
        routed.alsoLinkedFrom.conversationId,
        formatAlsoLinkedNotice(sender.kind, routed.link, routed.title),
      );
    const workspace = deps.workspaceRoot;
    if (!workspace) throw new AgentRouteHttpError(500, 'workspace is unavailable');
    const pending = deps.pendingReplies.create(routed.sender, routed.conversationId, workspace);
    await deps.recordPendingAccepted?.(pending);
    deps.dropRecoveryReplyRoute?.(target.conversationId);
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
  // A `--new` that this window can open right now: doing it here is what lets
  // the 202 name the chat, and lets a pin failure answer 409 with that chat's
  // id while nothing was queued — the same order `message_chat action=new` uses
  // locally, so a worker opened from next door behaves like one opened here.
  if (messageOptions.newChat && deps.openBusChat) {
    const opened = await deps.openBusChat({
      sender: from,
      ...(messageOptions.model ? { model: messageOptions.model } : {}),
      ...(messageOptions.title ? { title: messageOptions.title } : {}),
    });
    if (!opened.ok)
      throw new AgentRouteHttpError(
        409,
        `The new chat ${opened.id} was opened but could not be pinned to ${messageOptions.model}: ${opened.error}. Nothing was queued; close that chat, or pin it by hand and send again.`,
      );
    target = { ok: true, conversationId: opened.id, title: opened.title };
    // Opened now, so the drain delivers into it instead of opening a second one,
    // and the pin is done — asking for the same model again would be a second
    // engine request for the chat this message has not started yet. `newChat`
    // stays set on purpose: it is what tells the inbox this message still needs a
    // turn of its own, so a turn that starts in the new chat before this one is
    // admitted cannot swallow it as a mid-turn tell.
    messageOptions = { ...messageOptions, targetConversationId: opened.id };
    delete messageOptions.model;
  }
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
