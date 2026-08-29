import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionTabMeta } from '../../../src/sidebar/messageBridge';

interface Props {
  tabs: SessionTabMeta[];
  activeId: string;
  streamingIds: ReadonlySet<string>;
  /** Tabs holding a prompt that has not been submitted yet. */
  queuedIds: ReadonlySet<string>;
  historyCount: number;
  historyExpanded: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onToggleHistory: () => void;
}

const CloseIcon = (): React.ReactElement => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path
      d="M1.5 1.5l7 7M8.5 1.5l-7 7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const PlusIcon = (): React.ReactElement => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const ClockIcon = (): React.ReactElement => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 3.5v3.8l2.3 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const ChevronLeft = (): React.ReactElement => (
  <svg width="9" height="12" viewBox="0 0 9 12" fill="none" aria-hidden="true">
    <path
      d="M7 1 2 6l5 5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ChevronRight = (): React.ReactElement => (
  <svg width="9" height="12" viewBox="0 0 9 12" fill="none" aria-hidden="true">
    <path
      d="m2 1 5 5-5 5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function TabStrip({
  tabs,
  activeId,
  streamingIds,
  queuedIds,
  historyCount,
  historyExpanded,
  onSwitch,
  onNew,
  onClose,
  onToggleHistory,
}: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 1);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const element = scrollRef.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
    observer?.observe(element);
    element.addEventListener('scroll', updateScrollState, { passive: true });
    return () => {
      observer?.disconnect();
      element.removeEventListener('scroll', updateScrollState);
    };
  }, [tabs.length, updateScrollState]);

  const scrollTabs = (direction: -1 | 1): void => {
    scrollRef.current?.scrollBy({ left: direction * 150, behavior: 'smooth' });
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = event.target;
    if (!(current instanceof HTMLButtonElement) || !current.classList.contains('tab-chip-label'))
      return;
    const buttons = Array.from(
      scrollRef.current?.querySelectorAll<HTMLButtonElement>('.tab-chip-label') ?? [],
    );
    const index = buttons.indexOf(current);
    if (index < 0) return;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : index + (event.key === 'ArrowRight' ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    event.preventDefault();
    const next = buttons[nextIndex];
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const nextId = next.dataset.tabId;
    if (nextId) onSwitch(nextId);
  };

  return (
    <div id="tab-strip-wrap" aria-label="Conversation tabs">
      <div id="chats-toolbar">
        <span id="chats-heading">Sessions</span>
        <div id="chats-toolbar-actions">
          <button
            id="history-toolbar-btn"
            type="button"
            aria-label="All sessions"
            aria-expanded={historyExpanded}
            title="All sessions"
            onClick={onToggleHistory}
          >
            <ClockIcon />
            {historyCount > 0 && <span id="history-toolbar-count">{historyCount}</span>}
          </button>
          <button
            id="tab-new-btn"
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={onNew}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div id="tab-strip-row">
        <button
          className="tab-nav-btn"
          type="button"
          aria-label="Scroll conversations left"
          title="Previous conversation"
          disabled={!canScrollLeft}
          onClick={() => scrollTabs(-1)}
        >
          <ChevronLeft />
        </button>
        <div id="tab-strip-scroll" ref={scrollRef} role="tablist" onKeyDown={handleTabKeyDown}>
          {tabs.map((tab) => {
            const sel = tab.id === activeId;
            const live = streamingIds.has(tab.id);
            // Distinct from `live` on purpose: a spinner on a tab that is
            // merely waiting reads as a hang.
            const waiting = !live && queuedIds.has(tab.id);
            const label = tab.title.length > 20 ? `${tab.title.slice(0, 20)}…` : tab.title;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={sel}
                className={`tab-chip${sel ? ' tab-chip-active' : ''}${live && !sel ? ' tab-chip-streaming' : ''}`}
              >
                <button
                  type="button"
                  className="tab-chip-label"
                  data-tab-id={tab.id}
                  tabIndex={sel ? 0 : -1}
                  title={`${tab.title}${waiting ? ' — queued' : ''} — active time ${formatSessionDuration(tab.active_time_ms ?? 0)}`}
                  onClick={() => onSwitch(tab.id)}
                >
                  {live && <span className="tab-streaming-spinner" aria-label="generating" />}
                  {waiting && <span className="tab-waiting-dot" aria-label="queued" />}
                  {label}
                </button>
                <button
                  type="button"
                  className="tab-chip-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="tab-nav-btn"
          type="button"
          aria-label="Scroll conversations right"
          title="Next conversation"
          disabled={!canScrollRight}
          onClick={() => scrollTabs(1)}
        >
          <ChevronRight />
        </button>
      </div>
    </div>
  );
}

function formatSessionDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
