import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionHistoryMeta } from '../../../src/sidebar/messageBridge';

interface Props {
  items: SessionHistoryMeta[];
  expanded: boolean;
  /** Escape or a click outside the panel. */
  onDismiss: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/** Shared with the resumed marker in App; single owner for this wording. */
export function relativeTime(ts: number): string {
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

const KebabIcon = (): React.ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="3.5" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="8" cy="12.5" r="1.4" />
  </svg>
);

const RenameIcon = (): React.ReactElement => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />
  </svg>
);

const TrashIcon = (): React.ReactElement => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3 4.5h10M6 4.5V3h4v1.5m-5 2v6h6v-6" />
  </svg>
);

interface RowProps {
  item: SessionHistoryMeta;
  renaming: boolean;
  menuOpen: boolean;
  onOpenMenu: (id: string | null) => void;
  onStartRename: (id: string | null) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function HistoryRow({
  item,
  renaming,
  menuOpen,
  onOpenMenu,
  onStartRename,
  onRestore,
  onDelete,
  onRename,
}: RowProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Dismiss the menu on an outside click or Escape, the same contract the model
  // selector uses. Without this the menu survives a click into the transcript.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, onOpenMenu]);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commit = useCallback((): void => {
    const next = inputRef.current?.value ?? '';
    // An unchanged or blank box is a cancel, not a rename: blank would otherwise
    // round-trip to the host only to be rejected there.
    if (next.trim() && next !== item.title) onRename(item.id, next);
    onStartRename(null);
  }, [item.id, item.title, onRename, onStartRename]);

  if (renaming) {
    return (
      <div className="history-item-row history-item-row-editing">
        <input
          ref={inputRef}
          className="history-rename-input"
          defaultValue={item.title}
          aria-label="Conversation title"
          autoFocus
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onStartRename(null);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`history-item-row${menuOpen ? ' history-item-row-active' : ''}`}>
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
      <div className="history-item-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className="history-item-kebab"
          aria-label={`Actions for ${item.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="More actions"
          onClick={() => onOpenMenu(menuOpen ? null : item.id)}
        >
          <KebabIcon />
        </button>
        {menuOpen && (
          <div className="history-item-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="history-menu-item"
              onClick={() => {
                onOpenMenu(null);
                onStartRename(item.id);
              }}
            >
              <RenameIcon />
              Rename
            </button>
            <div className="history-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="history-menu-item history-menu-item-danger"
              onClick={() => {
                onOpenMenu(null);
                onDelete(item.id);
              }}
            >
              <TrashIcon />
              Delete…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function HistoryList({
  items,
  expanded,
  onDismiss,
  onRestore,
  onDelete,
  onRename,
}: Props): React.ReactElement {
  // Only one row may be open or editing at a time, so both live here as an id
  // rather than as per-row state that would survive the row being re-keyed.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The panel floats over the transcript now, so it needs the dismissal
  // contract every overlay needs. Same shape as the row kebab's above; the
  // kebab keeps its own because it must close without closing the panel.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The toolbar button toggles; letting the outside-click close fire too
      // would reopen-and-close on the same press.
      if ((target as HTMLElement).closest?.('#history-toolbar-btn')) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded, onDismiss]);

  // Open tabs are deliberately absent: the tab strip directly above lists every
  // one of them, with the same spinner and queued dot, so an "Open" group here
  // rendered the active session a second time under its own chip.
  return (
    <section id="history-panel" ref={panelRef} aria-label="Closed sessions" hidden={!expanded}>
      {items.length === 0 ? (
        <p id="history-empty">Closed chats appear here.</p>
      ) : (
        <div className="history-list-wrap">
          <div id="history-list">
            {items.map((item) => (
              <HistoryRow
                key={item.id}
                item={item}
                renaming={renamingId === item.id}
                menuOpen={menuId === item.id}
                onOpenMenu={setMenuId}
                onStartRename={setRenamingId}
                onRestore={onRestore}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
