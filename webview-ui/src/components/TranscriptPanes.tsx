import React, { useEffect, useMemo, useState } from 'react';
import type { State } from '../appState';
import { MessageList } from './MessageList';
import { relativeTime } from './HistoryList';
import { resumedNoteFor } from '../resumedTabs';
import type { QueuedPrompt } from '../App';

interface Props {
  state: State;
  queuedPrompts: QueuedPrompt[];
  onCancelQueuedPrompt: (id: string) => void;
  onSteerQueuedPrompt: (id: string) => void;
  resumedIds: ReadonlySet<string>;
  /** Shown in whichever pane has nothing in it; identical for all of them. */
  emptyState: React.ReactNode;
}

/**
 * One mounted transcript pane per conversation the user has actually opened.
 *
 * Switching tabs by swapping one list's `messages` prop unmounts every row of
 * the outgoing conversation and mounts every row of the incoming one, each
 * running `react-markdown` + `rehype-highlight`. On a long transcript that is
 * the single largest remaining cost of a switch once the host stopped shipping
 * all 52 transcripts on every sync — see
 * `docs/plans/SIDEBAR_SWITCH_LATENCY_PLAN.md`. Keeping the panes mounted and
 * toggling `hidden` makes a return visit a CSS change.
 *
 * Panes are claimed lazily rather than one per open tab up front: mounting all
 * twelve at load would move exactly the same work to window startup, where
 * there is not even a visible tab to justify it. Off-screen rows cost little to
 * keep around because `.messages-pane > *` carries `content-visibility: auto`.
 */
export function TranscriptPanes({
  state,
  queuedPrompts,
  onCancelQueuedPrompt,
  onSteerQueuedPrompt,
  resumedIds,
  emptyState,
}: Props): React.ReactElement {
  const [visitedIds, setVisitedIds] = useState<string[]>([]);

  useEffect(() => {
    setVisitedIds((current) => {
      const openIds = new Set(state.tabs.map((tab) => tab.id));
      // A closed tab gives its pane back; nothing can show that transcript
      // again without the host re-sending it.
      const kept = current.filter((id) => openIds.has(id));
      if (!kept.includes(state.activeConversationId)) kept.push(state.activeConversationId);
      const unchanged =
        kept.length === current.length && kept.every((id, index) => id === current[index]);
      return unchanged ? current : kept;
    });
  }, [state.activeConversationId, state.tabs]);

  // The active id is included on the render it changes, before the effect above
  // has run, so a switch never paints a frame with no transcript at all.
  const paneIds = useMemo(
    () =>
      visitedIds.includes(state.activeConversationId)
        ? visitedIds
        : [...visitedIds, state.activeConversationId],
    [visitedIds, state.activeConversationId],
  );

  return (
    <>
      {paneIds.map((id) => {
        const tab = state.tabs.find((candidate) => candidate.id === id);
        return (
          <MessageList
            key={id}
            active={id === state.activeConversationId}
            messages={state.messagesById[id] ?? []}
            queuedPrompts={queuedPrompts.filter((prompt) => prompt.conversationId === id)}
            onCancelQueuedPrompt={onCancelQueuedPrompt}
            onSteerQueuedPrompt={onSteerQueuedPrompt}
            streaming={state.streamingIds.has(id)}
            conversationId={id}
            emptyState={emptyState}
            resumedNote={resumedNoteFor(tab, resumedIds, relativeTime)}
            // A background tab may be on a different model than the picker
            // shows, and `active_model` is only set once a conversation picks
            // one explicitly.
            queuedModelName={tab?.active_model ?? state.activeModel}
          />
        );
      })}
    </>
  );
}
