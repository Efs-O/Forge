import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  historyExpanded: boolean;
  onNew: () => void;
  onToggleHistory: () => void;
  /** Absent when there is no conversation to rename; the title is then plain text. */
  onRename?: (title: string) => void;
}

export function ChatHeader({
  title,
  historyExpanded,
  onNew,
  onToggleHistory,
  onRename,
}: Props): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback((): void => {
    const next = inputRef.current?.value ?? '';
    // Unchanged or blank is a cancel, matching the history panel's rename.
    if (next.trim() && next !== title) onRename?.(next);
    setEditing(false);
  }, [onRename, title]);

  return (
    <header id="chat-header" aria-label="Current conversation">
      {editing ? (
        <input
          ref={inputRef}
          id="chat-header-title-input"
          defaultValue={title}
          aria-label="Conversation title"
          autoFocus
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : onRename ? (
        <button
          id="chat-header-title"
          type="button"
          title={`${title}\nClick to rename`}
          onClick={() => setEditing(true)}
        >
          {title}
        </button>
      ) : (
        <span id="chat-header-title" title={title}>
          {title}
        </span>
      )}
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
