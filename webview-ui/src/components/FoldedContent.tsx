import React from 'react';
import { useFoldChoice } from '../disclosureState';

const PREVIEW_LINES = 4;
const PREVIEW_LINE_CHARS = 240;

function tailPreview(content: string): string {
  return content
    .split(/\r\n|\r|\n/u)
    .slice(-PREVIEW_LINES)
    .map((line) =>
      line.length > PREVIEW_LINE_CHARS ? `…${line.slice(-(PREVIEW_LINE_CHARS - 1))}` : line,
    )
    .join('\n');
}

export function isShortToolOutput(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length <= 200 && trimmed.split(/\r\n|\r|\n/u).length <= 3;
}

export function isLongThinking(content: string): boolean {
  return content.trim().split(/\r\n|\r|\n/u).length > 5;
}

export function FoldedContent({
  id,
  content,
  foldable,
  defaultShowAll,
  className = '',
  renderContent,
}: {
  id: string;
  content: string;
  foldable: boolean;
  defaultShowAll: boolean;
  className?: string;
  renderContent?: (content: string) => React.ReactNode;
}): React.ReactElement {
  const [choice, setChoice] = useFoldChoice(id);
  const showAll = choice.showAll ?? defaultShowAll;
  const visibleContent = showAll ? content : tailPreview(content);

  return (
    <div className={`folded-content ${className}`.trim()}>
      <div className={`folded-content-body${foldable && !showAll ? ' is-tail-preview' : ''}`}>
        {renderContent ? renderContent(visibleContent) : <pre>{visibleContent}</pre>}
      </div>
      {foldable && (
        <button
          type="button"
          className="folded-content-toggle"
          aria-expanded={showAll}
          onClick={() => setChoice({ showAll: !showAll })}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
