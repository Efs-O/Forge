import React, { useCallback, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AppMessage } from '../App';
import type { DiffHunk } from '../../../src/sidebar/messageBridge';
import { vscode } from '../vscode';

const FILE_LINK_SCHEME = 'forge-file://';

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

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  a: ({ href, children, ...props }) => {
    if (href?.startsWith(FILE_LINK_SCHEME)) {
      const filePath = decodeURIComponent(href.slice(FILE_LINK_SCHEME.length));
      return (
        <a {...props} href={href} onClick={(e) => { e.preventDefault(); vscode.postMessage({ type: 'openFile', path: filePath }); }}>
          {children}
        </a>
      );
    }
    return <a {...props} href={href}>{children}</a>;
  },
};

function AssistantContent({ content, streaming }: { content: string; streaming?: boolean }): React.ReactElement {
  const { settled, live } = useMemo(
    () => streaming ? splitStreamingContent(content) : { settled: content, live: '' },
    [content, streaming],
  );

  if (!streaming) {
    return <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{content}</Markdown>;
  }

  return (
    <>
      {settled && (
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{settled}</Markdown>
      )}
      <span className="streaming-tail">{live}</span>
      <span className="streaming-cursor" aria-hidden="true" />
    </>
  );
}

// ── Diff block ────────────────────────────────────────────────────────────────

function hunkHeader(h: DiffHunk): string {
  const oldCount = h.lines.filter(l => l.kind !== 'added').length;
  const newCount = h.lines.filter(l => l.kind !== 'removed').length;
  return `@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`;
}

function DiffBlock({ filePath, hunks, isNew, isDeleted }: {
  filePath: string;
  hunks: DiffHunk[] | null | undefined;
  isNew?: boolean;
  isDeleted?: boolean;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  const badge = isDeleted ? 'deleted' : isNew ? 'new' : 'modified';

  return (
    <div className="diff-block">
      <button className="diff-header" type="button" onClick={() => setCollapsed(c => !c)}>
        <span className={`diff-badge diff-badge-${badge}`}>{badge}</span>
        <span className="diff-filepath">{filePath}</span>
        <span className="diff-chevron">{collapsed ? '›' : '‹'}</span>
      </button>
      {!collapsed && (
        <div className="diff-body">
          {hunks === null && (
            <div className="diff-toolarge">File too large to diff inline.</div>
          )}
          {isDeleted && !hunks && (
            <div className="diff-toolarge">File deleted.</div>
          )}
          {hunks?.length === 0 && (
            <div className="diff-toolarge">No changes.</div>
          )}
          {hunks?.map((hunk, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-header">{hunkHeader(hunk)}</div>
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

interface MessageProps extends AppMessage {
  streaming?: boolean;
}

/**
 * Splits streaming content at the last paragraph boundary outside a code fence.
 * "Settled" blocks are safe to render as markdown; the live tail is shown as plain text.
 */
function splitStreamingContent(content: string): { settled: string; live: string } {
  let fenceOpen = false;
  let lastSafeSplit = 0;
  let i = 0;

  while (i < content.length) {
    if (content[i] === '`' && content[i + 1] === '`' && content[i + 2] === '`') {
      fenceOpen = !fenceOpen;
      i += 3;
      while (i < content.length && content[i] !== '\n') i++;
    } else if (!fenceOpen && content[i] === '\n' && content[i + 1] === '\n') {
      lastSafeSplit = i + 2;
      i += 2;
    } else {
      i++;
    }
  }

  if (lastSafeSplit === 0 || lastSafeSplit >= content.length) {
    return { settled: '', live: content };
  }
  return { settled: content.slice(0, lastSafeSplit), live: content.slice(lastSafeSplit) };
}

export function Message({ role, content, reasoning, streaming, diffHunks, diffIsNew, diffIsDeleted }: MessageProps): React.ReactElement {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  }, [content]);

  if (role === 'diff') {
    return (
      <DiffBlock
        filePath={content}
        hunks={diffHunks}
        isNew={diffIsNew}
        isDeleted={diffIsDeleted}
      />
    );
  }

  if (role === 'tool') {
    const arrow = content.indexOf(' → ');
    const name = arrow !== -1 ? content.slice(0, arrow) : content;
    const detail = arrow !== -1 ? content.slice(arrow + 3) : '';
    return (
      <div className="msg-tool-row">
        <span className="tool-row-name">{name}</span>
        {detail && <span className="tool-row-detail">{detail}</span>}
      </div>
    );
  }

  if (role === 'system') {
    return <div className="msg system">{content}</div>;
  }

  if (role === 'error') {
    return (
      <div className="msg-wrapper">
        <div className="msg error">{content}</div>
      </div>
    );
  }

  const roleLabel = role === 'user' ? 'You' : 'Forge';

  return (
    <div className="msg-wrapper">
      <span className={`msg-role role-${role}`}>{roleLabel}</span>

      <div className={`msg ${role}`}>
        {role === 'assistant' && reasoning && (
          <div className={`thinking-bubble${thinkingOpen ? ' thinking-bubble-open' : ''}`}>
            <button
              className="thinking-toggle"
              type="button"
              onClick={() => setThinkingOpen((open) => !open)}
              aria-expanded={thinkingOpen}
            >
              <span>Thinking</span>
              <span className="thinking-chevron">
                {thinkingOpen ? <ChevronDown /> : <ChevronRight />}
              </span>
            </button>
            {thinkingOpen && <pre className="thinking-content">{reasoning}</pre>}
          </div>
        )}

        {role === 'assistant' && content ? (
          <AssistantContent content={content} streaming={streaming} />
        ) : role === 'user' ? (
          content
        ) : null}
      </div>

      {role === 'assistant' && content && (
        <div className="msg-actions">
          <button className="btn-action" onClick={handleCopy} type="button">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
