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
  queuedPrompts: Array<{ id: string; text: string; attachments: unknown[]; tell?: boolean }>;
  onCancelQueuedPrompt: (id: string) => void;
  streaming: boolean;
  /** Active conversation/tab id. A change means the user switched sessions, which
   *  must jump to the bottom instantly instead of smooth-scrolling the whole
   *  (different) conversation top-to-bottom. */
  conversationId: string;
  /** Rendered in place of the rows when the conversation has nothing to show. */
  emptyState?: React.ReactNode;
  /** "resumed · 3 days ago · 12 msgs" hairline, or null when this is not a resumed tab. */
  resumedNote?: string | null;
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
const WARM_ROW_THRESHOLD = 10; // rows arriving at once that justify a full measure pass

export function MessageList({
  messages,
  queuedPrompts,
  onCancelQueuedPrompt,
  streaming,
  conversationId,
  emptyState,
  resumedNote,
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

  /**
   * Lay every row out once, so scrolling up does not jump.
   *
   * With `content-visibility: auto`, a row that has never been on screen counts
   * as its 60px estimate. Wheeling up through a long transcript then grew each
   * row to its real height (often several hundred px) as it entered the
   * viewport: the content lurched and the scrollbar thumb resized under the
   * wheel. `contain-intrinsic-size: auto` remembers a size only after a row has
   * rendered, so force one full layout, hold it across a rendering update so the
   * sizes are recorded, then hand skipping back. Paid once per loaded
   * transcript, not per tab switch — a hidden pane keeps the remembered sizes.
   */
  const warmedRowCount = useRef(0);
  const warmRowSizes = useCallback((el: HTMLDivElement) => {
    if (typeof requestAnimationFrame !== 'function') return;
    el.classList.add('cv-warm');
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => el.classList.remove('cv-warm'));
    });
    return () => {
      cancelAnimationFrame(raf);
      el.classList.remove('cv-warm');
    };
  }, []);

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
   * Scroll to the bottom and keep re-pinning until the viewport is actually
   * there.
   *
   * Rows use `content-visibility: auto`, so a pane that has just been shown
   * reports an estimated height (60px per row) for everything off screen and
   * only corrects it as rows come into view. Scrolling once to that estimate
   * lands in the MIDDLE of a long conversation, not at its end: the true
   * `scrollHeight` is only reached after the browser has laid out the rows
   * below the estimated position, which takes more than two frames for a long
   * transcript. So re-pin every frame until `scrollHeight` stops growing under
   * us (i.e. the viewport is genuinely at the bottom); the frame cap stops us
   * chasing a bottom that keeps moving while a turn is still appending.
   */
  const settleToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    scrollToBottom('auto');
    if (typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    let cancelled = false;
    let frame = 0;
    const step = () => {
      if (cancelled || userScrolledUp.current) return;
      scrollToBottom('auto');
      frame++;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom > 1 && frame < 30) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Only an upward move is the reader leaving the bottom. Distance alone is
      // not: a smooth scroll that is still travelling, or a row that grew under
      // the viewport (an image decoding, an off-screen row replacing its 60px
      // estimate), also leaves us >80px short — and latching "scrolled up" there
      // froze the view mid-row until the reader nudged it.
      if (distFromBottom <= SCROLL_THRESHOLD) userScrolledUp.current = false;
      else if (el.scrollTop < lastScrollTop - 1) userScrolledUp.current = true;
      lastScrollTop = el.scrollTop;
      savedScrollTop.current = el.scrollTop;
    };
    // An image finishing its load changes the height without a DOM mutation, so
    // the MutationObserver below never sees it. `load` does not bubble; capture.
    const onLoad = () => {
      if (activeRef.current && !userScrolledUp.current) scrollToBottom();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('load', onLoad, true);
    // The pane is a flex child sharing the column with the streaming status line,
    // the checkpoint bar and the auto-growing composer. When any of those appears
    // the pane gets shorter with scrollTop unchanged, so its last line slides
    // under them — and nothing inside the pane mutated, so nothing re-pinned.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (activeRef.current && !userScrolledUp.current) scrollToBottom();
          });
    resize?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onLoad, true);
      resize?.disconnect();
    };
  }, [scrollToBottom]);

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
      return settleToBottom();
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

  // Only a bulk arrival needs warming — a loaded or resumed transcript. Rows
  // appended during a turn mount at the bottom, on screen, and measure
  // themselves.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !active) return;
    const grown = rows.length - warmedRowCount.current;
    warmedRowCount.current = rows.length;
    if (grown <= WARM_ROW_THRESHOLD) return;
    return warmRowSizes(el);
  }, [active, rows.length, warmRowSizes]);

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
          tell={prompt.tell}
          onCancel={() => onCancelQueuedPrompt(prompt.id)}
        />
      ))}
      <div />
    </div>
  );
}
