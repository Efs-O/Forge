import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
