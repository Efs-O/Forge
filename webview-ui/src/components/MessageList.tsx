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
  /**
   * Whether this pane is the one on screen.
   *
   * One `MessageList` is mounted per visited tab and hidden rather than
   * unmounted, because a switch that unmounts re-runs `react-markdown` +
   * `rehype-highlight` over the whole incoming transcript - the single largest
   * remaining cost of a tab switch once the host stopped shipping every
   * transcript. See `docs/plans/SIDEBAR_SWITCH_LATENCY_PLAN.md`.
   */
  active: boolean;
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
  active,
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shownConversation = useRef<string | undefined>(undefined);
  // A hidden pane is `display: none`, and Chromium resets `scrollTop` to 0 when
  // an element is taken out of flow. Tracked on every scroll rather than read
  // back on deactivation, because by the time an effect cleanup runs the pane
  // is already hidden and the value is already gone.
  const savedScrollTop = useRef(0);
  const rows = useMemo(() => toRows(messages), [messages]);

  // The MutationObserver is installed once; a ref is how its closure reads the
  // current `active` without re-subscribing on every switch.
  const activeRef = useRef(active);
  activeRef.current = active;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  /**
   * Scroll to the bottom and hold it there for the next two frames.
   *
   * Rows use `content-visibility: auto`, so a pane that has just been shown
   * reports an estimated height for everything off screen and only corrects it
   * as rows come into view. One scroll lands near the bottom on that estimate;
   * re-pinning after the browser has laid the real rows out is what lands on it.
   */
  const settleToBottom = useCallback(() => {
    scrollToBottom('auto');
    if (typeof requestAnimationFrame !== 'function') return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      scrollToBottom('auto');
      second = requestAnimationFrame(() => scrollToBottom('auto'));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > SCROLL_THRESHOLD;
      savedScrollTop.current = el.scrollTop;
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
      if (!activeRef.current) return;
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
      settleToBottom();
      return;
    }
    if (!active) return;
    if (!userScrolledUp.current) {
      // Every token is a new messages array. A smooth scroll restarts its
      // animation on each one and never reaches the target, so the view falls
      // behind — or appears frozen — for the whole turn. Jump instantly while
      // tokens are arriving and keep the animation for settled updates.
      scrollToBottom(streaming ? 'auto' : 'smooth');
    }
  }, [active, messages, conversationId, scrollToBottom, streaming]);

  // Becoming visible again: put the reader back where they were, or at the
  // bottom if that is where they had been. Both because the pane was hidden and
  // lost its scroll offset, and because a background turn may have appended to
  // it while it was away.
  useEffect(() => {
    if (!active) return;
    if (userScrolledUp.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = savedScrollTop.current;
      return;
    }
    return settleToBottom();
  }, [active, settleToBottom]);

  const isEmpty = rows.length === 0 && queuedPrompts.length === 0;

  return (
    <div
      id={active ? 'messages' : undefined}
      className="messages-pane"
      hidden={!active}
      ref={containerRef}
    >
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
