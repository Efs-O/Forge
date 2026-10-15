import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toolNameAndDetail } from '../messageOps';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppMessage } from '../reducer';
import { vscode } from '../vscode';
import { normalizeMarkdownForRender } from '../markdown';
import { rendersAsMarkdown } from '../../../src/sidebar/toolResultView';
import { formatDuration } from '../../../src/util/formatDuration';
import { useDisclosure } from '../disclosureState';
import { foldConsecutiveLines } from '../toolResultLines';
import { ToolRowThumbnails } from './ToolThumbnails';

export { ToolRowThumbnails } from './ToolThumbnails';

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

function formatSize(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

/** Below this a result is compact enough that a size label adds little. */
const EXPANDABLE_MIN_CHARS = 100;

/**
 * Renders a call's result without adding another call row around it.
 * `folded`: the result sits behind its own `Output` toggle, closed until the
 * reader opens it - an opened step (or reasoning that folded into one) shows
 * the call, not every byte it returned.
 */
export function ToolResultContent({
  message,
  command,
  folded = false,
}: {
  message: AppMessage;
  command?: string;
  folded?: boolean;
}): React.ReactElement {
  const [choice, setChoice] = useDisclosure('output', message.id);
  const result = message.toolResult ?? '';
  const showBody = !folded || choice === true;
  const body = useMemo(
    () => (showBody ? normalizeMarkdownForRender(foldConsecutiveLines(result)) : ''),
    [result, showBody],
  );
  const asMarkdown = rendersAsMarkdown(message.toolName ?? '');

  return (
    <>
      {command && (
        <div className="tool-row-command">
          <div className="tool-row-command-label">Command</div>
          <code>{command}</code>
        </div>
      )}
      {result && (
        <div className={`tool-row-output${folded ? ' is-folded' : ''}`}>
          {folded ? (
            <button
              className="tool-row-output-label tool-row-output-toggle"
              type="button"
              aria-expanded={showBody}
              onClick={() => setChoice(!showBody)}
            >
              {showBody ? '▾' : '▸'} Output · {formatSize(message.toolResultTotal ?? result.length)}
            </button>
          ) : (
            <div className="tool-row-output-label">Output</div>
          )}
          {showBody && (
            <div className="tool-row-output-body">
              {asMarkdown ? (
                <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
              ) : (
                <pre className="tool-row-verbatim">{body}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One line per tool call. A long result — a delegated agent's report, most of
 * all — stays behind a toggle and renders as markdown with its newlines intact,
 * instead of being flattened into a 600-char grey ribbon.
 */
export function ToolRow({
  message,
  nested = false,
}: {
  message: AppMessage;
  nested?: boolean;
}): React.ReactElement {
  const [choice, setChoice] = useDisclosure('tool', message.id);
  const { name: toolName, detail } = toolNameAndDetail(message);
  const result = message.toolResult ?? '';
  const expandable = Boolean(result || detail);
  const longContent =
    result.length >= EXPANDABLE_MIN_CHARS || detail.length >= EXPANDABLE_MIN_CHARS;
  const open = choice ?? message.toolIsError === true;
  const elapsed = formatDuration(message.toolMs);
  const status = message.toolIsError
    ? { className: 'is-error', glyph: '✕', label: 'failed' }
    : message.toolResultTotal !== undefined
      ? { className: 'is-ok', glyph: '✓', label: 'completed' }
      : { className: 'is-pending', glyph: '○', label: 'running' };
  const targetRef = useRef<HTMLSpanElement>(null);
  const [commandVisible, setCommandVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setCommandVisible(false);
      return;
    }
    const target = targetRef.current;
    setCommandVisible(Boolean(detail && target && target.scrollWidth > target.clientWidth));
  }, [detail, open]);

  return (
    <div className={`msg-tool-row-wrap${message.toolIsError ? ' msg-tool-row-error' : ''}`}>
      <div className="msg-tool-row" title={elapsed || undefined}>
        <span className={`tool-row-status ${status.className}`} title={status.label}>
          {status.glyph}
        </span>
        {expandable ? (
          <button
            className="tool-row-toggle"
            type="button"
            onClick={() => setChoice(!open)}
            aria-expanded={open}
            title={open ? 'Hide result' : 'Show result'}
          >
            <span className="tool-row-chevron">{open ? <ChevronDown /> : <ChevronRight />}</span>
            <span className="tool-row-name">{toolName}</span>
          </button>
        ) : (
          <span className="tool-row-name">{toolName}</span>
        )}
        {detail && !nested && (
          <span ref={targetRef} className="tool-row-detail" title={detail}>
            {detail}
          </span>
        )}
        {elapsed && <span className="tool-row-time">{elapsed}</span>}
        {longContent && (
          <span className="tool-row-size">
            {formatSize(message.toolResultTotal ?? result.length)}
          </span>
        )}
        {message.toolFilePath && (
          <button
            className="tool-row-open"
            type="button"
            title={`Open ${message.toolFilePath}`}
            onClick={(e) =>
              vscode.postMessage({
                type: 'openFile',
                path: message.toolFilePath!,
                ...(e.ctrlKey || e.metaKey ? { beside: true } : {}),
              })
            }
          >
            open
          </button>
        )}
      </div>
      <ToolRowThumbnails message={message} />
      {open && (
        <div className="tool-row-body">
          <ToolResultContent
            message={message}
            {...(commandVisible && detail ? { command: detail } : {})}
          />
        </div>
      )}
    </div>
  );
}
