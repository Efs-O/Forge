import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentDisplayName,
  type AgentKind,
  type AgentLinks,
} from '../../../src/agentLinks/chatAgentLinks';
import { shortChatTitle } from '../../../src/sidebar/chatMessageText';

interface Props {
  title: string;
  historyExpanded: boolean;
  onNew: () => void;
  onToggleHistory: () => void;
  /** Absent when there is no conversation to rename; the title is then plain text. */
  onRename?: (title: string) => void;
  agentLinks?: AgentLinks;
  onUnlinkAgent: (kind: AgentKind) => void;
  /**
   * The open chats this one exchanges `message_chat` messages with. They are not
   * linked sessions, so their chip has no Unlink: it disappears when either
   * side closes. Computed on the host per tab projection.
   */
  messagedChats?: { id: string; title: string }[];
  /** Switch the panel to that chat; the same handler the history list uses. */
  onOpenChat?: (id: string) => void;
}

export function ChatHeader({
  title,
  historyExpanded,
  onNew,
  onToggleHistory,
  onRename,
  agentLinks,
  onUnlinkAgent,
  messagedChats,
  onOpenChat,
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

  const links = Object.values(agentLinks ?? {}).filter((item) => item !== undefined);
  const chats = messagedChats ?? [];

  return (
    <>
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
        {(links.length > 0 || chats.length > 0) && (
          <div id="agent-links-strip" aria-label="Linked agents and chats">
            {links.map((item) => (
              <div
                className={`agent-link-group agent-link-${item.kind}`}
                key={item.kind}
                aria-label={`${agentDisplayName(item.kind)} linked`}
                title={`${item.title}\nLast used ${new Date(item.lastUsedAt).toLocaleString()}`}
              >
                <span className="agent-link-name">{agentDisplayName(item.kind)}</span>
                <span className="agent-link-state">Linked</span>
                <button
                  type="button"
                  aria-label={`Unlink ${agentDisplayName(item.kind)}`}
                  title={`Unlink ${agentDisplayName(item.kind)}`}
                  onClick={() => onUnlinkAgent(item.kind)}
                >
                  Unlink
                </button>
              </div>
            ))}
            {chats.map((chat) => (
              <button
                type="button"
                className="agent-link-group agent-link-forge"
                key={chat.id}
                aria-label={`Open chat ${chat.title}`}
                title={`${chat.title}\n${chat.id}`}
                onClick={() => onOpenChat?.(chat.id)}
              >
                <span className="agent-link-name">Forge</span>
                <span className="agent-link-state">{shortChatTitle(chat.title)}</span>
              </button>
            ))}
          </div>
        )}
        <div id="chats-toolbar-actions">
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
          <button
            id="tab-new-btn"
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={onNew}
          >
            ＋
          </button>
        </div>
      </header>
    </>
  );
}
