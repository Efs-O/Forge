import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AppMessage } from '../App';
import { rowKey, toRows, type ActivityViewMode } from '../activityRows';
import { Message } from './Message';
import { DiffGroup } from './DiffGroup';
import { ThinkingGroup } from './ThinkingGroup';
import { ToolGroup } from './ToolGroup';
import { ActivityRow } from './ActivityRow';
import { ActivityGroup } from './ActivityGroup';
import { QueuedPromptRow } from './QueuedPromptRow';
import { PendingToolCallRow } from './PendingToolCallRow';
import type { PendingToolCall } from '../pendingToolCalls';
import { isScrollUpIntent, nextScrolledUp } from '../scrollFollow';

interface Props {
  messages: AppMessage[];
  queuedPrompts: Array<{
    id: string;
    text: string;
    attachments: unknown[];
    tell?: boolean;
    sendingNow?: boolean;
  }>;
  onCancelQueuedPrompt: (id: string) => void;
  onSendQueuedPromptNow: (id: string) => void;
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
  activityView: ActivityViewMode;
  /** Tool calls the model is still writing; grouped view keeps these in its live card. */
  pendingToolCalls?: readonly PendingToolCall[];
}

const WARM_ROW_THRESHOLD = 10; // rows arriving at once that justify a full measure pass

export function MessageList({
  messages,
  queuedPrompts,
  onCancelQueuedPrompt,
  onSendQueuedPromptNow,
  streaming,
  conversationId,
  emptyState,
  resumedNote,
  active,
  activityView,
  pendingToolCalls = [],
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shownConversation = useRef<string | undefined>(undefined);
  // A hidden pane is `display: none`, and Chromium resets `scrollTop` to 0 when
  // an element is taken out of flow. Tracked on every scroll rather than read
  // back on deactivation, because by the time an effect cleanup runs the pane
  // is already hidden and the value is already gone.
  const savedScrollTop = useRef(0);
  const cancelSettling = useRef<(() => void) | undefined>(undefined);
  const rows = useMemo(() => toRows(messages, activityView), [messages, activityView]);

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
   * Re-pin until the measured height and bottom position stay stable across
   * several frames. Resize and mutation observers restart this bounded loop
   * when later intrinsic-size corrections arrive.
   */
  const settleToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    cancelSettling.current?.();
    scrollToBottom('auto');
    if (typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    let cancelled = false;
    let frame = 0;
    let stableFrames = 0;
    let previousHeight = -1;
    const step = () => {
      if (cancelled || userScrolledUp.current || !activeRef.current) return;
      scrollToBottom('auto');
      frame++;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom <= 1 && el.scrollHeight === previousHeight) stableFrames++;
      else stableFrames = 0;
      previousHeight = el.scrollHeight;
      if (stableFrames < 4 && frame < 120) {
        raf = requestAnimationFrame(step);
      } else {
        cancelSettling.current = undefined;
      }
    };
    raf = requestAnimationFrame(step);
    const cancel = () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (cancelSettling.current === cancel) cancelSettling.current = undefined;
    };
    cancelSettling.current = cancel;
    return () => {
      cancel();
      if (cancelSettling.current === cancel) cancelSettling.current = undefined;
    };
  }, [scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastScrollTop = el.scrollTop;
    let touchY: number | undefined;
    let scrollbarPointer = false;
    const onScroll = () => {
      if (!activeRef.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = nextScrolledUp(userScrolledUp.current, {
        distFromBottom,
      });
      if (
        scrollbarPointer &&
        isScrollUpIntent({ kind: 'scrollbar', delta: el.scrollTop - lastScrollTop }) &&
        distFromBottom > 1
      ) {
        userScrolledUp.current = true;
        cancelSettling.current?.();
      }
      lastScrollTop = el.scrollTop;
      savedScrollTop.current = el.scrollTop;
    };
    // An image finishing its load changes the height without a DOM mutation, so
    // the MutationObserver below never sees it. `load` does not bubble; capture.
    const onLoad = () => {
      if (activeRef.current && !userScrolledUp.current) settleToBottom();
    };
    // A wheel turned up is intent before any pixel moves; latch on it so a token
    // landing in the same frame cannot pin the view back down.
    const onWheel = (event: WheelEvent) => {
      if (
        isScrollUpIntent({ kind: 'wheel', delta: event.deltaY }) &&
        el.scrollHeight > el.clientHeight
      ) {
        userScrolledUp.current = true;
        cancelSettling.current?.();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isScrollUpIntent({ kind: 'keyboard', key: event.key, shiftKey: event.shiftKey })) {
        userScrolledUp.current = true;
        cancelSettling.current?.();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && touchY < nextY) {
        if (isScrollUpIntent({ kind: 'touch', delta: touchY - nextY })) {
          userScrolledUp.current = true;
          cancelSettling.current?.();
        }
      }
      touchY = nextY;
    };
    const onPointerDown = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const scrollbarWidth = el.offsetWidth - el.clientWidth;
      scrollbarPointer = scrollbarWidth > 0 && event.clientX >= rect.right - scrollbarWidth;
    };
    const onPointerUp = () => {
      scrollbarPointer = false;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('load', onLoad, true);
    // The pane is a flex child sharing the column with the streaming status line,
    // the checkpoint bar and the auto-growing composer. When any of those appears
    // the pane gets shorter with scrollTop unchanged, so its last line slides
    // under them — and nothing inside the pane mutated, so nothing re-pinned.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (activeRef.current && !userScrolledUp.current) settleToBottom();
          });
    resize?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('load', onLoad, true);
      resize?.disconnect();
    };
  }, [scrollToBottom, settleToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const resizeRows =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (activeRef.current && !userScrolledUp.current) settleToBottom();
          });
    const observedRows = new Set<Element>();
    const syncRows = () => {
      const tail = new Set<Element>();
      let row = el.lastElementChild;
      for (let count = 0; row && count < 8; count++) {
        tail.add(row);
        row = row.previousElementSibling;
      }
      for (const row of observedRows) {
        if (!tail.has(row)) {
          resizeRows?.unobserve(row);
          observedRows.delete(row);
        }
      }
      for (const row of tail) {
        if (!observedRows.has(row)) {
          resizeRows?.observe(row);
          observedRows.add(row);
        }
      }
    };
    // Expanding a thinking row and streaming text into its nested pane mutate
    // the DOM without changing MessageList's `messages` prop. Follow those
    // changes too, but never override a reader who intentionally scrolled up.
    const observer = new MutationObserver(() => {
      syncRows();
      if (!activeRef.current) return;
      if (!userScrolledUp.current) settleToBottom();
    });
    syncRows();
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      resizeRows?.disconnect();
    };
  }, [settleToBottom]);

  useEffect(() => {
    if (!active) cancelSettling.current?.();
  }, [active]);

  useEffect(() => () => cancelSettling.current?.(), []);

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

  const isEmpty = rows.length === 0 && queuedPrompts.length === 0 && pendingToolCalls.length === 0;
  const groupedPending = activityView === 'grouped' && pendingToolCalls.length > 0;
  const pendingInLastGroup = groupedPending && rows.at(-1)?.kind === 'activityGroup';

  return (
    <div
      id={active ? 'messages' : undefined}
      className="messages-pane"
      hidden={!active}
      ref={containerRef}
      tabIndex={0}
    >
      {isEmpty && emptyState}
      {rows.map((row, rowIndex) =>
        row.kind === 'diffGroup' ? (
          <DiffGroup key={rowKey(row)} diffs={row.diffs} />
        ) : row.kind === 'thinkingGroup' ? (
          <ThinkingGroup key={rowKey(row)} steps={row.steps} />
        ) : row.kind === 'toolGroup' ? (
          <ToolGroup key={rowKey(row)} tools={row.tools} />
        ) : row.kind === 'step' ? (
          <ActivityRow key={rowKey(row)} step={row.step} streaming={streaming} />
        ) : row.kind === 'activityGroup' ? (
          <ActivityGroup
            key={rowKey(row)}
            items={row.items}
            live={streaming && rowIndex === rows.length - 1}
            streaming={streaming}
            pendingCalls={
              pendingInLastGroup && rowIndex === rows.length - 1 ? pendingToolCalls : undefined
            }
          />
        ) : (
          <Message
            key={rowKey(row)}
            {...row.message}
            streaming={
              streaming && row.index === messages.length - 1 && row.message.role === 'assistant'
            }
          />
        ),
      )}
      {groupedPending && !pendingInLastGroup && (
        <ActivityGroup items={[]} live streaming={streaming} pendingCalls={pendingToolCalls} />
      )}
      {!groupedPending &&
        pendingToolCalls.map((call) => (
          <PendingToolCallRow key={call.toolCallId ?? `pending-${call.index}`} call={call} />
        ))}
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
          sendingNow={prompt.sendingNow}
          onSendNow={() => onSendQueuedPromptNow(prompt.id)}
          onCancel={() => onCancelQueuedPrompt(prompt.id)}
        />
      ))}
      <div />
    </div>
  );
}
