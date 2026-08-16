import React, { useEffect, useMemo, useRef } from 'react';
import type { AppMessage } from '../App';
import { Message } from './Message';
import { DiffGroup } from './DiffGroup';
import { ThinkingGroup, isReasoningOnly } from './ThinkingGroup';
import { ToolRow } from './ToolRow';

type Row =
  | { kind: 'message'; message: AppMessage; index: number }
  | { kind: 'diffGroup'; diffs: AppMessage[] }
  | { kind: 'thinkingGroup'; steps: AppMessage[] };

/**
 * Folds runs of adjacent same-kind messages into single rows: file edits become
 * one card per turn, per-round reasoning becomes one line. Anything else passes
 * through untouched.
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

    rows.push({ kind: 'message', message, index: i });
  }
  return rows;
}

interface Props {
  messages: AppMessage[];
  streaming: boolean;
  generating: boolean;
  /** Active conversation/tab id. A change means the user switched sessions, which
   *  must jump to the bottom instantly instead of smooth-scrolling the whole
   *  (different) conversation top-to-bottom. */
  conversationId: string;
}

const SCROLL_THRESHOLD = 80; // px from bottom — within this, auto-scroll is active

export function MessageList({
  messages,
  streaming,
  generating,
  conversationId,
}: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shownConversation = useRef<string | undefined>(undefined);
  const rows = useMemo(() => toRows(messages), [messages]);

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
    // Session switch: jump straight to the bottom with no animation and reset the
    // "user scrolled up" flag for the freshly shown conversation. Smooth-scrolling
    // here would animate through the entire (different) conversation.
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      userScrolledUp.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, conversationId]);

  return (
    <div id="messages" ref={containerRef}>
      {rows.map((row) =>
        row.kind === 'diffGroup' ? (
          <DiffGroup key={row.diffs[0]!.id} diffs={row.diffs} />
        ) : row.kind === 'thinkingGroup' ? (
          <ThinkingGroup key={row.steps[0]!.id} steps={row.steps} />
        ) : row.message.role === 'tool' ? (
          <ToolRow key={row.message.id} message={row.message} />
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
      {generating && messages[messages.length - 1]?.role !== 'assistant' && (
        <div className="forge-thinking-row" aria-label="Forge is thinking">
          <span className="forge-thinking-dot" />
          <span className="forge-thinking-dot" />
          <span className="forge-thinking-dot" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
