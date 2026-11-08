import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AppMessage } from './messageOps';
import { toRows, type ActivityViewMode } from './activityRows';

export const TRANSCRIPT_PAGE_SIZE = 100;

interface Anchor {
  key: string;
  top: number;
}

/** Page before folding: a single activity row can contain thousands of messages. */
export function useTranscriptWindow(
  messages: AppMessage[],
  conversationId: string,
  activityView: ActivityViewMode,
  container: RefObject<HTMLDivElement | null>,
  userScrolledUp: React.MutableRefObject<boolean>,
  cancelSettling: React.MutableRefObject<(() => void) | undefined>,
) {
  const [windowStart, setWindowStart] = useState<{ conversationId: string; starts: string[] }>();
  const pinnedId =
    windowStart?.conversationId === conversationId ? windowStart.starts[0] : undefined;
  const pinnedIndex = pinnedId ? messages.findIndex((message) => message.id === pinnedId) : -1;
  const start =
    pinnedIndex >= 0 ? pinnedIndex : Math.max(0, messages.length - TRANSCRIPT_PAGE_SIZE);
  const current = useRef({ messages, start, conversationId, pinnedId, windowStart });
  current.current = { messages, start, conversationId, pinnedId, windowStart };
  const anchor = useRef<Anchor | undefined>(undefined);
  const rows = useMemo(() => {
    // Fold each loaded page separately: prepending must not merge its first
    // group into an existing card and change that card's key/disclosure state.
    const boundaries = pinnedIndex >= 0 ? windowStart!.starts : [];
    const indexes = boundaries.map((id) => messages.findIndex((message) => message.id === id));
    const starts = [start, ...indexes.filter((index) => index > start), messages.length];
    return starts
      .slice(0, -1)
      .flatMap((pageStart, index) =>
        toRows(messages.slice(pageStart, starts[index + 1]), activityView).map((row) =>
          row.kind === 'message' ? { ...row, index: row.index + pageStart - start } : row,
        ),
      );
  }, [messages, start, pinnedIndex, windowStart, activityView]);

  // Stable callbacks are used by MessageList's once-installed native listeners.
  const holdWindow = useCallback(() => {
    const view = current.current;
    const firstId = view.messages[view.start]?.id;
    if (firstId && firstId !== view.pinnedId) {
      setWindowStart({ conversationId: view.conversationId, starts: [firstId] });
    }
  }, []);

  const followTail = useCallback(() => {
    if (current.current.pinnedId) setWindowStart(undefined);
  }, []);

  const loadEarlier = useCallback(() => {
    const el = container.current;
    const view = current.current;
    if (!el || view.start === 0) return;
    userScrolledUp.current = true;
    cancelSettling.current?.();
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-row]')).find(
      (candidate) => candidate.getBoundingClientRect().bottom > top,
    );
    anchor.current = row
      ? { key: row.dataset.transcriptRow!, top: row.getBoundingClientRect().top - top }
      : undefined;
    const firstId = view.messages[Math.max(0, view.start - TRANSCRIPT_PAGE_SIZE)]!.id;
    const starts =
      view.pinnedId && view.windowStart ? view.windowStart.starts : [view.messages[view.start]!.id];
    setWindowStart({ conversationId: view.conversationId, starts: [firstId, ...starts] });
  }, [container, userScrolledUp, cancelSettling]);

  useLayoutEffect(() => {
    const el = container.current;
    const saved = anchor.current;
    if (!el || !saved) return;
    anchor.current = undefined;
    // Disable native anchoring only while explicitly restoring ours. Measure all
    // newly inserted rows before using their positions, not their 60px estimates.
    el.style.overflowAnchor = 'none';
    el.classList.add('cv-warm');
    const restore = () => {
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-row]')).find(
        (candidate) => candidate.dataset.transcriptRow === saved.key,
      );
      if (row) {
        el.scrollTop +=
          row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.top;
      }
    };
    restore();
    let frame = 0;
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        restore();
        frame = requestAnimationFrame(() => {
          el.classList.remove('cv-warm');
          restore();
          el.style.overflowAnchor = '';
        });
      });
    } else {
      el.classList.remove('cv-warm');
      el.style.overflowAnchor = '';
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.classList.remove('cv-warm');
      el.style.overflowAnchor = '';
    };
  }, [windowStart, container]);

  return {
    rows,
    visibleMessageCount: messages.length - start,
    hiddenCount: start,
    loadEarlier,
    holdWindow,
    followTail,
  };
}
