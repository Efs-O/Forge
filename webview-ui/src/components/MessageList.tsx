import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AppMessage } from '../App';
import { Message } from './Message';
import { DiffGroup } from './DiffGroup';
import { ThinkingGroup, isReasoningOnly } from './ThinkingGroup';
import { ToolGroup } from './ToolGroup';
import { QueuedPromptRow } from './QueuedPromptRow';

type Row =
  | { kind: 'message'; message: AppMessage; index: number }
  | { kind: 'diffGroup'; diffs: AppMessage[] }
  | { kind: 'thinkingGroup'; steps: AppMessage[] }
  | { kind: 'toolGroup'; tools: AppMessage[] };

/**
 * Folds runs of adjacent same-kind messages into single rows: file edits and
 * tool calls become one card per turn, and per-round reasoning becomes one line.
 * Anything else passes through untouched.
 */
function toRows(messages: AppMessage[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === 'diff') {
      const diffs: AppMessage[] = [];
      while (i < messages.length && messages[i]!.role === 'diff') diffs.push(messages[i++]!);
      i--;
      rows.push({ kind: 'diffGroup', diffs });
      continue;
    }

    if (isReasoningOnly(message)) {
      const steps: AppMessage[] = [];
      while (i < messages.length && isReasoningOnly(messages[i]!)) steps.push(messages[i++]!);
      i--;
      rows.push({ kind: 'thinkingGroup', steps });
      continue;
    }

    if (message.role === 'tool') {
      const tools: AppMessage[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') tools.push(messages[i++]!);
      i--;
      rows.push({ kind: 'toolGroup', tools });
      continue;
    }

    rows.push({ kind: 'message', message, index: i });
  }
  return rows;
}

interface Props {
  messages: AppMessage[];
  queuedPrompts: Array<{ id: string; text: string; attachments: unknown[] }>;
  onCancelQueuedPrompt: (id: string) => void;
  onSteerQueuedPrompt: (id: string) => void;
  streaming: boolean;
  /** Active conversation/tab id. A change means the user switched sessions, which
   *  must jump to the bottom instantly instead of smooth-scrolling the whole
   *  (different) conversation top-to-bottom. */
  conversationId: string;
  /** Rendered in place of the rows when the conversation has nothing to show. */
  emptyState?: React.ReactNode;
  /** "resumed · 3 days ago · 12 msgs" hairline, or null when this is not a resumed tab. */
  resumedNote?: string | null;
  /** Names the model a queued prompt is waiting on; absent when none is selected. */
  queuedModelName?: string | null;
}

const SCROLL_THRESHOLD = 80; // px from bottom — within this, auto-scroll is active

export function MessageList({
  messages,
  queuedPrompts,
  onCancelQueuedPrompt,
  onSteerQueuedPrompt,
  streaming,
  conversationId,
  emptyState,
  resumedNote,
  queuedModelName,
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shownConversation = useRef<string | undefined>(undefined);
  const rows = useMemo(() => toRows(messages), [messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > SCROLL_THRESHOLD;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    // Expanding a thinking row and streaming text into its nested pane mutate
    // the DOM without changing MessageList's `messages` prop. Follow those
    // changes too, but never override a reader who intentionally scrolled up.
    const observer = new MutationObserver(() => {
      if (!userScrolledUp.current) scrollToBottom();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useEffect(() => {
    // Session switch: jump straight to the bottom with no animation and reset the
    // "user scrolled up" flag for the freshly shown conversation. Smooth-scrolling
    // here would animate through the entire (different) conversation.
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      userScrolledUp.current = false;
      scrollToBottom();
      return;
    }
    if (!userScrolledUp.current) {
      // Every token is a new messages array. A smooth scroll restarts its
      // animation on each one and never reaches the target, so the view falls
      // behind — or appears frozen — for the whole turn. Jump instantly while
      // tokens are arriving and keep the animation for settled updates.
      scrollToBottom(streaming ? 'auto' : 'smooth');
    }
  }, [messages, conversationId, scrollToBottom, streaming]);

  const isEmpty = rows.length === 0 && queuedPrompts.length === 0;

  return (
    <div id="messages" ref={containerRef}>
      {isEmpty && emptyState}
      {rows.map((row) =>
        row.kind === 'diffGroup' ? (
          <DiffGroup key={row.diffs[0]!.id} diffs={row.diffs} />
        ) : row.kind === 'thinkingGroup' ? (
          <ThinkingGroup key={row.steps[0]!.id} steps={row.steps} />
        ) : row.kind === 'toolGroup' ? (
          <ToolGroup key={row.tools[0]!.id} tools={row.tools} />
        ) : (
          <Message
            key={row.message.id}
            {...row.message}
            streaming={
              streaming && row.index === messages.length - 1 && row.message.role === 'assistant'
            }
          />
        ),
      )}
      {resumedNote && (
        <div className="resumed-marker" role="separator">
          <span>{resumedNote}</span>
        </div>
      )}
      {queuedPrompts.map((prompt) => (
        <QueuedPromptRow
          key={prompt.id}
          text={prompt.text}
          attachmentCount={prompt.attachments.length}
          waitingOn={queuedModelName ?? null}
          onSteer={() => onSteerQueuedPrompt(prompt.id)}
          onCancel={() => onCancelQueuedPrompt(prompt.id)}
        />
      ))}
      <div />
    </div>
  );
}
