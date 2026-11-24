/**
 * A message addressed to Forge: admitted into this window's inbox, steered when
 * asked, and answered with the 202 the sender reads.
 *
 * Split out of `agentRoutes.ts` because this is the only inbound branch that is
 * a transaction rather than a delegation — admission, the pre-accept steer
 * guard, `accept` with `hold`, the `interruptForge` backstop, `release`, and the
 * rollback that takes back a pending reply or a queued message on every failure
 * path. The router keeps the route table, the token gate and the sender
 * validation the other branches share, and calls here once: awaited, so an
 * `AgentRouteHttpError` thrown here still reaches the router's status mapping.
 */
import type * as http from 'http';
import { MAX_INBOUND_CHARS, forgeInboundPrompt } from '../agentBus/busContent';
import type { AgentInbox, InboxMessageOptions } from '../agentBus/agentInbox';
import type { AgentSender } from '../agentLinks/chatAgentLinks';
import {
  AgentRouteHttpError as HttpError,
  requireText,
  type AgentRouteFields,
} from './agentRouteFields';
import { parseAgentMessageOptions, parseFromConversation } from './agentMessageOptions';
import { admitInboundMessage } from './agentInboundAdmission';
import { noticesForSender, sendJsonWithWaitingVerdicts } from './agentWaitingVerdicts';
import type { AgentRoutesDeps } from './agentRoutesDeps';

/**
 * Deliver one inbound message to a Forge chat. `from` and `sender` arrive
 * already validated by the router, which is also where a thrown
 * `AgentRouteHttpError` becomes the response the sender reads.
 */
export async function sendForgeInboundMessage(
  res: http.ServerResponse,
  input: {
    fields: AgentRouteFields;
    from: string;
    sender?: AgentSender;
    deps: AgentRoutesDeps;
  },
): Promise<void> {
  const { fields, from, sender: declaredSender, deps } = input;
  const text = requireText(fields, MAX_INBOUND_CHARS);
  const steerForge =
    (typeof fields['priority'] === 'string' ? fields['priority'] : '').trim().toLowerCase() ===
    'steer';
  // A window that cannot interrupt cannot steer. Said here, before anything
  // is queued, because the answer it would otherwise give is the one a plain
  // send gives — "queued" — and the sender would report an interruption that
  // nothing here was ever going to make.
  if (steerForge && !deps.interruptForge)
    throw new HttpError(409, 'this window cannot steer a Forge chat. Nothing was queued.');
  const steerEpochField =
    typeof fields['steer_epoch'] === 'string' ? fields['steer_epoch'].trim() : '';
  if (steerForge && steerEpochField !== '' && !Number.isInteger(Number(steerEpochField)))
    throw new HttpError(400, 'steer_epoch must be an integer when it is sent');
  const fromConversation = parseFromConversation(fields);
  const admission = await admitInboundMessage({
    from,
    ...(declaredSender ? { sender: declaredSender } : {}),
    messageOptions: forgeMessageOptions(fields, deps),
    deps,
  });
  const options = admission.messageOptions;
  const target = admission.target;
  const pendingReplyId = admission.pendingReplyId;
  const queuedBehindRunningTurn = admission.queuedBehindRunningTurn ?? false;
  // A steer is refused before anything is queued, and its last check runs
  // AFTER admission with the queue holding the message unstarted until it
  // passes: `accept` can start the drain in the same tick, so a message
  // cancelled after the answer came back is not reliably withdrawn — it may
  // already be the turn this one meant to replace. `steer_epoch` is the
  // chain the sender read, so a steer written against a turn that has since
  // been followed by the owner's own message is refused rather than
  // interrupting the newer work. A steer whose chat cannot be named, or
  // with no guard to check it against, is refused here while nothing is
  // queued: after acceptance no answer could honestly say "nothing was
  // queued".
  let expectedEpoch: number | undefined;
  if (steerForge) {
    expectedEpoch = steerEpochField === '' ? undefined : Number(steerEpochField);
    if (target === undefined || deps.steerGuard === undefined)
      throw new HttpError(
        409,
        'this window cannot say which chat a steer would reach. Nothing was queued.',
      );
    const refusal = await deps.steerGuard(target.conversationId, target.title, expectedEpoch);
    if (refusal) {
      if (pendingReplyId) deps.pendingReplies?.remove(pendingReplyId);
      throw new HttpError(409, `${refusal}. Nothing was queued.`);
    }
  }
  let accepted: ReturnType<AgentInbox['accept']>;
  try {
    accepted = deps.inbox.accept(
      forgeInboundPrompt(
        from,
        text,
        options.sender,
        // Only a sender whose session this window can reach live is promised
        // an automatic answer; the rest are pointed at `read-verdict`.
        options.sender ? (deps.senderIsLive?.(options.sender) ?? true) : true,
      ),
      from,
      steerForge,
      steerForge ? { ...options, hold: true } : options,
    );
  } catch (error) {
    if (pendingReplyId) deps.pendingReplies?.remove(pendingReplyId);
    throw error;
  }
  if (accepted === undefined) {
    if (pendingReplyId) deps.pendingReplies?.remove(pendingReplyId);
    // A `--new` opened its chat before the inbox was asked, so the refusal
    // has to name what it left behind: an empty chat nobody told the owner
    // about is a tab they cannot find, and a retry opens a second one.
    throw new HttpError(
      429,
      `Forge has too many unread agent messages${
        target
          ? `. The new chat "${target.title}" (${target.conversationId}) is open and empty; close it, or clear the inbox and send again`
          : ''
      }.`,
    );
  }
  const { position: queued, id } = accepted;
  if (fromConversation && target) {
    deps.recordPeerWriter?.(target.conversationId, { id: fromConversation, title: from });
  }
  if (steerForge) {
    let outcome: Awaited<ReturnType<NonNullable<typeof deps.interruptForge>>>;
    try {
      // The backstop carries the epoch the sender read: a chain that moved
      // between the guard and here is caught while the held message has
      // still never run, so taking it back is a guaranteed withdrawal.
      outcome = (await deps.interruptForge?.(from, target?.conversationId, expectedEpoch)) ?? {
        steered: false as const,
        reason: 'no Forge turn was stopped',
      };
    } catch (error) {
      deps.inbox.cancel(from, id);
      if (pendingReplyId) deps.pendingReplies?.remove(pendingReplyId);
      throw error;
    }
    // Nothing was interrupted, so this message does not belong in the
    // inbox either: it would land in front of a turn the owner has not
    // answered. The queue never started it, so taking it back is certain.
    if (!outcome.steered && outcome.blocked) {
      deps.inbox.cancel(from, id);
      if (pendingReplyId) deps.pendingReplies?.remove(pendingReplyId);
      throw new HttpError(409, `${outcome.reason}. Nothing was queued.`);
    }
    // The last guard has passed: the held message may now start, in the
    // lane the interrupted turn is freeing.
    deps.inbox.release(id);
    return sendJsonWithWaitingVerdicts(
      res,
      202,
      { queued, id, ...outcome },
      noticesForSender(deps.waitingVerdicts, declaredSender?.sessionId),
    );
  }
  return sendJsonWithWaitingVerdicts(
    res,
    202,
    {
      queued,
      id,
      ...(target ? { conversationId: target.conversationId, title: target.title } : {}),
      ...(pendingReplyId ? { exchangeId: pendingReplyId } : {}),
      ...(pendingReplyId && target
        ? {
            receipt: `Forge received your message (chat "${target.title}")${queuedBehindRunningTurn ? ' — queued behind the running turn' : ''}`,
          }
        : {}),
    },
    noticesForSender(deps.waitingVerdicts, declaredSender?.sessionId),
  );
}

/** The inbound message options, with `model` refused unless this window has it. */
function forgeMessageOptions(fields: AgentRouteFields, deps: AgentRoutesDeps): InboxMessageOptions {
  const parsed = parseAgentMessageOptions(fields);
  const validModels = [...(deps.configuredModels?.() ?? [])];
  if (parsed.model && !validModels.includes(parsed.model)) {
    throw new HttpError(
      400,
      `model: unknown model "${parsed.model}"; valid models: ${validModels.join(', ') || '(none configured)'}`,
    );
  }
  return parsed;
}
