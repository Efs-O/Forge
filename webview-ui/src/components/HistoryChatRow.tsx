/**
 * One chat row in the sessions panel: who started the chat, what it is called,
 * how old it is, and the menu that renames or deletes it.
 *
 * Split out of `HistoryList.tsx`, which is at this repo's 500-line gate and
 * grew a search box, tabs and a resize grip on top of the rows it already drew.
 * The row keeps every class the panel's tests and styles already name, so only
 * the badge is new to the DOM.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { SessionHistoryMeta, SessionTabMeta } from '../../../src/sidebar/messageBridge';
import { chatRowView, type ChatProvenance } from '../historyFilter';

/** The small outlined label beside a row: who it is answering, or `You`. */
export function ChatRowBadge({ item }: { item: ChatProvenance }): ReactElement {
  const { badge } = chatRowView(item);
  const classes = [
    'history-row-badge',
    ...(badge.kind === 'agent' ? ['history-row-badge-agent'] : []),
    ...(badge.agentClass ? [badge.agentClass] : []),
  ];
  return (
    <span className={classes.join(' ')} title={badge.tooltip}>
      {badge.label}
    </span>
  );
}

interface HistoryChatRowProps {
  item: SessionHistoryMeta;
  renaming: boolean;
  menuOpen: boolean;
  onOpenMenu: (id: string | null) => void;
  onStartRename: (id: string | null) => void;
  /** A closed chat was picked: the host restores it. */
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onResetApprovals: (id: string) => void;
}

export function HistoryChatRow({
  item,
  renaming,
  menuOpen,
  onOpenMenu,
  onStartRename,
  onRestore,
  onDelete,
  onRename,
  onResetApprovals,
}: HistoryChatRowProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const anchor = menuRef.current?.querySelector('button');
    const menu = menuRef.current?.querySelector<HTMLElement>('[role="menu"]');
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    // The list clips overflow. Position against the viewport so the last
    // row's actions remain clickable instead of disappearing below the list.
    menu.style.position = 'fixed';
    menu.style.right = 'auto';
    menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, rect.bottom + menu.offsetHeight + 4 <= window.innerHeight ? rect.bottom + 2 : rect.top - menu.offsetHeight - 2)}px`;
    const dismiss = (): void => onOpenMenu(null);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [menuOpen, onOpenMenu]);

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

  const { title } = chatRowView(item);
  return (
    <div className={`history-item-row${menuOpen ? ' history-item-row-active' : ''}`}>
      <button
        type="button"
        className="history-item history-chat-item"
        onClick={() => onRestore(item.id)}
        title={[absoluteTime(item.updatedAt), item.active_model].filter(Boolean).join('\n')}
      >
        <span className="history-item-sender">
          <ChatRowBadge item={item} />
        </span>
        <span className="history-item-title">{title}</span>
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
            <button
              type="button"
              role="menuitem"
              className="history-menu-item"
              onClick={() => {
                onOpenMenu(null);
                onResetApprovals(item.id);
              }}
            >
              Reset approvals
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

/**
 * One open tab's row: the badge, the title, and either a running dot or the
 * state word. A streaming chat gets the dot instead of `◌ Running` text — the
 * dot is what you look for when deciding whether to switch into a chat, and the
 * word said the same thing slower and wider. Every other open tab still says
 * `Open`, `Queued` or `Waiting`, because those states carry information the
 * dot cannot: `Waiting` means a card is holding a person's answer.
 */
export function HistoryOpenRow({
  item,
  active,
  live,
  onSwitch,
  onClose,
  onSetKeepOpen,
}: {
  item: SessionTabMeta;
  active: boolean;
  live: 'running' | 'waiting' | 'queued' | 'open';
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onSetKeepOpen: (id: string, keepOpen: boolean) => void;
}): ReactElement {
  return (
    <div className="history-item-row">
      <button
        type="button"
        className="history-item history-chat-item"
        aria-current={active ? 'page' : undefined}
        title={[absoluteTime(item.updatedAt), item.active_model].filter(Boolean).join('\n')}
        onClick={() => onSwitch(item.id)}
      >
        <span className="history-item-sender">
          <ChatRowBadge item={item} />
        </span>
        <span className="history-item-title">{item.title}</span>
        {live === 'running' ? (
          <span className="history-item-meta history-item-meta-running history-item-status">
            <span className="history-row-dot history-row-dot--running" aria-hidden="true" />
            Running
          </span>
        ) : (
          <span
            className={`history-item-meta history-item-status${live === 'waiting' ? ' history-item-meta-waiting' : ''}`}
          >
            {live === 'queued' ? 'Queued' : live === 'waiting' ? 'Waiting' : 'Open'}
          </span>
        )}
      </button>
      <div className="history-item-row-actions">
        <button
          type="button"
          className={`history-item-keep-open${item.keep_open ? ' is-pinned' : ''}`}
          aria-label={
            item.keep_open ? `Allow auto-archive for ${item.title}` : `Keep ${item.title} open`
          }
          aria-pressed={item.keep_open === true}
          title={item.keep_open ? 'Allow auto-archive' : 'Keep open'}
          onClick={() => onSetKeepOpen(item.id, item.keep_open !== true)}
        >
          <PinIcon />
        </button>
        <button
          type="button"
          className="history-item-kebab history-item-close"
          aria-label={`Close ${item.title}`}
          title="Close"
          onClick={() => onClose(item.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** `12 msg · 3d ago`: the age a row shows, and the single owner of that wording. */
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

/** The row's hover text: when it last moved, to the minute. */
export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const KebabIcon = (): ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="3.5" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="8" cy="12.5" r="1.4" />
  </svg>
);

const PinIcon = (): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 2.5h6l-.7 3.2 1.7 1.7v1H8.5v4.8L8 14l-.5-.8V8.4H4v-1l1.7-1.7L5 2.5z" />
  </svg>
);

const RenameIcon = (): ReactElement => (
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

const TrashIcon = (): ReactElement => (
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
