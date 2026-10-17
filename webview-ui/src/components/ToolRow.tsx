import React, { useEffect, useRef, useState } from 'react';
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
import { displayDetail } from '../activityRows';
import { ToolRowThumbnails } from './ToolThumbnails';
import { FoldedContent, isShortToolOutput } from './FoldedContent';

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

/** A one-line command past this wraps into several lines of a narrow sidebar. */
const COMMAND_FOLD_MIN_CHARS = 200;

function CommandBlock({
  messageId,
  command,
}: {
  messageId: string;
  command: string;
}): React.ReactElement {
  const [choice, setChoice] = useDisclosure('command', messageId);
  const lines = command.split(/\r\n|\r|\n/u);
  // A single line long enough to wrap into a paragraph (an `rg` over many
  // paths) bloats the step as much as a script does.
  const foldable = lines.length > 1 || command.length > COMMAND_FOLD_MIN_CHARS;
  const showBody = !foldable || choice === true;
  const summary = displayDetail(command).split(/\r\n|\r|\n/u, 1)[0] ?? '';
  const size = lines.length > 1 ? `${lines.length} lines` : formatSize(command.length);

  return (
    <div className="tool-row-command">
      {foldable ? (
        <button
          className="tool-row-output-label tool-row-content-toggle tool-row-command-toggle"
          type="button"
          aria-expanded={showBody}
          onClick={() => setChoice(!showBody)}
        >
          <span className="tool-row-command-toggle-label">
            {showBody ? '▾' : '▸'} Command · {size}
          </span>
          {!showBody && <span className="tool-row-command-summary"> {summary}</span>}
        </button>
      ) : (
        <div className="tool-row-command-label">Command</div>
      )}
      {showBody && (
        <div className="tool-row-command-body tool-row-scroll-body">
          <code>{command}</code>
        </div>
      )}
    </div>
  );
}

/**
 * Renders a call's result without adding another call row around it.
 * Short results stay inline; longer results share the tail preview used by
 * finished thinking blocks.
 */
export function ToolResultContent({
  message,
  command,
}: {
  message: AppMessage;
  command?: string;
}): React.ReactElement {
  const result = message.toolResult ?? '';
  const displayResult = foldConsecutiveLines(result);
  const short = isShortToolOutput(result);
  const asMarkdown = rendersAsMarkdown(message.toolName ?? '');

  return (
    <>
      {command && <CommandBlock messageId={message.id} command={command} />}
      {result && (
        <div className={`tool-row-output${message.toolIsError ? ' is-error' : ''}`}>
          <FoldedContent
            key={`output:${message.id}`}
            id={`output:${message.id}`}
            content={displayResult}
            foldable={!short}
            defaultShowAll={short}
            className="tool-row-output-content"
            renderContent={(text) =>
              asMarkdown ? (
                <Markdown remarkPlugins={[remarkGfm]}>{normalizeMarkdownForRender(text)}</Markdown>
              ) : (
                <pre className="tool-row-verbatim">{text}</pre>
              )
            }
          />
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
