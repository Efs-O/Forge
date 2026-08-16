import React, { useMemo, useState } from 'react';
import type { AppMessage } from '../reducer';
import { DiffBlock, diffStats } from './DiffBlock';

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

interface Props {
  /** A run of adjacent `role: 'diff'` messages, in the order they were written. */
  diffs: AppMessage[];
}

/**
 * Rolls a turn's file edits into one summary card. A single edited file keeps its
 * standalone block — grouping one row behind a disclosure would cost a click for
 * no gain — while several collapse to a header the reader can skip past.
 */
export function DiffGroup({ diffs }: Props): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  const totals = useMemo(
    () =>
      diffs.reduce(
        (acc, msg) => {
          const { added, removed } = diffStats(msg.diffHunks);
          return { added: acc.added + added, removed: acc.removed + removed };
        },
        { added: 0, removed: 0 },
      ),
    [diffs],
  );

  if (diffs.length === 0) return null;

  if (diffs.length === 1) {
    const only = diffs[0]!;
    return (
      <DiffBlock
        filePath={only.content}
        hunks={only.diffHunks}
        isNew={only.diffIsNew}
        isDeleted={only.diffIsDeleted}
      />
    );
  }

  return (
    <div className={`diff-group${expanded ? ' diff-group-open' : ''}`}>
      <button
        className="diff-group-header"
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="diff-group-chevron">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="diff-group-label">Edited {diffs.length} files</span>
        {totals.added > 0 && <span className="diff-stat diff-stat-added">+{totals.added}</span>}
        {totals.removed > 0 && (
          <span className="diff-stat diff-stat-removed">−{totals.removed}</span>
        )}
      </button>
      {expanded && (
        <div className="diff-group-body">
          {diffs.map((msg) => (
            <DiffBlock
              key={msg.id}
              filePath={msg.content}
              hunks={msg.diffHunks}
              isNew={msg.diffIsNew}
              isDeleted={msg.diffIsDeleted}
              defaultExpanded={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
