export interface ChatRef {
  id: string;
  title: string;
  /** 1-based position among the open sidebar tabs. */
  position: number;
  running: boolean;
  model?: string;
}

export type ChatReferenceResolution =
  | { ok: true; chat: ChatRef }
  | { ok: false; reason: string; candidates: ChatRef[] };

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
      reason:
        'There is no other open chat. Open another chat, then send with `to` set to its `#N`, id, or title.',
      candidates: [],
    };
  }
  return {
    ok: false,
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
  return {
    ok: false,
    reason: `That reference matches multiple chats at this level: ${candidates
      .map(describeCandidate)
      .join('; ')}. Pass \`to\` as one of those chats' ids or tab numbers (#N).`,
    candidates,
  };
}

function describeCandidate(chat: ChatRef): string {
  return `#${chat.position} "${chat.title}" (id ${chat.id})`;
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
      if (!/^#?\d+$/u.test(normalized)) return [];
      const position = Number(normalized.replace(/^#/u, ''));
      return chats.filter((chat) => chat.position === position);
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
      reason: 'That is this chat. Choose another open chat with `to`.',
      candidates: others,
    };
  }
  return {
    ok: false,
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
