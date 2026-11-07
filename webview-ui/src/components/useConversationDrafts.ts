import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview } from '../../../src/sidebar/messageBridge';

interface ConversationDraftsOptions {
  activeConversationId: string;
  retentionReady: boolean;
  openConversationIds: ReadonlySet<string>;
  onDraftBearingConversationIds: (ids: string[]) => void;
  attachmentDraftIds: readonly string[];
  pruneAttachments: (openIds: ReadonlySet<string>) => void;
}

export interface ConversationDraftState {
  text: string;
  setText: (next: string) => void;
}

/** Text and staged-file ids stay in their existing webview owners. */
export function useConversationDrafts({
  activeConversationId,
  retentionReady,
  openConversationIds,
  onDraftBearingConversationIds,
  attachmentDraftIds,
  pruneAttachments,
}: ConversationDraftsOptions): ConversationDraftState {
  const [draftByConversation, setDraftByConversation] = useState<Record<string, string>>({});
  const hasReportedRetentionState = useRef(false);
  const text = draftByConversation[activeConversationId] ?? '';
  const setText = useCallback(
    (next: string) => {
      setDraftByConversation((previous) => {
        if (next) return { ...previous, [activeConversationId]: next };
        if (!(activeConversationId in previous)) return previous;
        const rest = { ...previous };
        delete rest[activeConversationId];
        return rest;
      });
    },
    [activeConversationId],
  );
  // Failed user sends return to their own draft, even while another tab is
  // visible. Preserve anything typed since Send instead of replacing it.
  useEffect(() => {
    const recover = (event: MessageEvent<HostToWebview>): void => {
      const msg = event.data;
      if (msg.type !== 'setInput' || !msg.text) return;
      const id = msg.conversationId ?? activeConversationId;
      if (!openConversationIds.has(id)) return;
      setDraftByConversation((previous) => {
        const draft = previous[id] ?? '';
        if (draft === msg.text || draft.endsWith(`\n\n${msg.text}`)) return previous;
        return { ...previous, [id]: draft ? `${draft}\n\n${msg.text}` : msg.text };
      });
    };
    window.addEventListener('message', recover);
    return () => window.removeEventListener('message', recover);
  }, [activeConversationId, openConversationIds]);
  const draftBearingConversationIds = useMemo(
    () => [
      ...new Set([
        ...Object.entries(draftByConversation)
          .filter(([, draft]) => draft.length > 0)
          .map(([id]) => id),
        ...attachmentDraftIds,
      ]),
    ],
    [attachmentDraftIds, draftByConversation],
  );

  useEffect(() => {
    if (!retentionReady) return;
    hasReportedRetentionState.current = true;
    onDraftBearingConversationIds(draftBearingConversationIds);
  }, [draftBearingConversationIds, onDraftBearingConversationIds, retentionReady]);

  useEffect(
    () => () => {
      if (hasReportedRetentionState.current) onDraftBearingConversationIds([]);
    },
    [onDraftBearingConversationIds],
  );

  useEffect(() => {
    if (!retentionReady) return;
    setDraftByConversation((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([id]) => openConversationIds.has(id)),
      );
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
    pruneAttachments(openConversationIds);
  }, [openConversationIds, pruneAttachments, retentionReady]);

  return { text, setText };
}
