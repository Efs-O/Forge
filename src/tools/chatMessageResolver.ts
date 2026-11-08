import type { ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import { quoteTitle } from '../sidebar/chatMessageText';

export interface ChatRef {
  id: string;
  title: string;
  /** 1-based position among the open sidebar tabs. A closed chat has no tab, so
   *  it carries 0 and the `#N` tier can never resolve it. */
  position: number;
  running: boolean;
  model?: string;
  /** A chat in recent history rather than an open tab: `view` can still read it,
   *  while `send` and `steer` refuse it. Only `view`'s closed fallback builds
   *  these, from the archived rows `status()` already reports. */
  closed?: boolean;
  /** Sitting on a card the owner has to answer, so a steer refuses. `chatRefs`
   *  fills it from `status().pendingApproval`; a peer window's chat list carries
   *  the same fact, which is what lets the steer guard run on a chat that lives
   *  in another window without reading that window's status. */
  awaitingApproval?: boolean;
  /** The request-chain epoch of the turn this chat holds, when it holds one: the
   *  number the steer-loop guard compares against, from the same two sources. */
  userIntentEpoch?: number;
}

/** Why a reference was refused, said as data rather than as text to match on.
 *  `unmatched` — the reference named one chat and nothing among the open tabs
 *  matched it — is the only code `view`'s closed-chat fallback reruns. An
 *  ambiguous or self-matched reference was already answered by the open chats. */
export type ChatReferenceFailureCode = 'ambiguous' | 'self' | 'omitted' | 'unmatched';

export type ChatReferenceResolution =
  | { ok: true; chat: ChatRef }
  | { ok: false; reason: string; candidates: ChatRef[]; reasonCode: ChatReferenceFailureCode };

const FILLER_WORDS = new Set([
  'chat',
  'session',
  'tab',
  'conversation',
  'the',
  'other',
  'running',
  'active',
]);

function normalizeReference(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function omittedResolution(chats: ChatRef[], selfId: string): ChatReferenceResolution {
  const others = chats.filter((chat) => chat.id !== selfId);
  const running = others.filter((chat) => chat.running);
  if (running.length === 1) return { ok: true, chat: running[0]! };
  if (others.length === 1) return { ok: true, chat: others[0]! };
  if (others.length === 0) {
    return {
      ok: false,
      reasonCode: 'omitted',
      reason:
        'There is no other open chat. Open another chat, then send with `to` set to its `#N`, id, or title.',
      candidates: [],
    };
  }
  return {
    ok: false,
    reasonCode: 'omitted',
    reason:
      'Several other chats are open and there is no unique other running chat; pass `to` to choose one.',
    candidates: others,
  };
}

/**
 * One tier's verdict, or undefined to fall through. The caller's own chat is
 * dropped first, so a tier that matched only the caller falls through too.
 */
function decideTier(matches: ChatRef[], selfId: string): ChatReferenceResolution | undefined {
  const candidates = matches.filter((chat) => chat.id !== selfId);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { ok: true, chat: candidates[0]! };
  // A closed chat has no tab number to pass back, so the instruction only offers
  // `#N` when at least one candidate is an open tab.
  const tabbable = candidates.some((chat) => !chat.closed);
  return {
    ok: false,
    reasonCode: 'ambiguous',
    reason: `That reference matches multiple chats at this level: ${candidates
      .map(describeCandidate)
      .join('; ')}. Pass \`to\` as one of those chats' ${
      tabbable ? 'ids or tab numbers (#N)' : 'ids'
    }.`,
    candidates,
  };
}

function describeCandidate(chat: ChatRef): string {
  const tab = chat.closed ? '' : `#${chat.position} `;
  return `${tab}"${chat.title}" (id ${chat.id}${chat.closed ? ', closed' : ''})`;
}

/** Resolve a model-provided chat reference without needing a preliminary list call. */
export function resolveChatReference(
  ref: string | undefined,
  chats: ChatRef[],
  selfId: string,
): ChatReferenceResolution {
  const normalized = ref === undefined ? '' : normalizeReference(ref);
  const refWords = words(normalized);
  const queryWords = refWords.filter((word) => !FILLER_WORDS.has(word));
  // Blank, or only filler ("the other chat"). A symbol-only ref (an emoji
  // title) has no words at all and still goes through the tiers below.
  if (!normalized || (refWords.length > 0 && queryWords.length === 0)) {
    return omittedResolution(chats, selfId);
  }

  const tiers: Array<() => ChatRef[]> = [
    () => chats.filter((chat) => normalizeReference(chat.id) === normalized),
    () => {
      // A closed chat has no tab position, so `#N` never resolves one: the tier
      // is skipped for it rather than relying on the 0 a closed ref carries.
      if (!/^#?\d+$/u.test(normalized)) return [];
      const position = Number(normalized.replace(/^#/u, ''));
      return chats.filter((chat) => !chat.closed && chat.position === position);
    },
    () =>
      normalized.length >= 4
        ? chats.filter((chat) => normalizeReference(chat.id).startsWith(normalized))
        : [],
    () => chats.filter((chat) => normalizeReference(chat.title) === normalized),
    () => chats.filter((chat) => normalizeReference(chat.title).includes(normalized)),
    () => {
      // `every` on no words would match every chat.
      if (queryWords.length === 0) return [];
      return chats.filter((chat) => {
        const titleWords = words(normalizeReference(chat.title));
        return queryWords.every((queryWord) =>
          titleWords.some((titleWord) => titleWord.startsWith(queryWord)),
        );
      });
    },
  ];
  let selfMatched = false;
  for (const tier of tiers) {
    const matches = tier();
    if (matches.some((chat) => chat.id === selfId)) selfMatched = true;
    const decided = decideTier(matches, selfId);
    if (decided) return decided;
  }

  const others = chats.filter((chat) => chat.id !== selfId);
  if (selfMatched) {
    return {
      ok: false,
      reasonCode: 'self',
      reason: 'That is this chat. Choose another open chat with `to`.',
      candidates: others,
    };
  }
  return {
    ok: false,
    reasonCode: 'unmatched',
    reason: `No open chat matches "${ref}". Choose a chat by its id, tab number (#N), or title words.`,
    candidates: others,
  };
}

export function formatChatId(id: string, chats: ChatRef[]): string {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id)) return id;
  const normalized = id.toLowerCase();
  let length = 8;
  while (
    length < id.length &&
    chats.some(
      (other) => other.id !== id && other.id.toLowerCase().startsWith(normalized.slice(0, length)),
    )
  ) {
    length += 1;
  }
  return id.slice(0, length);
}

function displayTitle(title: string): string {
  return title.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

/** Format the open tabs in tab order, using ids the resolver can accept directly. */
export function formatChatList(chats: ChatRef[], selfId: string): string {
  const ordered = [...chats].sort((left, right) => left.position - right.position);
  const self = ordered.find((chat) => chat.id === selfId);
  const lines = ordered.map((chat) => {
    const model = chat.model ? ` · ${chat.model}` : '';
    const caller = chat.id === selfId ? ' ← you' : '';
    return `#${chat.position} · ${displayTitle(chat.title)} · ${chat.running ? 'running' : 'idle'}${model} · id ${formatChatId(chat.id, ordered)}${caller}`;
  });
  return [
    `Chats in this window (you are #${self?.position ?? '?'}):`,
    ...lines,
    'send: {"action":"send","to":"#2","message":"…"} — or omit "to" to reach the only other running chat.',
  ].join('\n');
}

/** The open tabs as refs: every non-archived row `status()` reports, in tab
 *  order, marked running when it is streaming or holds a request chain. */
export function chatRefs(status: ForgeHostStatus): ChatRef[] {
  const open = status.conversations.filter((conversation) => !conversation.archived);
  const runningIds = new Set(status.streamingConversationIds);
  const reservedIds = new Set(status.requestChains.map((chain) => chain.conversationId));
  const pending = status.pendingApproval;
  // A card with no chat attached to it blocks every steer in the window, as the
  // guard that read `status()` directly used to; the epoch travels with the ref
  // so the same guard sees the same number whichever window the chat is in.
  const awaiting = (id: string): boolean =>
    pending !== undefined &&
    (pending.conversationId === undefined || pending.conversationId === id);
  const epochs = new Map(
    status.requestChains.map((chain) => [chain.conversationId, chain.userIntentEpoch] as const),
  );
  return open.map((conversation, index) => {
    const epoch = epochs.get(conversation.id);
    return {
      id: conversation.id,
      title: conversation.title,
      position: index + 1,
      running: runningIds.has(conversation.id) || reservedIds.has(conversation.id),
      ...(conversation.activeModel ? { model: conversation.activeModel } : {}),
      ...(awaiting(conversation.id) ? { awaitingApproval: true } : {}),
      ...(epoch === undefined ? {} : { userIntentEpoch: epoch }),
    };
  });
}

/** The chats this window says are mid-turn: streaming, or holding a request
 *  chain. The steer action prunes its record of who started a turn here against
 *  this set, so a chat that finished cannot hold a loop guard forever. */
export function activeChatIds(status: ForgeHostStatus): Set<string> {
  return new Set([
    ...status.streamingConversationIds,
    ...status.requestChains.map((chain) => chain.conversationId),
  ]);
}

/** The archived rows as closed refs, for `view`'s fallback. */
export function closedChatRefs(status: ForgeHostStatus): ChatRef[] {
  return status.conversations
    .filter((conversation) => conversation.archived)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      // No tab, so no position: the `#N` tier never resolves a closed chat.
      position: 0,
      running: false,
      closed: true,
      ...(conversation.activeModel ? { model: conversation.activeModel } : {}),
    }));
}

/** How to name one chat: its tab number when it has one, its title alone when it
 *  does not. */
/** Which chat `view` reads. An open chat always wins: only a reference that
 *  named one chat and matched nothing among the open tabs is tried again
 *  against the closed chats, so a supervisor can read back a worker that closed
 *  its tab while `send` and `steer` still refuse it. Every refusal comes back
 *  fully formatted, because a closed-chat ambiguity lists its own candidates
 *  rather than the open tabs. */
export function resolveViewTarget(
  ref: string | undefined,
  chats: ChatRef[],
  closed: ChatRef[],
  selfId: string,
): { ok: true; chat: ChatRef } | { ok: false; refusal: string } {
  const withTabList = (message: string): string => `${message}\n\n${formatChatList(chats, selfId)}`;
  const open = resolveChatReference(ref, chats, selfId);
  if (open.ok) return open;
  // Ambiguous, self-matched, or an omitted reference: the open chats already
  // answered it, and a closed chat must never win over an open one.
  if (open.reasonCode !== 'unmatched' || closed.length === 0) {
    return { ok: false, refusal: withTabList(`Error: ${open.reason}`) };
  }
  const history = resolveChatReference(ref, closed, selfId);
  if (history.ok) return { ok: true, chat: history.chat };
  // Two closed chats match the same words: name both, never pick one. The
  // reason already lists them by title and id, so the open-tab list would only
  // add chats this read cannot reach. (`unmatched` lists every closed chat as
  // candidates, so the code, not the count, is what tells the two apart.)
  if (history.reasonCode === 'ambiguous') return { ok: false, refusal: `Error: ${history.reason}` };
  // Neither an open tab nor recent history — an overflow-archive chat, or no
  // such chat at all — keeps the refusal it had before the fallback existed.
  return { ok: false, refusal: withTabList(`Error: ${open.reason}`) };
}

export function formatChatName(chat: ChatRef): string {
  // A closed chat has no tab number to name it by, so `view`'s header quotes its
  // title alone and `renderChatView` marks the read `closed`.
  return chat.closed ? quoteTitle(chat.title) : `#${chat.position} ${quoteTitle(chat.title)}`;
}

/** The one sentence a `send` or `steer` earns when the reference matched a chat
 *  that is closed rather than open: the caller learns its worker is still
 *  readable instead of guessing the chat is gone. Nothing else about those
 *  actions changes — a closed chat is never delivered to, queued or woken. */
export function closedChatHint(
  resolution: ChatReferenceResolution,
  ref: string | undefined,
  closed: ChatRef[],
  selfId: string,
): string {
  if (resolution.ok || resolution.reasonCode !== 'unmatched' || closed.length === 0) return '';
  return resolveChatReference(ref, closed, selfId).ok
    ? '\nThat chat is closed; `view` can still read it.'
    : '';
}
