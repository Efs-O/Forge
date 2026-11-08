import React from 'react';
import type { State } from '../appState';
import { MessageList } from './MessageList';
import { relativeTime } from './HistoryList';
import { resumedNoteFor } from '../resumedTabs';
import type { QueuedPrompt } from '../App';

interface Props {
  state: State;
  queuedPrompts: QueuedPrompt[];
  onCancelQueuedPrompt: (id: string) => void;
  onSendQueuedPromptNow: (id: string) => void;
  resumedIds: ReadonlySet<string>;
  /** Shown in whichever pane has nothing in it; identical for all of them. */
  emptyState: React.ReactNode;
}

/**
 * Mount only the active transcript. Paging bounds remount work; retaining every
 * visited pane would keep its DOM and React tree alive despite CSS containment.
 */
export function TranscriptPanes({
  state,
  queuedPrompts,
  onCancelQueuedPrompt,
  onSendQueuedPromptNow,
  resumedIds,
  emptyState,
}: Props): React.ReactElement {
  const id = state.activeConversationId;
  const tab = state.tabs.find((candidate) => candidate.id === id);

  return (
    <MessageList
      key={id}
      active
      messages={state.messagesById[id] ?? []}
      queuedPrompts={queuedPrompts.filter((prompt) => prompt.conversationId === id)}
      onCancelQueuedPrompt={onCancelQueuedPrompt}
      onSendQueuedPromptNow={onSendQueuedPromptNow}
      streaming={state.streamingIds.has(id)}
      conversationId={id}
      emptyState={emptyState}
      resumedNote={resumedNoteFor(tab, resumedIds, relativeTime)}
      activityView={state.activityView}
      thinkingDisplay={state.thinkingDisplay}
      pendingToolCalls={state.pendingToolCallsById.get(id)}
    />
  );
}
