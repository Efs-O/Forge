import React from 'react';
import type { SessionTabMeta } from '../../../src/sidebar/messageBridge';

interface Props {
  tabs: SessionTabMeta[];
  activeId: string;
  streamingIds: ReadonlySet<string>;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
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

export function TabStrip({
  tabs,
  activeId,
  streamingIds,
  onSwitch,
  onNew,
  onClose,
}: Props): React.ReactElement {
  return (
    <div id="tab-strip-wrap" aria-label="Conversation tabs">
      <div id="tab-strip-scroll" role="tablist">
        {tabs.map((tab) => {
          const sel = tab.id === activeId;
          const live = streamingIds.has(tab.id);
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
                title={`${tab.title} — active time ${formatSessionDuration(tab.active_time_ms ?? 0)}`}
                onClick={() => onSwitch(tab.id)}
              >
                {live && !sel && <span className="tab-streaming-dot" aria-label="generating" />}
                {label}
              </button>
              <span
                className="tab-chip-time"
                title={`Active agent time: ${formatSessionDuration(tab.active_time_ms ?? 0)}`}
                aria-label={`Active agent time ${formatSessionDuration(tab.active_time_ms ?? 0)}`}
              >
                {formatSessionDuration(tab.active_time_ms ?? 0)}
              </span>
              <button
                type="button"
                className="tab-chip-close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
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
  );
}

function formatSessionDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
