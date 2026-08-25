import React from 'react';
import type { SessionHistoryMeta } from '../../../src/sidebar/messageBridge';

interface Props {
  items: SessionHistoryMeta[];
  expanded: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
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

const TrashIcon = (): React.ReactElement => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path
      d="M2.5 3.5h7M4.5 3.5V2h3v1.5m-4 1.5v4.5h5V5M5 6v2.5m2-2.5v2.5"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function HistoryList({ items, expanded, onRestore, onDelete }: Props): React.ReactElement {
  return (
    <section id="history-panel" aria-label="Chat history" hidden={!expanded}>
      {items.length === 0 ? (
        <p id="history-empty">Closed chats appear here.</p>
      ) : (
        <div id="history-list-wrap">
          <div id="history-list">
            {items.map((item) => (
              <div key={item.id} className="history-item-row">
                <button
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
                <button
                  type="button"
                  className="history-item-delete"
                  aria-label={`Delete ${item.title}`}
                  title="Delete permanently"
                  onClick={() => onDelete(item.id)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
