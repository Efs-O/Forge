import React, { useEffect, useRef, useState } from 'react';
import type { AppMessage } from '../reducer';

/** px from the bottom of the reasoning pane within which auto-scroll stays armed. */
const PIN_THRESHOLD = 24;

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

/**
 * True for an assistant message that carries only reasoning. The agent loop opens
 * a fresh assistant message every round (a tool row lands between rounds), so a
 * long turn produces one of these per round — rendered with the full role label
 * and bubble chrome they buried the actual work.
 */
export function isReasoningOnly(msg: AppMessage): boolean {
  return msg.role === 'assistant' && !msg.content && Boolean(msg.reasoning);
}

function ThinkingRow({
  label,
  reasoning,
}: {
  label: string;
  reasoning: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  // The pane is its own scroll container (max-height + overflow-y in
  // tool-rows.css), so the message list's auto-scroll never reaches it. Reasoning
  // streams in token by token, so keep the newest text in view here — until the
  // user scrolls up to read back, which disarms it for the rest of this run.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) {
      // Collapsed: the pane unmounts and remounts at scrollTop 0, so re-arm.
      pinned.current = true;
      return;
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [reasoning, open]);

  const handleScroll = (): void => {
    const el = contentRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
  };

  return (
    <div className="thinking-row">
      <button
        className="thinking-row-toggle"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-row-chevron">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="thinking-row-label">{label}</span>
      </button>
      {open && (
        <pre ref={contentRef} className="thinking-content" onScroll={handleScroll}>
          {reasoning}
        </pre>
      )}
    </div>
  );
}

interface Props {
  /** A run of adjacent reasoning-only assistant messages, in order. */
  steps: AppMessage[];
}

export function ThinkingGroup({ steps }: Props): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0) return null;

  if (steps.length === 1) {
    return <ThinkingRow label="Thinking" reasoning={steps[0]!.reasoning ?? ''} />;
  }

  return (
    <div className="thinking-group">
      <button
        className="thinking-row-toggle"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="thinking-row-chevron">
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </span>
        <span className="thinking-row-label">Thinking ({steps.length} steps)</span>
      </button>
      {expanded && (
        <div className="thinking-group-body">
          {steps.map((step, i) => (
            <ThinkingRow key={step.id} label={`Step ${i + 1}`} reasoning={step.reasoning ?? ''} />
          ))}
        </div>
      )}
    </div>
  );
}
