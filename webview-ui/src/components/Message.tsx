import React, { useCallback, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AppMessage } from '../App';
import { vscode } from '../vscode';
import { normalizeMarkdownForRender } from '../markdown';
import { FILE_LINK_SCHEME, linkifyForRender, parseFileLink } from '../linkify';

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

const CopyIcon = (): React.ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M5.5 4.5h7v8h-7zM3.5 11.5h-1v-8h7v-1h-7a1 1 0 00-1 1v8a1 1 0 001 1h7v-1h-6z"
      fill="currentColor"
    />
  </svg>
);

const CheckIcon = (): React.ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6.2 11.3L2.9 8l1.1-1.1 2.2 2.2 5.8-5.8L13.1 4 6.2 11.3z" fill="currentColor" />
  </svg>
);

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  a: ({ href, children, ...props }) => {
    if (href?.startsWith(FILE_LINK_SCHEME)) {
      const { path: filePath, line } = parseFileLink(href);
      return (
        <a
          {...props}
          href={href}
          className="forge-file-link"
          onClick={(e) => {
            e.preventDefault();
            vscode.postMessage({
              type: 'openFile',
              path: filePath,
              ...(line === undefined ? {} : { line }),
              // Ctrl/Cmd-click opens beside, matching the editor's own convention.
              ...(e.ctrlKey || e.metaKey ? { beside: true } : {}),
            });
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  },
};

function AssistantContent({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}): React.ReactElement {
  const renderContent = useMemo(
    () => linkifyForRender(normalizeMarkdownForRender(content)),
    [content],
  );
  const { settled, live } = useMemo(
    () => (streaming ? splitStreamingContent(renderContent) : { settled: renderContent, live: '' }),
    [renderContent, streaming],
  );

  if (!streaming) {
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {renderContent}
      </Markdown>
    );
  }

  return (
    <>
      {settled && (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {settled}
        </Markdown>
      )}
      <span className="streaming-tail">{live}</span>
    </>
  );
}

/** Diff messages never reach here — MessageList routes them to DiffGroup. */
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

export function Message({ role, content, reasoning, streaming }: MessageProps): React.ReactElement {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [content]);

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
          <button
            className="btn-action btn-action-icon"
            onClick={handleCopy}
            type="button"
            title={copied ? 'Copied' : 'Copy response'}
            aria-label={copied ? 'Copied' : 'Copy response'}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
    </div>
  );
}
