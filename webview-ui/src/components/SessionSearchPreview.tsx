import type { ReactElement } from 'react';
import {
  parseSessionSearchQuery,
  sessionSearchSegments,
} from '../../../src/sidebar/sessionSearchQuery';

/** Literal matches become text/mark nodes, never HTML from an archived chat. */
export function SessionSearchText({ text, query }: { text: string; query: string }): ReactElement {
  return (
    <>
      {sessionSearchSegments(text, parseSessionSearchQuery(query)).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

export function SessionSearchPreview({
  snippet,
  query,
}: {
  snippet?: string;
  query: string;
}): ReactElement | null {
  if (!snippet || !query.trim()) return null;
  return (
    <span className="history-search-preview">
      <SessionSearchText text={snippet} query={query} />
    </span>
  );
}
