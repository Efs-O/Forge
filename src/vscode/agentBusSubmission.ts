import * as path from 'path';
import { busPaths } from '../agentBus/agentBus';
import type {
  BusTurnEnd,
  ChatTargetSelection,
  ForgeSteerResult,
  InboxMessageOptions,
} from '../agentBus/agentInbox';
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

/** Resolve a sender's target and require a running turn — what `stop` needs.
 *  A steer does NOT use this: it must answer for an idle chat (its message
 *  may simply run) and refuse for a closed one, so it checks these states in
 *  its own order, guard first. */
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

/** Why this steer cannot run now, as the sentence its sender reads, or nothing
 *  when it may. Asked twice on purpose: once before the message is accepted,
 *  where a refusal costs the inbox nothing, and again before the interrupt,
 *  because the queue can start a turn while the answer is on its way back.
 *
 *  Two things stop a steer here. A card the owner has not answered: interrupting
 *  would take that answer away, and the sender checked a chat list it read a tool
 *  round ago. And a chain the sender never saw: `expectedEpoch` is the chain its
 *  message was written against, and a different one means the owner, or a reply,
 *  has since put that chat on new work this steer would interrupt instead. */
export function steerBlockReason(
  facade: ForgeHostFacade,
  conversationId: string,
  title: string,
  expectedEpoch?: number,
): string | undefined {
  const status = facade.status();
  const approval = status.pendingApproval;
  if (
    approval &&
    (approval.conversationId === undefined || approval.conversationId === conversationId)
  )
    return `Forge chat "${title}" is waiting for the owner's approval`;
  const chain = status.requestChains.find((entry) => entry.conversationId === conversationId);
  if (expectedEpoch !== undefined && chain !== undefined && chain.userIntentEpoch !== expectedEpoch)
    return (
      `Forge chat "${title}" is on a different chain now ` +
      `(epoch ${chain.userIntentEpoch}, you read ${expectedEpoch}); read it again before steering`
    );
  return undefined;
}

/** Interrupt only the chat the sender's message will be routed to. The
 *  `expectedEpoch` is the chain the sender read: the guard already ran before
 *  admission, and it runs again here because the queue holds the steer
 *  unstarted until this returns — a chain that moved in between still costs
 *  nothing, because the queue could not have started the message yet. */
export async function interruptForgeForSender(
  facade: ForgeHostFacade,
  from: string,
  targetConversationId?: string,
  expectedEpoch?: number,
): Promise<ForgeSteerResult> {
  const resolved = resolveBusMessageTarget(
    facade,
    from,
    { ...(targetConversationId ? { conversationId: targetConversationId } : {}) },
    exchangeConversationFromLedger,
  );
  // A chat the sender's message will not reach — closed, or no longer
  // resolvable — is a refusal, not an idle turn: the held message must come
  // back, or it would land in a chat nobody can see. This check runs BEFORE
  // the streaming test, as does the guard below: a target that stopped
  // streaming mid-request must not skip the checks the first guard ran.
  if (!resolved.ok) return { steered: false, blocked: true, reason: resolved.error };
  // The window that owns the chat answers for the card that is actually out,
  // not for the one the sender's chat list described a request ago — and for
  // the chain the sender read, not one that has since moved on.
  const blocked = steerBlockReason(facade, resolved.conversationId, resolved.title, expectedEpoch);
  if (blocked)
    return {
      steered: false,
      blocked: true,
      reason: blocked,
    };
  // Only now is idle different from busy: an idle chat has nothing to
  // interrupt, but the steer is a message too, and the route releases it to
  // run as its own turn.
  if (!facade.status().streamingConversationIds.includes(resolved.conversationId))
    return {
      steered: false,
      reason: `Forge chat "${resolved.title}" (${resolved.conversationId}) is not streaming`,
    };
  await facade.interrupt(resolved.conversationId);
  return {
    steered: true,
    conversationId: resolved.conversationId,
    title: resolved.title,
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

/** Open, pin and name the chat a bus `--new` runs in, under the prologue lock
 *  `message_chat action=new` shares. One owner for the three sidebar calls so a
 *  route that answers a 202 naming that chat and the drain that delivers into it
 *  cannot drift apart — and so a pin that fails can be answered with the id of
 *  the chat it left behind, which a throw loses. */
export async function openBusChat(
  facade: ForgeHostFacade,
  options: { model?: string; title?: string } = {},
): Promise<{ ok: true; id: string; title: string } | { ok: false; id: string; error: string }> {
  return inNewChatPrologueLock(async () => {
    const created = await facade.createConversation({ activate: true });
    if (options.model) {
      try {
        await facade.setConversationModel(created.id, options.model);
      } catch (error) {
        return {
          ok: false as const,
          id: created.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      ok: true as const,
      id: created.id,
      title:
        options.title && facade.applyAutoTitle?.(created.id, options.title)
          ? options.title
          : created.title,
    };
  });
}

/** An explicit new chat becomes visible; follow-ups keep their addressed chat. */
export async function submitBusMessage(
  facade: ForgeHostFacade,
  prompt: string,
  options: InboxMessageOptions | undefined,
): Promise<BusTurnEnd> {
  let conversationId: string;
  if (options?.newChat && !options.targetConversationId) {
    // A `--new` whose chat already exists — opened by admission so the 202 could
    // name it — is delivered below, not created twice.
    const opened = await openBusChat(facade, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.title ? { title: options.title } : {}),
    });
    if (!opened.ok) {
      throw new Error(
        `the new chat ${opened.id} was opened but could not be pinned to ${options.model}: ${opened.error}`,
      );
    }
    conversationId = opened.id;
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
  const job =
    options?.jobId !== undefined && options.jobName !== undefined
      ? { jobId: options.jobId, jobName: options.jobName }
      : undefined;
  const marker =
    options?.unattended && !unattendedConversations.has(conversationId)
      ? unattendedConversations.mark(conversationId, job)
      : undefined;
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
