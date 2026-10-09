import React, { useMemo } from 'react';
import type { DiffHunk } from '../../../src/sidebar/messageBridge';
import { vscode } from '../vscode';
import { useDisclosure } from '../disclosureState';

import { diffStats } from '../../../src/sidebar/diffMessages';
export { diffStats, type DiffStats } from '../../../src/sidebar/diffMessages';

interface Props {
  /** The diff message's id; keys the reader's open/closed choice. Starts closed. */
  id: string;
  filePath: string;
  hunks: DiffHunk[] | null | undefined;
  isNew?: boolean;
  isDeleted?: boolean;
}

export function DiffBlock({ id, filePath, hunks, isNew, isDeleted }: Props): React.ReactElement {
  const allLines = useMemo(() => hunks?.flatMap((h) => h.lines) ?? [], [hunks]);
  const { added, removed } = useMemo(() => diffStats(hunks), [hunks]);
  const [choice, setChoice] = useDisclosure('diff', id);
  const expanded = choice ?? false;

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
          <button className="diff-toggle" type="button" onClick={() => setChoice(!expanded)}>
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
