/**
 * Running a `message_chat` action against a chat in ANOTHER Forge window.
 *
 * The local actions deliver through the sidebar; a peer action delivers through
 * that window's own `/agent/message` route, so what has to be reproduced is not
 * the delivery but the DECISIONS: the same caps, the same refusals, the same
 * rollback when a delivery turns out not to have happened. Those come from
 * `messageChatShared.ts` unchanged, keyed by the target's chat id — chat ids are
 * UUIDs shared across windows, so a supervisor that spent five of its six idle
 * wakes on a neighbour's chats has five left here too.
 *
 * What is genuinely different, and stated in each action below:
 * - the bus will not carry more than `PEER_MESSAGE_LIMIT` characters, which is
 *   less than a local message may be, so the refusal happens before any request;
 * - a 202 means "queued", never "a turn started": the receiving window admits it
 *   on its own schedule, so there is nothing to wait for and nothing to retry;
 * - the request always names its chat by id, because a peer request that relied
 *   on sender-name routing would interrupt whoever else holds that name.
 */

import { clipMirroredPrompt } from '../sidebar/turnMirrorWiring';
import {
  chatLabel,
  folderName,
  getPeerView,
  PEER_MESSAGE_LIMIT,
  peerPrompt,
  postPeerMessage,
  refreshPeerChat,
  type PeerChatRef,
  type PeerWindow,
} from './messageChatPeers';
import { renderChatView } from './messageChatActions';
import { MAX_VIEW_COUNT } from '../remote/RemoteTranscriptView';
import type { SteerContext } from './messageChatSteer';
import {
  atText,
  messageChatSendLimit,
  MESSAGE_CHAT_WINDOW_MINUTES,
  MESSAGE_CHAT_WINDOW_MS,
  nextAllowedAt,
  pruneMessageChatWindow,
  recordAction,
  rollbackAction,
  unclaimedSendRefusal,
  type DeliveryOutcome,
  type MessageChatActionContext,
  type MessageChatDeliveryResult,
} from './messageChatShared';

/** What a peer action needs, and nothing the local actions do not already
 *  carry: the same context, plus the peer chat and the folder this window is
 *  open on (the prompt names it, so the other chat knows where to answer). */
export interface PeerActionContext extends Omit<MessageChatActionContext, 'formatMessage'> {
  target: PeerChatRef;
  selfWorkspace: string;
}

/** How a peer chat is named back to the caller. `formatChatName` prints a tab
 *  number, and a chat in another window has no tab here — the workspace is the
 *  thing that tells the two apart, so it is quoted in full: two folders can
 *  share a basename, and a paid turn sent to the wrong one is not a mistake the
 *  caller can spot from a folder name. */
export function peerName(target: PeerChatRef): string {
  return `"${target.title}" in ${target.peer.workspace}`;
}

/** Carry the sender's unattended marker only for a turn that starts remotely. */
function peerUnattendedFields(
  input: Pick<PeerActionContext, 'unattended'>,
): Record<string, string> {
  if (!input.unattended) return {};
  return {
    unattended: 'true',
    ...(input.unattended.job
      ? { job_id: input.unattended.job.jobId, job_name: input.unattended.job.jobName }
      : {}),
  };
}

/** The one refusal shape every peer failure shares: what the other window said,
 *  that nothing was delivered, and what to do instead of resending. A 401 is the
 *  one case worth naming, because the caller cannot tell it from a dead window:
 *  two windows that were not started from the same bus folder look identical.
 *  Every other status arrives with the peer's own reason, already in `error`. */
function peerRefusal(name: string, error: string, status: number): string {
  const where =
    status === 401 || status === 403
      ? ' — this window holds a token that window refused, so the two are not sharing one agent-bus folder'
      : '';
  return `Error: ${name} did not accept the message: ${error}${where}. Nothing was queued and no counter was used; retry later, or pick another chat.`;
}

/** The text a peer window is handed, or the refusal when it will not fit. It
 *  needs no target: what travels is the sender header and the message, and the
 *  budget is measured on those alone — a `new` has no chat to name yet. The
 *  receiving window caps the whole body it is given, and that cap includes the
 *  sender header, so the number quoted here is the budget the header leaves —
 *  measured in characters, the way that route measures it. */
function peerBody(
  input: Pick<PeerActionContext, 'selfId' | 'sender' | 'selfWorkspace' | 'message'>,
): { body: string } | { refusal: string } {
  const body = peerPrompt(
    { id: input.selfId, title: input.sender.title },
    input.selfWorkspace,
    input.message,
  );
  if (body.length <= PEER_MESSAGE_LIMIT) return { body };
  const header = body.length - input.message.length;
  const budget = PEER_MESSAGE_LIMIT - header;
  const parts = Math.ceil(input.message.length / Math.max(budget, 1));
  return {
    refusal:
      `Error: a message to another window fits ${PEER_MESSAGE_LIMIT} characters in total, including the sender header this one adds (${header}), so yours has room for ${budget} of the ${input.message.length} you wrote. ` +
      `Send at most ${budget} characters, or split it into ${parts} messages; nothing was queued and no counter was used.`,
  };
}

/** The message may be sitting in the other window's inbox and this window cannot
 *  tell: the counters stay burned, because a second send would pay for the same
 *  report twice, and the caller is sent to look instead of to resend. */
function uncertainPeerSend(name: string, why: string): string {
  return (
    `Error: ${name} did not confirm the message (${why}). It may already be queued there, so do not resend: ` +
    'check with `list` or `view` before sending anything else to that chat. The send stays counted against your caps.'
  );
}

/**
 * `send` to a chat in another window: post it and report that it is queued.
 *
 * The counters are burned before the request rather than after the answer, so a
 * model that retries a slow peer cannot get ahead of the caps; what happens to
 * them then splits three ways, because the three answers mean different things.
 * A 202 is the documented acceptance: keep them. A refusal that came back before
 * the message could have been taken (`ECONNREFUSED`, a 4xx) is proof nothing was
 * queued: give them back and say resend freely. Anything else — the deadline, a
 * reset socket, a 2xx that is not the documented 202 — is an answer lost after
 * the bytes left, which cannot be told from a window that queued the message and
 * then died: keep them, and say do not resend. Getting that last one wrong costs
 * the owner a second paid turn in a chat they are paying for either way.
 */
export async function peerSend(input: PeerActionContext): Promise<string> {
  const { target, window, at, sender, signal } = input;
  pruneMessageChatWindow(window, at);
  const name = peerName(target);
  // A closed chat is readable but not deliverable to, here exactly as locally.
  if (target.closed) {
    return input.refuse(
      `Error: ${name} is a closed chat: \`view\` can read it, \`send\` cannot. Nothing was queued and no counter was used.`,
    );
  }
  // What goes over the socket is the sender header plus the message, and the
  // receiving window caps the whole of it.
  const text = peerBody(input);
  if ('refusal' in text) return input.refuse(text.refusal);
  const idleWake = !target.running;
  const sendLimit = messageChatSendLimit(window, idleWake);
  if (sendLimit) return input.refuse(sendLimit);
  const unclaimed = unclaimedSendRefusal(window, target.id, name);
  if (unclaimed) return input.refuse(unclaimed);

  recordAction(window, at, idleWake, false, false);
  const answer = await postPeerMessage(
    target.peer,
    // The chat id is the whole point of the request: without it the receiving
    // window would fall back to routing by sender name.
    {
      conversation_id: target.id,
      from_conversation: input.selfId,
      from: chatLabel(sender.title),
      ...peerUnattendedFields(input),
    },
    text.body,
    signal,
  );
  if (!answer.ok) {
    if (answer.uncertain) return input.refuse(uncertainPeerSend(name, answer.error));
    rollbackAction(window, at, idleWake, false, false);
    return input.refuse(peerRefusal(name, answer.error, answer.status));
  }
  // 202 is the only answer that means "in the inbox": a 200 from some other
  // route, or a proxy answering for the window, is not an acceptance.
  if (answer.status !== 202) {
    return input.refuse(uncertainPeerSend(name, `it answered ${answer.status} instead of 202`));
  }

  // The receiving window mirrors an inbound message into its own chat already,
  // so the only line this window can draw is the sender's own "out" one.
  input.emitActivity(
    input.selfId,
    input.formatMirrorLine(
      'out',
      target.title,
      target.running ? 'tell' : undefined,
      clipMirroredPrompt(input.message),
    ),
  );
  // No unclaimed mark: that mark waits for a local delivery promise to settle,
  // and a 202 has no such promise. Marking it would block this target for an
  // hour on a send the other window already accepted.
  return (
    `Queued in ${target.peer.workspace} — "${target.title}" (` +
    (target.running
      ? 'running, so it reads this at a tool round'
      : 'idle, so a turn starts there') +
    '). Do not resend; check with `list` or `view` later.'
  );
}

/** What `peerSteer` needs beyond a send: the tool's one steer action, with its
 *  per-target cooldown and its loop map in the closure. A cross-window steer
 *  shares those with the local ones, so steering the same chat twice inside two
 *  minutes is refused whichever window the second one came from. */
export interface PeerSteerContext extends PeerActionContext {
  steerAction: (input: SteerContext) => Promise<string>;
}

/**
 * `steer` a chat in another window: ask that window to stop what it is doing and
 * run this text next.
 *
 * Everything hard about a steer — the cooldown, the loop guard, the refusal while
 * the owner is being asked something, the rollback when nothing was delivered —
 * is `messageChatSteer`'s, and it runs here unchanged on the peer's own report of
 * that chat. What this adds is the refresh: the caller's chat list may be several
 * tool calls old, and the point of a steer is to interrupt a turn that is still
 * happening.
 */
export async function peerSteer(input: PeerSteerContext): Promise<string> {
  const { steerAction, ...rest } = input;
  const { signal, sender } = input;
  const fresh = await refreshPeerChat(input.target.peer, input.target.id, signal);
  if (!fresh) {
    return input.refuse(
      `Error: "${input.target.title}" in ${input.target.peer.workspace} is not answering, or no longer holds that chat. Nothing was queued and no counter was used.`,
    );
  }
  if (fresh.closed) {
    return input.refuse(
      `Error: ${peerName(fresh)} is a closed chat: \`view\` can read it, \`steer\` cannot. Nothing was queued and no counter was used.`,
    );
  }
  const name = peerName(fresh);
  const peer = fresh.peer;
  // The same body cap as a send, because the same route reads it — and the same
  // prompt, so a steered chat also knows who to answer.
  const text = peerBody(input);
  if ('refusal' in text) return input.refuse(text.refusal);
  const outcome = await steerAction({
    ...rest,
    target: fresh,
    formatMessage: () => text.body,
    // The loop guard forgets a chat this window can no longer see mid-turn. For a
    // peer, the fresh report is the only witness, and it names just this chat —
    // so it is allowed to forget just this chat, and nothing else.
    activeIds: new Set(fresh.running ? [fresh.id] : []),
    readScope: 'target',
    deliver: async (text, conversationId): Promise<DeliveryOutcome> => {
      const answer = await postPeerMessage(
        peer,
        // `priority=steer` is what makes the receiving window stop its turn and
        // put this message at the front of the queue; `conversation_id` is what
        // makes sure it is THIS chat whose turn it stops.
        {
          conversation_id: conversationId,
          from_conversation: input.selfId,
          from: chatLabel(sender.title),
          priority: 'steer',
          // The chain this decision was made against. The receiving window
          // refuses the steer if that chat has moved on to newer work, instead of
          // interrupting something this window was never told about.
          ...(fresh.userIntentEpoch === undefined
            ? {}
            : { steer_epoch: String(fresh.userIntentEpoch) }),
        },
        text,
        signal,
      );
      if (!answer.ok) {
        return answer.uncertain
          ? { kind: 'refused', error: answer.error, uncertain: true }
          : { kind: 'refused', error: answer.error };
      }
      if (answer.status !== 202) {
        return {
          kind: 'refused',
          error: `it answered ${answer.status} instead of 202`,
          uncertain: true,
        };
      }
      // The window answers whether it stopped a turn, and only with a real
      // boolean: `"false"`, `null` or a missing field cannot be read as either
      // outcome, because the sender cannot tell an interruption from a message
      // that queued behind a running turn.
      const steered = (answer.value as { steered?: unknown }).steered;
      if (typeof steered !== 'boolean') {
        return {
          kind: 'refused',
          error: 'it answered 202 without saying whether your turn was interrupted',
          uncertain: true,
        };
      }
      // `false` is not a failure: that window says nothing was stopped, so this
      // message starts a turn there — and the wake reserved for it stands. When
      // it says `true` the chat was busy, and the steer action hands the reserved
      // wake back.
      return steered ? { kind: 'tell' } : { kind: 'turn' };
    },
    // Only this chat's own transcript is drawn here; the receiving window mirrors
    // an inbound steering message into its own chat already.
    emitActivity: (conversationId, text) => {
      if (conversationId === input.selfId) input.emitActivity(conversationId, text);
    },
    formatResult: (result: MessageChatDeliveryResult) =>
      result.kind === 'tell'
        ? `Interrupted ${name}: its turn was stopped and your steering message runs next, at the front of its queue. Do not resend.`
        : result.kind === 'turn'
          ? `Steered ${name} (idle): your message started a turn there.`
          : `Steered ${name}, but its answer was lost before it could confirm; it may have been interrupted already. Do not resend; check with \`list\` or \`view\`.`,
  });
  return outcome;
}

/** What `peerNew` needs beyond a send: the window to open the chat in, the model
 *  to pin it to (this chat's own, unless the caller named one), and the name —
 *  derived here exactly as a local `new` derives it, so a worker next door is
 *  named like a worker here. */
export interface PeerNewContext extends Omit<PeerActionContext, 'target'> {
  peer: PeerWindow;
  title: string;
  pinModel?: string;
}

/** The chat a `new` opened, when the answer names it. A window on an older Forge
 *  accepts a `new_chat` and opens the chat later, in its own drain, without
 *  saying which: the message is queued either way, so that answer is reported
 *  honestly rather than failed — a retry would open a second chat. */
function openedPeerChat(value: Record<string, unknown>): { id: string; title: string } | undefined {
  const id = value['conversationId'];
  const title = value['title'];
  return typeof id === 'string' && id.length > 0
    ? { id, title: typeof title === 'string' && title.length > 0 ? title : id }
    : undefined;
}

/** The new chat may exist over there and this window cannot tell: the counter
 *  stays burned, because a second `new` would pay for a second worker instead of
 *  finding the one that is already there. */
function uncertainPeerNew(peer: PeerWindow, why: string): string {
  return `Error: ${folderName(peer.workspace)} did not confirm the new chat (${why}). It may be open there already, so do not resend: check with \`list\` first, and open another only if it is not there. The new-chat counter stays used.`;
}

/**
 * `new` in another window: one call that opens, pins and names a chat there and
 * makes this text its first message.
 *
 * The other window does the opening — it owns the sidebar, the chat cap and the
 * prologue lock — so the only thing this window can get wrong is its own
 * counters, and those follow the local `new` exactly: burned before the request,
 * given back when the answer proves nothing was opened, kept when the answer was
 * lost. The model is checked against that window's own list before anything is
 * posted, because a worker left on its window's default loads a second engine.
 */
export async function peerNew(input: PeerNewContext): Promise<string> {
  const { peer, window, at, sender, signal } = input;
  pruneMessageChatWindow(window, at);
  // A new chat is a wake as much as a send: it starts a turn somewhere.
  const sendLimit = messageChatSendLimit(window, true);
  if (sendLimit) return input.refuse(sendLimit);
  if (window.newChatsAt.length >= input.newChatsPerHour) {
    return input.refuse(
      `Error: the ${input.newChatsPerHour}-new-chat-per-${MESSAGE_CHAT_WINDOW_MINUTES}-min limit for this chat was reached; the next new chat is allowed at ${atText(nextAllowedAt(window.newChatsAt, MESSAGE_CHAT_WINDOW_MS))}.`,
    );
  }
  const text = peerBody(input);
  if ('refusal' in text) return input.refuse(text.refusal);
  const model = input.pinModel;
  // That window's config is the only list that means anything there, and asking
  // after the chat exists would leave a worker pinned to nothing.
  if (model && !peer.models.includes(model)) {
    return input.refuse(
      `Error: ${folderName(peer.workspace)} has no model "${model}" (configured there: ${peer.models.join(', ') || 'none'}). Nothing was created and no counter was used; name one of those with \`model\`, or open the chat in the window that has it.`,
    );
  }
  recordAction(window, at, true, true, false);
  const answer = await postPeerMessage(
    peer,
    {
      // One call, one worker: the receiving window opens the chat, pins it and
      // queues this text as its first message, then answers with its id.
      new_chat: 'true',
      from_conversation: input.selfId,
      from: chatLabel(sender.title),
      ...peerUnattendedFields(input),
      ...(model ? { model } : {}),
      // A name only when there is one: an empty `title` is a 400 from that
      // window, and the chat it would have named is worth opening regardless.
      ...(input.title ? { title: input.title } : {}),
    },
    text.body,
    signal,
  );
  if (!answer.ok) {
    if (answer.uncertain) return input.refuse(uncertainPeerNew(peer, answer.error));
    rollbackAction(window, at, true, true, false);
    return input.refuse(
      peerRefusal(`a new chat in ${folderName(peer.workspace)}`, answer.error, answer.status),
    );
  }
  if (answer.status !== 202) {
    return input.refuse(uncertainPeerNew(peer, `it answered ${answer.status} instead of 202`));
  }
  const opened = openedPeerChat(answer.value);
  input.emitActivity(
    input.selfId,
    input.formatMirrorLine(
      'out',
      opened ? opened.title : folderName(peer.workspace),
      undefined,
      clipMirroredPrompt(input.message),
    ),
  );
  return (
    `${opened ? `Opened "${opened.title}" (${opened.id})` : 'Opened a new chat'} in ${peer.workspace} ` +
    `on model ${model ?? "that window's default"} — your message is its first. Do not resend; check with \`list\` or \`view\` later.`
  );
}

/**
 * `view` a chat in another window: read what it has done, and burn nothing.
 *
 * A read is the one action a supervisor may repeat as often as it has turns, and
 * that holds next door as much as here, so no counter is touched and nothing is
 * waited for. The transcript arrives as the raw exchanges the other window
 * recorded, and is rendered by the same function this window renders its own
 * chats with — a supervisor that reads two workers, one here and one next door,
 * gets one format either way, including the two notes that say the list was cut
 * and that a turn is still writing the last entry.
 */
export async function peerView(input: {
  target: PeerChatRef;
  signal?: AbortSignal;
}): Promise<string> {
  const answer = await getPeerView(
    input.target.peer,
    input.target.id,
    MAX_VIEW_COUNT,
    input.signal,
  );
  if (!answer.ok) {
    return `Error: ${peerName(input.target)} could not be read: ${answer.error}. Nothing was sent and no counter was used.`;
  }
  if (answer.status !== 200) {
    // That window's own reason is the useful half of the answer: 404 says the
    // chat is gone over there, 400 says this Forge sent something that is not a
    // chat id, and 401 says the two windows are not sharing one bus folder.
    const reason = (answer.value as { error?: unknown } | undefined)?.error;
    return `Error: ${peerName(input.target)} answered ${answer.status}${
      typeof reason === 'string' ? `: ${reason}` : ' without a transcript'
    }. Nothing was sent and no counter was used.`;
  }
  const report = answer.value;
  // Named from the answer, not from the chat list this call was aimed by: the
  // title may have changed since, and the workspace is the other window's own
  // word for where it is.
  return renderChatView(
    { id: report.conversationId, closed: report.closed },
    `"${report.title}" in ${report.workspace}`,
    report.exchanges,
    report.streaming,
    // Measured over there, where the answers are: this array already arrived
    // cut to what one socket may carry.
    report.clamped,
  );
}
