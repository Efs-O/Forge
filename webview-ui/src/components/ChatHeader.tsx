import React from 'react';

interface Props {
  title: string;
  historyExpanded: boolean;
  onNew: () => void;
  onToggleHistory: () => void;
}

export function ChatHeader({
  title,
  historyExpanded,
  onNew,
  onToggleHistory,
}: Props): React.ReactElement {
  return (
    <header id="chat-header" aria-label="Current conversation">
      <span id="chat-header-title" title={title}>
        {title}
      </span>
      <div id="chats-toolbar-actions">
        <button
          id="tab-new-btn"
          type="button"
          title="New chat"
          aria-label="New chat"
          onClick={onNew}
        >
          ＋
        </button>
        <button
          id="history-toolbar-btn"
          type="button"
          aria-label="Conversation history"
          aria-expanded={historyExpanded}
          title="History"
          onClick={onToggleHistory}
        >
          ◷
        </button>
      </div>
    </header>
  );
}
