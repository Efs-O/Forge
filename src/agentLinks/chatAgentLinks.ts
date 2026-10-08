import { z } from 'zod';
import type { ConversationRuntime } from '../sidebar/sessionTypes';
import { getLogger } from '../util/logger';

const log = getLogger();

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

export const agentLinkSchema = z
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

export interface AgentLinkConflict {
  sessionId: string;
  firstChat: string;
  secondChat: string;
  keptChat: string;
}

const reverseIndex = new Map<string, string>();
const titlesByConversation = new Map<string, string>();

/** Rebuild the process-local lookup from every open and recent history chat. */
export function rebuildIndex(
  conversations: readonly {
    id: string;
    title?: string;
    agentLinks?: AgentLinks | undefined;
  }[],
): AgentLinkConflict[] {
  const next = new Map<string, { conversationId: string; lastUsedAt: number }>();
  const titles = new Map<string, string>();
  const conflicts: AgentLinkConflict[] = [];
  for (const conversation of conversations) {
    if (conversation.title) titles.set(conversation.id, conversation.title);
    for (const link of Object.values(conversation.agentLinks ?? {})) {
      if (!link) continue;
      const parsed = agentLinkSchema.parse(link);
      const existing = next.get(parsed.sessionId);
      if (existing && existing.conversationId !== conversation.id) {
        const incomingWins = parsed.lastUsedAt > existing.lastUsedAt;
        const firstChat = titles.get(existing.conversationId) ?? existing.conversationId;
        const secondChat = conversation.title ?? conversation.id;
        const keptChat = incomingWins ? secondChat : firstChat;
        const conflict = { sessionId: parsed.sessionId, firstChat, secondChat, keptChat };
        conflicts.push(conflict);
        log.error(
          `[chatAgentLinks] session ${parsed.sessionId} is linked to chats "${firstChat}" and "${secondChat}"; keeping "${keptChat}" (newest lastUsedAt)`,
        );
        if (incomingWins)
          next.set(parsed.sessionId, {
            conversationId: conversation.id,
            lastUsedAt: parsed.lastUsedAt,
          });
        continue;
      }
      next.set(parsed.sessionId, {
        conversationId: conversation.id,
        lastUsedAt: parsed.lastUsedAt,
      });
    }
  }
  reverseIndex.clear();
  titlesByConversation.clear();
  for (const [sessionId, owner] of next) reverseIndex.set(sessionId, owner.conversationId);
  for (const [conversationId, title] of titles) titlesByConversation.set(conversationId, title);
  return conflicts;
}

export function link(
  conversation: ConversationRuntime,
  value: AgentLink,
  conversations: readonly Pick<ConversationRuntime, 'id' | 'title'>[],
): AgentLink {
  const next = agentLinkSchema.parse(value);
  const linkedConversationId = reverseIndex.get(next.sessionId);
  if (linkedConversationId && linkedConversationId !== conversation.id) {
    const other = conversations.find((item) => item.id === linkedConversationId);
    const title =
      other?.title ?? titlesByConversation.get(linkedConversationId) ?? linkedConversationId;
    throw new Error(`That session is already linked to chat "${title}".`);
  }

  const previous = conversation.agentLinks?.[next.kind];
  if (previous && previous.sessionId !== next.sessionId) reverseIndex.delete(previous.sessionId);
  conversation.agentLinks = { ...conversation.agentLinks, [next.kind]: next };
  reverseIndex.set(next.sessionId, conversation.id);
  return next;
}

export function unlink(conversation: ConversationRuntime, kind: AgentKind): AgentLink | undefined {
  const previous = conversation.agentLinks?.[kind];
  if (!previous) return undefined;
  const next = { ...conversation.agentLinks };
  delete next[kind];
  if (Object.keys(next).length > 0) conversation.agentLinks = next;
  else delete conversation.agentLinks;
  if (reverseIndex.get(previous.sessionId) === conversation.id)
    reverseIndex.delete(previous.sessionId);
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
  return link(conversation, { ...current, lastUsedAt }, [conversation]);
}

export function findBySession(sessionId: string): string | undefined {
  return reverseIndex.get(sessionId);
}

export function move(
  from: ConversationRuntime,
  to: ConversationRuntime,
  kind: AgentKind,
  conversations: readonly Pick<ConversationRuntime, 'id' | 'title'>[],
): AgentLink {
  if (from.id === to.id) throw new Error('Cannot move a session link to the same chat.');
  const current = get(from, kind);
  if (!current) throw new Error(`Chat "${from.title}" has no linked ${kind} session.`);
  unlink(from, kind);
  return link(to, current, conversations);
}

export function forgetConversation(conversationId: string): void {
  for (const [sessionId, owner] of reverseIndex) {
    if (owner === conversationId) reverseIndex.delete(sessionId);
  }
  titlesByConversation.delete(conversationId);
}
