import * as path from 'path';
import { busPaths } from '../agentBus/agentBus';
import type { BusTurnEnd, ChatTargetSelection, InboxMessageOptions } from '../agentBus/agentInbox';
import { BUS_TARGET_SCAN, busTargetConversation } from '../agentBus/busTarget';
import { parseForgeInboundPrompt } from '../agentBus/busContent';
import { EXCHANGES_LOG_NAME, readEvents } from '../agentMesh/exchangeLog';
import { agentDisplayName, type AgentSenderMetadata } from '../agentLinks/chatAgentLinks';
import { availableProfilesFor } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import { inNewChatPrologueLock } from '../sidebar/newChatPrologue';
import { getLogger } from '../util/logger';

const log = getLogger();

/** The chat a bus exchange belongs to, from the exchange ledger. */
export function exchangeConversationFromLedger(exchangeId: string): string | undefined {
  const events = readEvents(path.join(busPaths().root, EXCHANGES_LOG_NAME));
  return events.find((event) => event.exchangeId === exchangeId && event.conversation)
    ?.conversation;
}

/** Resolve the chat a Forge-directed bus message will enter. */
export function resolveBusMessageTarget(
  facade: ForgeHostFacade,
  from: string,
  selection: ChatTargetSelection,
  exchangeConversation?: (id: string) => string | undefined,
):
  | { ok: true; conversationId: string; title: string }
  | { ok: false; status: 404 | 409; error: string } {
  const status = facade.status();
  let conversationId: string;
  if (selection.conversationId) {
    conversationId = selection.conversationId;
  } else if (selection.toRunning) {
    const streaming = status.streamingConversationIds;
    if (streaming.includes(status.activeConversationId)) {
      conversationId = status.activeConversationId;
    } else if (streaming.length === 1) {
      conversationId = streaming[0] as string;
    } else if (streaming.length === 0) {
      return { ok: false, status: 409, error: 'Forge has no running chat to target' };
    } else {
      return {
        ok: false,
        status: 409,
        error: 'Forge has multiple running chats; use --to <conversationId>',
      };
    }
    if (!streaming.includes(conversationId)) {
      return { ok: false, status: 409, error: 'the selected Forge chat is not running' };
    }
  } else {
    conversationId = busTarget(facade, from);
  }
  const conversation = status.conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.archived) {
    // A verdict file is named after the exchange, so its id is the one a peer
    // has to hand; "no longer open" sent one to a fresh chat instead.
    const owner =
      !conversation && selection.conversationId
        ? exchangeConversation?.(conversationId)
        : undefined;
    return {
      ok: false,
      status: 404,
      error: owner
        ? `"${conversationId}" is an exchange id, not a chat id: its chat is --to ${owner}`
        : `Forge chat "${conversationId}" is no longer open`,
    };
  }
  return { ok: true, conversationId, title: conversation.title };
}

type StreamingBusTarget =
  | { ok: true; conversationId: string; title: string }
  | { ok: false; status: 400 | 409; error: string };

/** Resolve a sender's target and require a running turn for stop or steer. */
function resolveStreamingBusTarget(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): StreamingBusTarget {
  const target = resolveBusMessageTarget(
    facade,
    from,
    { ...(targetConversationId ? { conversationId: targetConversationId } : {}) },
    exchangeConversationFromLedger,
  );
  if (!target.ok) return { ok: false, status: 400, error: target.error };
  if (!facade.status().streamingConversationIds.includes(target.conversationId)) {
    return {
      ok: false,
      status: 409,
      error: `Forge chat "${target.title}" (${target.conversationId}) is not streaming`,
    };
  }
  return { ok: true, conversationId: target.conversationId, title: target.title };
}

/** Interrupt only the chat the sender's message will be routed to. */
export async function interruptForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): Promise<
  { steered: true; conversationId: string; title: string } | { steered: false; reason: string }
> {
  const target = resolveStreamingBusTarget(facade, from, targetConversationId);
  if (!target.ok) return { steered: false, reason: target.error };
  await facade.interrupt(target.conversationId);
  return {
    steered: true,
    conversationId: target.conversationId,
    title: target.title,
  };
}

/** Cancel the addressed turn with the same target selection as bus messages and steers. */
export async function stopForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
): Promise<StreamingBusTarget> {
  const target = resolveStreamingBusTarget(facade, from, targetConversationId);
  if (!target.ok) return target;
  // Audit F5: `POST /agent/stop` did not answer within the caller's bound while
  // a delegated Codex request was in flight. `facade.cancel` awaits the turn
  // *settling* (`TurnLifecycle.stopStreaming` waits on the promise a turn
  // resolves when it unwinds), so a tool that does not honor its abort keeps
  // the HTTP response open with it — and the sender could not even learn that
  // its stop had been accepted. The abort itself happens synchronously inside
  // `cancel`, and it is the whole of what Stop can promise, so the answer goes
  // out then and the turn is left to unwind at its own speed.
  const unwinding = facade.cancel(target.conversationId);
  void unwinding.catch((error: unknown) => {
    log.warn(
      `Stop of "${target.title}" (${target.conversationId}) could not finish unwinding: ${String(error)}`,
    );
  });
  return target;
}

/** Every model, each `model@profile` it offers, and every alias key: the ids a bus sender may name. */
export function busModelIds(config: ForgeConfig): string[] {
  return [
    ...config.models.flatMap((model) => [
      model.name,
      ...availableProfilesFor(config, model.name).map((profile) => `${model.name}@${profile}`),
    ]),
    ...Object.keys(config.aliases ?? {}),
  ];
}

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

/** The one Telegram activity line for bus prompts, whether queued or immediate. */
export function busMessageActivityText(
  prompt: string,
  sender?: AgentSenderMetadata,
): string | undefined {
  const inbound = parseForgeInboundPrompt(prompt);
  if (sender) {
    const message = (inbound?.text ?? prompt)
      .split(/\n\nFrom (?:Claude|Codex|Copilot) session /u)[0]!
      .trim();
    return `${agentDisplayName(sender.kind)} (${sender.title}) says: ${message}`;
  }
  return inbound ? `Forge: ${inbound.from} says:\n\n${inbound.text}` : undefined;
}

/**
 * `--new` uses the configured default pinned by `createConversation`. The lock
 * is shared with `message_chat action=new`, so concurrent creators cannot
 * observe and overwrite one another's selection. Only an explicit `--model`
 * changes the configured default for this new chat.
 */

/** An explicit new chat becomes visible; follow-ups keep their addressed chat. */
export async function submitBusMessage(
  facade: ForgeHostFacade,
  prompt: string,
  options: InboxMessageOptions | undefined,
): Promise<BusTurnEnd> {
  let conversationId: string;
  if (options?.newChat) {
    const wanted = options.model;
    conversationId = await inNewChatPrologueLock(async () => {
      const created = (await facade.createConversation({ activate: true })).id;
      if (wanted) await facade.setConversationModel(created, wanted);
      return created;
    });
  } else {
    const target = busTarget(facade, options?.from, options?.targetConversationId);
    conversationId = target;
    if (target !== facade.status().activeConversationId) {
      await facade.restoreConversation(target, { activate: false });
    }
    if (options?.model) await facade.setConversationModel(target, options.model);
  }
  const inbound = parseForgeInboundPrompt(prompt);
  if (inbound || options?.sender) {
    // The agent-bus sender cannot see the user's Telegram chat. Reuse the
    // normal host-activity subscription so the already-addressed conversation
    // is durably mirrored to its bound remote chats before the Forge turn runs.
    const text = busMessageActivityText(prompt, options?.sender);
    if (text) {
      facade.emitHostActivity?.({
        conversationId,
        ...(options?.sender ? { suppressProgress: true } : {}),
        text,
      });
    }
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
