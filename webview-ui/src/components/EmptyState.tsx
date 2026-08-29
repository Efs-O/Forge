import React from 'react';
import type { ModelResidency } from '../../../src/sidebar/messageBridge';

interface Props {
  modelName: string | null;
  residency?: ModelResidency | undefined;
  provider?: string | undefined;
  /** Per-slot context window. 0 = unknown, which renders no ctx line. */
  contextMax: number;
}

export interface BackendDescription {
  tone: 'ok' | 'warn' | 'idle';
  primary: string;
  secondary?: string;
}

/**
 * What the empty tab says about the backend, as a pure table.
 *
 * `residency` is absent for every remote route by design (see `ModelEntry` in
 * messageBridge): rendering those as `cold` would advertise a load cost that
 * does not exist, so they get the provider name instead.
 *
 * Deliberately says nothing about `backendReady`: that flag is global while
 * conversations run independently, so a failure in one tab would otherwise
 * mark an unrelated empty tab unavailable. A backend error is already appended
 * to its own conversation as a row — which also means that conversation is no
 * longer empty and this component is not rendered for it.
 */
export function describeBackend({
  modelName,
  residency,
  provider,
  contextMax,
}: Props): BackendDescription {
  if (!modelName) return { tone: 'idle', primary: 'no model selected' };

  const ctx = contextMax > 0 ? `${formatContext(contextMax)} ctx per slot` : undefined;

  if (residency === 'loading') {
    return { tone: 'warn', primary: `${modelName} · loading`, secondary: 'spawning llama-server…' };
  }
  if (residency === 'cold') {
    return {
      tone: 'idle',
      primary: `${modelName} · not loaded`,
      ...(ctx ? { secondary: ctx } : {}),
    };
  }
  if (residency === 'ready') {
    return { tone: 'ok', primary: `${modelName} · resident`, ...(ctx ? { secondary: ctx } : {}) };
  }
  // No residency: a remote route. Name the provider rather than a load state.
  return {
    tone: 'ok',
    primary: provider ? `${modelName} · ${provider}` : modelName,
    ...(ctx ? { secondary: ctx } : {}),
  };
}

function formatContext(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
  }
  return String(tokens);
}

/** The Forge mark, from assets/icon.svg. Inlined the way TabStrip inlines its icons. */
const ForgeMark = (): React.ReactElement => (
  <svg id="empty-mark" viewBox="0 0 24 24" width="52" height="52" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    <rect x="9" y="4" width="1.5" height="3" rx="0.5" fill="currentColor" />
    <rect x="13.5" y="4" width="1.5" height="3" rx="0.5" fill="currentColor" />
    <rect x="9" y="17" width="1.5" height="3" rx="0.5" fill="currentColor" />
    <rect x="13.5" y="17" width="1.5" height="3" rx="0.5" fill="currentColor" />
    <rect x="4" y="9" width="3" height="1.5" rx="0.5" fill="currentColor" />
    <rect x="4" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor" />
    <rect x="17" y="9" width="3" height="1.5" rx="0.5" fill="currentColor" />
    <rect x="17" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor" />
  </svg>
);

const DOT_CLASS: Record<BackendDescription['tone'], string> = {
  ok: 'ms-dot ms-dot--ready',
  warn: 'ms-dot ms-dot--loading',
  idle: 'ms-dot ms-dot--cold',
};

/**
 * What a tab with no messages shows: the mark, plus the backend facts a local
 * model has and a hosted endpoint does not.
 */
export function EmptyState(props: Props): React.ReactElement {
  const { tone, primary, secondary } = describeBackend(props);
  return (
    <div id="empty-state" role="status">
      <ForgeMark />
      <div id="empty-status">
        <p className="empty-line empty-line--primary">
          <span className={DOT_CLASS[tone]} aria-hidden="true" />
          {primary}
        </p>
        {secondary && <p className="empty-line">{secondary}</p>}
      </div>
    </div>
  );
}
