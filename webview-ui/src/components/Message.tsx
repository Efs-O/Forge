import React, { useCallback, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AppMessage } from '../App';
import { vscode } from '../vscode';
import { normalizeMarkdownForRender } from '../markdown';
import { FILE_LINK_SCHEME, linkifyForRender, parseFileLink } from '../linkify';
import { MessageAttachments } from './MessageAttachments';
import { formatMessageTimestamp } from '../messageTimestamp';
import { parseChatMessage } from '../../../src/sidebar/chatMessageText';

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

function textFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) {
    return textFromChildren(children.props.children);
  }
  return '';
}

interface CodeBlockProps extends React.ComponentPropsWithoutRef<'pre'> {
  /** react-markdown adds its hast node alongside the DOM props. */
  node?: unknown;
}

function CodeBlock({ children, node: _node, ...props }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const code = textFromChildren(children);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [code]);

  return (
    <div className="forge-code-block">
      <button
        className="forge-code-copy"
        type="button"
        onClick={handleCopy}
        title={copied ? 'Copied' : 'Copy code'}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  pre: CodeBlock,
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

/** Separate a concise assistant lead from a structural explanation line. */
function normalizeAssistantLead(content: string): string {
  return content.replace(
    /^(?![ \t]*(?:[-*+]\s|\d+[.)]\s|#{1,6}(?:\s|$)|>\s|```))([^\r\n]+[.!?:])\r?\n(?=(?:\*\*[^*\r\n]+\*\*:?|__[^_\r\n]+__:?|[-*+]\s|\d+[.)]\s|#{1,6}\s))/,
    '$1\n\n',
  );
}

function AssistantContent({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}): React.ReactElement {
  const renderContent = useMemo(
    () => linkifyForRender(normalizeMarkdownForRender(normalizeAssistantLead(content))),
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

function MessageView({
  role,
  content,
  createdAt,
  streaming,
  preformatted,
  attachments,
  agentSender,
}: MessageProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timestampText = formatMessageTimestamp(createdAt);
  const timestampDateTime =
    createdAt !== undefined && timestampText ? new Date(createdAt).toISOString() : undefined;
  const chatMessage = useMemo(
    () => (role === 'user' ? parseChatMessage(content) : undefined),
    [role, content],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(chatMessage?.body ?? content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [chatMessage, content]);

  if (role === 'system') {
    // A report's columns are its structure. The default system row is centred,
    // italic and 11px — legible for "chat cleared", unreadable for a table.
    if (preformatted) return <pre className="msg system system-block">{content}</pre>;
    return <div className="msg system">{content}</div>;
  }

  if (role === 'error') {
    return (
      <div className="msg-wrapper">
        <div className="msg error">{content}</div>
      </div>
    );
  }

  return (
    <div className={`msg-wrapper msg-wrapper-${role}`}>
      <div className={`msg ${role}${chatMessage ? ' msg-chat-message' : ''}`}>
        {chatMessage ? (
          <div className="agent-sender-badge">📨 From {chatMessage.fromTitle}</div>
        ) : role === 'user' && agentSender ? (
          <div className="agent-sender-badge">
            From {agentSender.kind[0]!.toUpperCase() + agentSender.kind.slice(1)} ·{' '}
            {agentSender.title}
          </div>
        ) : null}
        {role === 'assistant' && content ? (
          <AssistantContent content={content} streaming={streaming} />
        ) : role === 'user' ? (
          <>
            {chatMessage?.body ?? content}
            {attachments?.length ? <MessageAttachments attachments={attachments} /> : null}
          </>
        ) : null}
      </div>

      {(role === 'user' || role === 'assistant') && timestampText && timestampDateTime && (
        <time className="message-timestamp" dateTime={timestampDateTime}>
          {timestampText}
        </time>
      )}

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

/**
 * Memoized because the list is not virtualized: every row is a live component,
 * and a streaming turn hands `MessageList` a brand-new messages array on every
 * token. Unmemoized, each token re-ran `react-markdown` + `rehype-highlight`
 * over the whole transcript -- ~1000 rows in an audited session. Hidden in the
 * background the browser throttles that work rather than dropping it, so
 * switching away from the sidebar during a turn and back flushed the backlog in
 * one paint, which read as the view spontaneously rebuilding itself.
 *
 * Every prop here is a primitive except `attachments`, which is rebuilt only
 * when the host re-sends the row (MessageProps' other non-primitive fields
 * belong to the diff and tool rows, which MessageList routes to their own
 * components), so the default shallow compare is exact -- no custom comparator
 * to drift.
 */
export const Message = React.memo(MessageView);
