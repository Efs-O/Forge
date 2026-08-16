import React, { useMemo, useState } from 'react';
import type { DiffHunk } from '../../../src/sidebar/messageBridge';
import { vscode } from '../vscode';

const DIFF_COLLAPSE_THRESHOLD = 50;

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(hunks: DiffHunk[] | null | undefined): DiffStats {
  const lines = hunks?.flatMap((h) => h.lines) ?? [];
  return {
    added: lines.filter((l) => l.kind === 'added').length,
    removed: lines.filter((l) => l.kind === 'removed').length,
  };
}

interface Props {
  filePath: string;
  hunks: DiffHunk[] | null | undefined;
  isNew?: boolean;
  isDeleted?: boolean;
  /**
   * Omitted, a block opens unless it is large. Inside a group every row starts
   * closed regardless of size — the group header is the thing being read.
   */
  defaultExpanded?: boolean;
}

export function DiffBlock({
  filePath,
  hunks,
  isNew,
  isDeleted,
  defaultExpanded,
}: Props): React.ReactElement {
  const allLines = useMemo(() => hunks?.flatMap((h) => h.lines) ?? [], [hunks]);
  const { added, removed } = useMemo(() => diffStats(hunks), [hunks]);
  const large = allLines.length > DIFF_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(defaultExpanded ?? !large);

  const badge = isDeleted ? 'deleted' : isNew ? 'new' : 'modified';

  return (
    <div className="diff-block">
      <div className="diff-header">
        <span className="diff-indicator">●</span>
        <span className={`diff-badge diff-badge-${badge}`}>{badge}</span>
        <button
          className="diff-filepath diff-filepath-link"
          type="button"
          title={`Open ${filePath}`}
          onClick={() => vscode.postMessage({ type: 'openFile', path: filePath })}
        >
          {filePath}
        </button>
        {added > 0 && <span className="diff-stat diff-stat-added">+{added}</span>}
        {removed > 0 && <span className="diff-stat diff-stat-removed">−{removed}</span>}
        {allLines.length > 0 && (
          <button className="diff-toggle" type="button" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'collapse' : `show ${allLines.length} lines`}
          </button>
        )}
      </div>
      {expanded && (
        <div className="diff-body">
          {hunks === null && <div className="diff-toolarge">Diff unavailable.</div>}
          {isDeleted && !hunks && <div className="diff-toolarge">File deleted.</div>}
          {hunks?.length === 0 && <div className="diff-toolarge">No changes.</div>}
          {hunks?.map((hunk, hi) => (
            <div key={hi} className="diff-hunk">
              {hunk.lines.map((line, li) => (
                <div key={li} className={`diff-line diff-line-${line.kind}`}>
                  <span className="diff-gutter">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </span>
                  <span className="diff-line-text">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
