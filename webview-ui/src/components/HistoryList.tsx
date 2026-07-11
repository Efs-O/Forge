import React, { useEffect, useState } from 'react';
import type { SessionHistoryMeta } from '../../../src/sidebar/messageBridge';

interface Props {
  items: SessionHistoryMeta[];
  onRestore: (id: string) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric' });
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ChevronDown = (): React.ReactElement => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true">
    <path d="M0 0l5 6 5-6z" />
  </svg>
);

const ChevronRight = (): React.ReactElement => (
  <svg width="6" height="10" viewBox="0 0 6 10" fill="currentColor" aria-hidden="true">
    <path d="M0 0l6 5-6 5z" />
  </svg>
);

export function HistoryList({ items, onRestore }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (items.length === 0) setExpanded(true);
  }, [items.length]);

  const showBody = expanded || items.length === 0;

  return (
    <section id="history-panel" aria-label="Chat history">
      <button
        id="history-toggle"
        type="button"
        aria-expanded={showBody}
        aria-controls="history-list-wrap"
        onClick={() => {
          if (items.length > 0) setExpanded((v) => !v);
        }}
      >
        <span id="history-heading-row">
          <span id="history-heading">History</span>
          <span id="history-toggle-meta">
            {items.length > 0 && <span id="history-count">{items.length}</span>}
            <span id="history-chevron" aria-hidden="true">
              {showBody ? <ChevronDown /> : <ChevronRight />}
            </span>
          </span>
        </span>
      </button>

      {showBody &&
        (items.length === 0 ? (
          <p id="history-empty">Closed chats appear here.</p>
        ) : (
          <div id="history-list-wrap">
            <div id="history-list">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="history-item"
                  onClick={() => onRestore(item.id)}
                  title={absoluteTime(item.updatedAt)}
                >
                  <span className="history-item-title">{item.title}</span>
                  <span className="history-item-meta">
                    {item.messageCount ?? 0} msg · {relativeTime(item.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
    </section>
  );
}
