import { z } from 'zod';
import type { ConversationRuntime } from '../sidebar/sessionTypes';

export const agentKindSchema = z.enum(['claude', 'codex', 'copilot']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export function agentDisplayName(kind: AgentKind): string {
  return { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }[kind];
}

const agentSenderShape = z
  .object({
    kind: agentKindSchema,
    sessionId: z.string().min(1),
  })
  .strict();

function checkSessionId<T extends { kind: AgentKind; sessionId: string }>(
  sender: T,
  context: z.RefinementCtx,
): void {
  if (!sessionIdSchemas[sender.kind].safeParse(sender.sessionId).success) {
    context.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: 'Invalid session id shape',
    });
  }
}

export const agentSenderSchema = agentSenderShape.superRefine(checkSessionId);
export type AgentSender = z.infer<typeof agentSenderSchema>;

export const agentSenderMetadataSchema = agentSenderShape
  .extend({
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((title) => !/[\r\n]/u.test(title)),
  })
  .strict()
  .superRefine(checkSessionId);
export type AgentSenderMetadata = z.infer<typeof agentSenderMetadataSchema>;

const sessionIdSchemas = {
  claude: z.string().uuid(),
  codex: z.string().uuid(),
  copilot: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/u),
} satisfies Record<AgentKind, z.ZodType<string>>;

export function parseAgentIdentity(
  kind: unknown,
  sessionId: unknown,
): {
  kind: AgentKind;
  sessionId: string;
} {
  const parsedKind = agentKindSchema.parse(kind);
  return { kind: parsedKind, sessionId: sessionIdSchemas[parsedKind].parse(sessionId) };
}

const agentLinkSchema = z
  .object({
    kind: agentKindSchema,
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    title: z.string().min(1),
    linkedAt: z.number().finite(),
    lastUsedAt: z.number().finite(),
    origin: z.enum(['forge-created', 'first-inbound', 'user-set']),
  })
  .strict()
  .superRefine((link, context) => {
    const parsed = sessionIdSchemas[link.kind].safeParse(link.sessionId);
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        path: ['sessionId'],
        message: 'Invalid session id shape',
      });
    }
  });

export type AgentLink = z.infer<typeof agentLinkSchema>;
export const agentLinksSchema = z
  .partialRecord(agentKindSchema, agentLinkSchema)
  .superRefine((links, context) => {
    for (const [kind, value] of Object.entries(links)) {
      if (value && value.kind !== kind) {
        context.addIssue({
          code: 'custom',
          path: [kind, 'kind'],
          message: 'Link kind must match its record key',
        });
      }
    }
  });
export type AgentLinks = z.infer<typeof agentLinksSchema>;

/**
 * Every chat a session is linked to, with the last time that session was
 * addressed there. A session may hold several chats
 * (docs/plans/V1_FINISH_PLAN.md lane 4 phase 5), so this is a set, not one
 * owner. The "current" chat is the entry with the newest `lastUsedAt`: it is
 * what `say` without `--to` goes to, and because the same field is stored on
 * every link, the newest entry after a reload is the current chat again with
 * nothing extra to persist and nothing to lose when the host dies.
 */
const chatsBySession = new Map<string, Map<string, number>>();

function rememberChat(sessionId: string, conversationId: string, lastUsedAt: number): void {
  const chats = chatsBySession.get(sessionId) ?? new Map<string, number>();
  chats.set(conversationId, lastUsedAt);
  chatsBySession.set(sessionId, chats);
}

function forgetChat(sessionId: string, conversationId: string): void {
  const chats = chatsBySession.get(sessionId);
  if (!chats) return;
  chats.delete(conversationId);
  if (chats.size === 0) chatsBySession.delete(sessionId);
}

/** Most recently used first, so `findBySession`'s answer is always the first. */
function orderedChats(sessionId: string): string[] {
  const chats = chatsBySession.get(sessionId);
  if (!chats) return [];
  return [...chats.entries()]
    .sort((a, b) => b[1]! - a[1]!)
    .map(([conversationId]) => conversationId);
}

/** Rebuild the process-local lookup from every open and recent history chat. */
export function rebuildIndex(
  conversations: readonly {
    id: string;
    title?: string;
    agentLinks?: AgentLinks | undefined;
  }[],
): void {
  const next = new Map<string, Map<string, number>>();
  for (const conversation of conversations) {
    for (const value of Object.values(conversation.agentLinks ?? {})) {
      if (!value) continue;
      const link = agentLinkSchema.parse(value);
      const chats = next.get(link.sessionId) ?? new Map<string, number>();
      // One entry per chat per session: a chat holds a single link per kind,
      // and two kinds in the same chat naming the same session is the same
      // chat reached two ways, not a second entry.
      chats.set(conversation.id, link.lastUsedAt);
      next.set(link.sessionId, chats);
    }
  }
  chatsBySession.clear();
  for (const [sessionId, chats] of next) chatsBySession.set(sessionId, chats);
}

/**
 * Put a link on a chat. Several chats may hold the same session, so this no
 * longer refuses a chat another one already links: `say --new`, `--to` an
 * unlinked open chat and the 🔗 picker each add a chat to the session's set
 * while the chat that held it keeps its link. A chat still holds one link per
 * kind, so re-linking a chat to a different session frees this chat from the
 * session it was holding.
 */
export function link(conversation: ConversationRuntime, value: AgentLink): AgentLink {
  const next = agentLinkSchema.parse(value);
  const previous = conversation.agentLinks?.[next.kind];
  if (previous && previous.sessionId !== next.sessionId)
    forgetChat(previous.sessionId, conversation.id);
  conversation.agentLinks = { ...conversation.agentLinks, [next.kind]: next };
  rememberChat(next.sessionId, conversation.id, next.lastUsedAt);
  return next;
}

/**
 * Link a second chat for a session that already holds one, keeping the first:
 * this is `say --new`. The new chat becomes current because its `lastUsedAt`
 * is newer, and the older chat stays reachable with `--to` for as long as it
 * holds the link.
 */
export function addChatForSession(
  from: ConversationRuntime,
  to: ConversationRuntime,
  kind: AgentKind,
  lastUsedAt = Date.now(),
): AgentLink {
  if (from.id === to.id) throw new Error('Cannot link the same chat twice.');
  const current = get(from, kind);
  if (!current) throw new Error(`Chat "${from.title}" has no linked ${kind} session.`);
  return link(to, { ...current, lastUsedAt });
}

export function unlink(conversation: ConversationRuntime, kind: AgentKind): AgentLink | undefined {
  const previous = conversation.agentLinks?.[kind];
  if (!previous) return undefined;
  const next = { ...conversation.agentLinks };
  delete next[kind];
  if (Object.keys(next).length > 0) conversation.agentLinks = next;
  else delete conversation.agentLinks;
  // Only this chat leaves the session: the other chats it was linked to stay
  // linked, and current moves to the newest of what is left.
  forgetChat(previous.sessionId, conversation.id);
  return previous;
}

export function get(
  conversation: Pick<ConversationRuntime, 'agentLinks'>,
  kind: AgentKind,
): AgentLink | undefined {
  const value = conversation.agentLinks?.[agentKindSchema.parse(kind)];
  return value ? agentLinkSchema.parse(value) : undefined;
}

export function touch(
  conversation: ConversationRuntime,
  kind: AgentKind,
  lastUsedAt = Date.now(),
): AgentLink {
  const current = get(conversation, kind);
  if (!current) throw new Error(`Chat "${conversation.title}" has no linked ${kind} session.`);
  return link(conversation, { ...current, lastUsedAt });
}

/** The chat this session last addressed: what `say` with no `--to` reaches. */
export function findBySession(sessionId: string): string | undefined {
  return orderedChats(sessionId)[0];
}

/**
 * Every chat this session may address, most recently used first. `--to` needs
 * the whole set: any chat already linked to this session is a legal target,
 * not only the current one. The set is process-wide, so a caller that can act
 * only on its own window has to check these ids against its own chats — see
 * `src/vscode/agentRouteDeps.ts` `linkedAgentOwner`.
 */
export function chatsForSession(sessionId: string): string[] {
  return orderedChats(sessionId);
}

/**
 * The chat this window can act on for a session: newest first, but only a chat
 * whose own link names this sender. A caller that runs in one window cannot use
 * `findBySession` alone — the index is process-wide, so the chat a session last
 * addressed may belong to another window, and treating that as "not linked" was
 * the trap phase 5 found (docs/plans/V1_FINISH_PLAN.md lane 4 phase 5). The
 * link is read through `linkOf` so this module stays free of the host facade.
 */
export function findSessionChatIn(
  sessionId: string,
  kind: AgentKind,
  linkOf: (conversationId: string, kind: AgentKind) => AgentLink | undefined,
): string | undefined {
  for (const conversationId of chatsForSession(sessionId)) {
    if (linkOf(conversationId, kind)?.sessionId === sessionId) return conversationId;
  }
  return undefined;
}

export function forgetConversation(conversationId: string): void {
  for (const [sessionId, chats] of chatsBySession) {
    chats.delete(conversationId);
    if (chats.size === 0) chatsBySession.delete(sessionId);
  }
}

/**
 * Closing an empty chat drops it rather than archiving it, so no restart will
 * rebuild its links. Left in the index, the linked session's every message
 * failed with "linked chat … is unavailable", `--new` and `--to` included.
 */
export function forgetIfDropped(
  conversationId: string,
  remaining: { conversations: readonly { id: string }[]; history: readonly { id: string }[] },
): void {
  const kept = [...remaining.conversations, ...remaining.history];
  if (!kept.some((conversation) => conversation.id === conversationId))
    forgetConversation(conversationId);
}
