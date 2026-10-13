import type { BusTurnEnd, InboxMessageOptions } from '../agentBus/agentInbox';
import { BUS_TARGET_SCAN, busTargetConversation } from '../agentBus/busTarget';
import { parseForgeInboundPrompt } from '../agentBus/busContent';
import { agentDisplayName } from '../agentLinks/chatAgentLinks';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { unattendedConversations } from '../sidebar/unattendedConversations';

/** The conversation a bus message from `from` belongs in. */
export function busTarget(
  facade: ForgeHostFacade,
  from: string | undefined,
  targetConversationId?: string,
): string {
  if (targetConversationId) return targetConversationId;
  return busTargetConversation(from, facade.status(), (id) =>
    facade.recentExchanges(id, BUS_TARGET_SCAN),
  );
}

/** The loaded chat model; config.active_model can be stale while the sidebar is open. */
function currentLoadedModel(facade: ForgeHostFacade): string | undefined {
  const status = facade.status();
  const active = status.conversations.find(
    (conversation) => conversation.id === status.activeConversationId,
  );
  return active?.activeModel ?? undefined;
}

/** An explicit new chat becomes visible; follow-ups keep their addressed chat. */
export async function submitBusMessage(
  facade: ForgeHostFacade,
  prompt: string,
  options: InboxMessageOptions | undefined,
): Promise<BusTurnEnd> {
  let conversationId = busTarget(facade, options?.from, options?.targetConversationId);
  // Read before createConversation: it activates the new chat, whose model is
  // the stale config default this is meant to replace.
  const current = options?.newChat && !options.model ? currentLoadedModel(facade) : undefined;
  if (options?.newChat) {
    conversationId = (await facade.createConversation({ activate: true })).id;
  } else if (conversationId !== facade.status().activeConversationId) {
    await facade.restoreConversation(conversationId, { activate: false });
  }
  if (options?.model) {
    await facade.setConversationModel(conversationId, options.model);
  } else if (current) {
    // A --new without --model follows the model the user is actually talking
    // to (the active conversation's model — the currently loaded backend), not
    // the stale config active_model that createConversation defaults to. That
    // stale default opened a new chat on a different model and loading it
    // spawned a second server.
    await facade.setConversationModel(conversationId, current);
  }
  const inbound = parseForgeInboundPrompt(prompt);
  if (inbound || options?.sender) {
    // The agent-bus sender cannot see the user's Telegram chat. Reuse the
    // normal host-activity subscription so the already-addressed conversation
    // is durably mirrored to its bound remote chats before the Forge turn runs.
    facade.emitHostActivity?.({
      conversationId,
      ...(options?.sender ? { suppressProgress: true } : {}),
      text: options?.sender
        ? `${agentDisplayName(options.sender.kind)} (${options.sender.title}) says: ${(inbound?.text ?? prompt).split(/\n\nFrom (?:Claude|Codex|Copilot) session /u)[0]!.trim()}`
        : `Forge: ${inbound?.from} says:\n\n${inbound?.text}`,
    });
  }
  // The marker lasts exactly this turn, like a job's: the conversation is
  // attended again for whoever writes in it next.
  const marker = options?.unattended ? unattendedConversations.mark(conversationId) : undefined;
  let outcome: Awaited<ReturnType<ForgeHostFacade['send']>>;
  try {
    outcome = options?.sender
      ? await facade.send(conversationId, prompt, undefined, { sender: options.sender })
      : await facade.send(conversationId, prompt);
  } finally {
    marker?.dispose();
  }
  return outcome.kind === 'failed'
    ? {
        kind: 'failed',
        error: outcome.error,
        ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
      }
    : { kind: outcome.kind, ...(outcome.finalText ? { finalText: outcome.finalText } : {}) };
}
