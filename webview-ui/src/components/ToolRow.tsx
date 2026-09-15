import React, { useCallback, useContext, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppMessage } from '../reducer';
import { vscode } from '../vscode';
import { normalizeMarkdownForRender } from '../markdown';
import {
  generatedImagePath,
  imageSearchThumbnails,
  rendersAsMarkdown,
} from '../../../src/sidebar/toolResultView';
import { WorkspaceRootUriContext, workspaceFileUri } from '../workspaceRootUri';
import { ImageLightbox } from './ImageLightbox';
import { formatDuration } from '../../../src/util/formatDuration';

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

/** Below this a result or command is short enough that expanding it adds little. */
const EXPANDABLE_MIN_CHARS = 100;

function formatSize(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

/**
 * One line per tool call. A long result — a delegated agent's report, most of
 * all — stays behind a toggle and renders as markdown with its newlines intact,
 * instead of being flattened into a 600-char grey ribbon.
 */
export function ToolRow({ message }: { message: AppMessage }): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Index of the thumbnail open in the lightbox, or null.
  const [expanded, setExpanded] = useState<number | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const rootUri = useContext(WorkspaceRootUriContext);

  const arrow = message.content.indexOf(' → ');
  const name = arrow !== -1 ? message.content.slice(0, arrow) : message.content;
  const detail = message.toolDetail ?? (arrow !== -1 ? message.content.slice(arrow + 3) : '');

  const result = message.toolResult ?? '';
  const expandable = result.length >= EXPANDABLE_MIN_CHARS || detail.length >= EXPANDABLE_MIN_CHARS;
  const asMarkdown = rendersAsMarkdown(message.toolName ?? '');
  // Only rows whose call Forge saw both announced and returned carry one, so an
  // absent duration means unmeasured - never "instant".
  const elapsed = formatDuration(message.toolMs);
  // A row exists from the moment the call is announced, so it has three states,
  // not two. `toolResultTotal` is the field TOOL_RESULT always sets - an empty
  // `toolResult` is a tool that returned nothing, not one still running.
  const status = message.toolIsError
    ? { className: 'is-error', glyph: '✕', label: 'failed' }
    : message.toolResultTotal !== undefined
      ? { className: 'is-ok', glyph: '✓', label: 'completed' }
      : { className: 'is-pending', glyph: '○', label: 'running' };
  const body = useMemo(() => normalizeMarkdownForRender(result), [result]);
  const toolName = message.toolName ?? '';
  const generated = generatedImagePath(toolName, result);
  const listed = generated ? [{ path: generated }] : imageSearchThumbnails(toolName, result);
  const images = rootUri
    ? listed.map((entry) => ({
        attachment: {
          name: entry.path,
          mediaType: 'image/*',
          bytes: 0,
          src: workspaceFileUri(rootUri, entry.path),
        },
        original: 'original' in entry ? entry.original : undefined,
      }))
    : [];
  const openImage = expanded === null ? undefined : images[expanded];

  return (
    <div className={`msg-tool-row-wrap${message.toolIsError ? ' msg-tool-row-error' : ''}`}>
      <div className="msg-tool-row">
        <span className={`tool-row-status ${status.className}`} title={status.label}>
          {status.glyph}
        </span>
        {expandable ? (
          <button
            className="tool-row-toggle"
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? 'Hide result' : 'Show full result'}
          >
            <span className="tool-row-chevron">{open ? <ChevronDown /> : <ChevronRight />}</span>
            <span className="tool-row-name">{name}</span>
          </button>
        ) : (
          <span className="tool-row-name">{name}</span>
        )}
        {detail && <span className="tool-row-detail">{detail}</span>}
        {elapsed && <span className="tool-row-time">{elapsed}</span>}
        {expandable && (
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
      {images.length > 0 && (
        <div className={`tool-row-thumbs${images.length > 1 ? ' is-grid' : ''}`}>
          {images.map(({ attachment }, index) => (
            <button
              key={attachment.name}
              type="button"
              className="tool-row-thumb"
              title={`${attachment.name} — click to expand`}
              onClick={() => setExpanded(index)}
            >
              <img src={attachment.src} alt={attachment.name} />
            </button>
          ))}
        </div>
      )}
      {openImage && (
        <ImageLightbox
          attachment={openImage.attachment}
          onClose={closeExpanded}
          {...(openImage.original ? { originalUrl: openImage.original } : {})}
        />
      )}
      {open && (
        <div className="tool-row-body">
          {detail && (
            <div className="tool-row-command">
              <div className="tool-row-command-label">Command / details</div>
              <code>{detail}</code>
            </div>
          )}
          {result &&
            (asMarkdown ? (
              <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
            ) : (
              <pre className="tool-row-verbatim">{result}</pre>
            ))}
        </div>
      )}
    </div>
  );
}
