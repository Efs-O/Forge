import React, { useState } from 'react';
import type { AppMessage } from '../reducer';

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

/**
 * `Thinking · 4.2s`, or plain `Thinking` when there is no measurement.
 *
 * A bare chevron gives no reason to open the row and no signal that reasoning
 * was expensive - and on a shared output budget, where thinking and the answer
 * draw on the same pool, that is the number worth seeing. Rehydrated rows carry
 * no timing (`PersistedRow` does not persist it), hence the fallback.
 */
export function thinkingLabel(base: string, ms: number | undefined): string {
  if (ms === undefined || ms < 100) return base;
  const seconds = ms / 1000;
  return `${base} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** Total measured reasoning across a run of steps; undefined when none is. */
function totalReasoningMs(steps: AppMessage[]): number | undefined {
  const measured = steps.filter((step) => step.reasoningMs !== undefined);
  if (measured.length === 0) return undefined;
  return measured.reduce((sum, step) => sum + (step.reasoningMs ?? 0), 0);
}

function ThinkingRow({
  label,
  reasoning,
}: {
  label: string;
  reasoning: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);

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
        <pre className="thinking-content" data-inner-scroll="false">
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
    return (
      <ThinkingRow
        label={thinkingLabel('Thinking', steps[0]!.reasoningMs)}
        reasoning={steps[0]!.reasoning ?? ''}
      />
    );
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
        <span className="thinking-row-label">
          {thinkingLabel(`Thinking (${steps.length} steps)`, totalReasoningMs(steps))}
        </span>
      </button>
      {expanded && (
        <div className="thinking-group-body">
          {steps.map((step, i) => (
            <ThinkingRow
              key={step.id}
              label={thinkingLabel(`Step ${i + 1}`, step.reasoningMs)}
              reasoning={step.reasoning ?? ''}
            />
          ))}
        </div>
      )}
    </div>
  );
}
