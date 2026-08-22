import type { AttachmentData } from './messageBridge';
import type { ContentPart } from '../llm/types';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import {
  MAX_CONVERSATIONS,
  displayPersistMessages,
  newConversationId,
  upsertHistoryConversation,
} from './sessionTypes';

export type NewConvResult =
  | { atCap: true }
  | { atCap: false; sidebar: SidebarRuntime; newId: string };

export type RestoreConvResult =
  | { atCap: true }
  | { notFound: true }
  | { ok: true; sidebar: SidebarRuntime; newActiveId: string; activeModelOverride?: string };

/**
 * Open a new empty conversation tab. Returns atCap if limit reached.
 *
 * `defaultModel` is pinned onto the tab immediately rather than left to fall
 * through to the global default at use time. That fallback is live: an unpinned
 * tab silently adopted whatever model the last visited tab set, so merely
 * switching away and back changed which model a new chat would talk to.
 */
export function opNewConversation(
  sidebar: SidebarRuntime,
  defaultModel?: string | null,
): NewConvResult {
  if (sidebar.conversations.length >= MAX_CONVERSATIONS) return { atCap: true };
  const id = newConversationId();
  const now = Date.now();
  const conv: ConversationRuntime = {
    id,
    title: 'Chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...(defaultModel ? { active_model: defaultModel } : {}),
  };
  const updated: SidebarRuntime = {
    ...sidebar,
    conversations: [...sidebar.conversations, conv],
    activeConversationId: id,
  };
  return { atCap: false, sidebar: updated, newId: id };
}

/** Switch active conversation. Returns null if id not found. */
export function opSwitchConversation(
  sidebar: SidebarRuntime,
  id: string,
): { sidebar: SidebarRuntime; activeModelOverride?: string } | null {
  if (!sidebar.conversations.some((c) => c.id === id)) return null;
  const conv = sidebar.conversations.find((c) => c.id === id);
  return {
    sidebar: { ...sidebar, activeConversationId: id },
    ...(conv?.active_model !== undefined ? { activeModelOverride: conv.active_model } : {}),
  };
}

/** Close a conversation tab. Archives it if it has messages. */
export function opCloseConversation(
  sidebar: SidebarRuntime,
  id: string,
): { sidebar: SidebarRuntime; newActiveId: string } | null {
  const ix = sidebar.conversations.findIndex((c) => c.id === id);
  if (ix < 0) return null;
  const conv = sidebar.conversations[ix]!;
  // Tool history alone should not create an archived conversation.
  const shouldArchive = displayPersistMessages(conv.messages).some((m) => m.role !== 'tool');
  const updated = { ...sidebar, conversations: [...sidebar.conversations] };

  if (updated.conversations.length === 1) {
    if (shouldArchive) upsertHistoryConversation(updated, conv);
    const freshId = newConversationId();
    updated.conversations[0] = {
      id: freshId,
      title: 'Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    updated.activeConversationId = freshId;
    return { sidebar: updated, newActiveId: freshId };
  }

  if (shouldArchive) upsertHistoryConversation(updated, conv);
  updated.conversations.splice(ix, 1);
  if (updated.activeConversationId === id) {
    const fallback = updated.conversations[Math.min(ix, updated.conversations.length - 1)]!;
    updated.activeConversationId = fallback.id;
  }
  return { sidebar: updated, newActiveId: updated.activeConversationId };
}

/** Restore a conversation from history (or re-activate if already open). */
export function opRestoreConversation(sidebar: SidebarRuntime, id: string): RestoreConvResult {
  const existing = sidebar.conversations.find((c) => c.id === id);
  if (existing) {
    return {
      ok: true as const,
      sidebar: { ...sidebar, activeConversationId: id },
      newActiveId: id,
      ...(existing.active_model !== undefined
        ? { activeModelOverride: existing.active_model }
        : {}),
    };
  }

  const archived = sidebar.history.find((c) => c.id === id);
  if (!archived) return { notFound: true };
  if (sidebar.conversations.length >= MAX_CONVERSATIONS) return { atCap: true };

  const restored: ConversationRuntime = {
    ...archived,
    messages: [...archived.messages],
    ...(archived.displayDiffs ? { displayDiffs: [...archived.displayDiffs] } : {}),
    updatedAt: Date.now(),
  };
  const updated: SidebarRuntime = {
    ...sidebar,
    conversations: [...sidebar.conversations, restored],
    history: sidebar.history.filter((c) => c.id !== id),
    activeConversationId: restored.id,
  };
  return {
    ok: true as const,
    sidebar: updated,
    newActiveId: restored.id,
    ...(archived.active_model !== undefined ? { activeModelOverride: archived.active_model } : {}),
  };
}

/**
 * Clear messages from a conversation in place (mutates).
 *
 * The pinned model deliberately survives: dropping it left the tab following
 * the global default again, so a cleared tab would change model behind the
 * user's back the next time another tab was visited — while the picker went on
 * showing the model they had chosen here.
 */
export function opClearMessages(conv: ConversationRuntime): void {
  conv.messages = [];
  conv.displayDiffs = [];
  conv.title = 'Chat';
  conv.updatedAt = Date.now();
  opResetReportedContext(conv);
}

/**
 * Forget the last request's measured context.
 *
 * Called wherever the prompt the model will see stops matching the one that was
 * measured — clearing a conversation, or compacting it. The token bar, the
 * status bar and the HalluMeter bridge all read these two counters, so leaving
 * them in place after a /compact left every display insisting the window was
 * still full. They read 0 (bar shows `0 / max`) until the next response
 * reports real numbers; the session totals are cumulative and are not touched.
 */
export function opResetReportedContext(conv: ConversationRuntime): void {
  delete conv.last_input_tokens;
  delete conv.last_output_tokens;
}

/**
 * Make the model picker selection apply to the current conversation as well
 * as the global default. Conversations deliberately retain their selected
 * model across tab switches, so changing only config.active_model would leave
 * an already-used conversation pinned to its previous provider.
 */
export function opSetActiveConversationModel(
  sidebar: SidebarRuntime,
  modelName: string | null,
): void {
  const conversation = sidebar.conversations.find(
    (candidate) => candidate.id === sidebar.activeConversationId,
  );
  if (!conversation) return;
  if (modelName) conversation.active_model = modelName;
  else delete conversation.active_model;
  conversation.updatedAt = Date.now();
}

export function buildUserContent(
  text: string,
  attachments?: AttachmentData[],
): string | ContentPart[] {
  if (!attachments?.length) return text;
  const parts: ContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const att of attachments) {
    if (att.mediaType.startsWith('image/')) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${att.mediaType};base64,${att.data}` },
      });
    } else {
      parts.push({ type: 'text', text: `\`\`\`${att.name}\n${att.data}\n\`\`\`` });
    }
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}
