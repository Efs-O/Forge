/**
 * The history panel's resizable size: the grip, the clamps, and the one message
 * the size travels out on.
 *
 * Three sources, in this order: what the person in this window just did (a
 * drag, a grip key press, a reset), then what the host stored for every window,
 * then the default — today's width with a height that fits this viewport. The
 * stored value is applied until this window's owner moves the grip, so a sync
 * arriving mid-drag cannot snap the panel back, and so a reload or a second
 * window still opens the panel the way it was last sized.
 *
 * The clamps never rewrite the stored value: `clampPanelSize` runs when the size
 * is *applied*, so a window with a narrow sidebar does not cost the owner the
 * width they chose in a wide one.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import {
  DEFAULT_PANEL_WIDTH,
  PANEL_MIN_HEIGHT,
  VIEWPORT_HEIGHT_FRACTION,
  clampPanelSize,
  type HistoryPanelSize,
} from '../../src/sidebar/historyPanelSize';
import { vscode } from './vscode';

/** The grip's keyboard step: 10 px, or 40 px with Shift. */
const KEY_STEP_PX = 10;
const SHIFT_KEY_STEP_PX = 40;
/** Room left at the bottom so a panel that fills the viewport does not cover the composer's last pixel row. */
const VIEWPORT_EDGE_GAP_PX = 8;

const sameSize = (a: HistoryPanelSize | undefined, b: HistoryPanelSize | undefined): boolean =>
  a?.width === b?.width && a?.height === b?.height;

function measureViewport(): { width: number; height: number } {
  const root = document.documentElement;
  return {
    // `clientWidth` excludes a classic scrollbar; `innerWidth` does not, and the
    // webview can have one while the sidebar is being resized under it.
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight,
  };
}

/** What the panel needs: its applied size, and the props that make a grip. */
export interface ResizablePanel {
  /** The size to apply, or `undefined` while the panel is collapsed. */
  size: HistoryPanelSize | undefined;
  gripProps: {
    className: string;
    role: 'separator';
    'aria-label': string;
    'aria-valuetext': string;
    tabIndex: number;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
}

/**
 * @param panelRef the panel element, so the grip can measure where the panel
 * actually starts (`top: 100%` of the chat header) instead of guessing at the
 * header's height.
 * @param expanded whether the panel is open — a closed panel has no size to
 * apply, and its `offsetTop` is not measurable while `hidden`.
 */
export function useResizablePanel(
  panelRef: RefObject<HTMLElement | null>,
  expanded: boolean,
): ResizablePanel {
  // `undefined`: nothing chosen in this window yet, so the host's stored value
  // (or the default) still rules. `null`: the owner reset, so the default wins
  // even if a stored value exists for another window.
  const [chosen, setChosen] = useState<HistoryPanelSize | null | undefined>(undefined);
  const [savedByHost, setSavedByHost] = useState<HistoryPanelSize | undefined>(undefined);
  const [viewport, setViewport] = useState(measureViewport);
  const [panelTop, setPanelTop] = useState(0);
  const chosenRef = useRef<HistoryPanelSize | null | undefined>(undefined);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const liveSizeRef = useRef<HistoryPanelSize | null>(null);
  chosenRef.current = chosen;

  const post = (size: HistoryPanelSize | null): void => {
    vscode.postMessage({ type: 'historyPanelSize', size });
  };

  // The saved size rides in on the `sessionSync` the panel already receives, so
  // a reload or a second window has it before the first paint — no extra
  // message, and nothing to wait for.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as { type?: string; historyPanelSize?: HistoryPanelSize };
      if (message?.type !== 'sessionSync' || !message.historyPanelSize) return;
      // A sync that lands while the owner is dragging carries the size from
      // before the drag; applying it would move the panel out from under the
      // pointer. And once this window has sized its own panel, its owner is the
      // authority on that window's size.
      if (draggingRef.current || chosenRef.current !== undefined) return;
      setSavedByHost((current) =>
        sameSize(current, message.historyPanelSize) ? current : message.historyPanelSize,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The sidebar width is the webview viewport width, so a window whose sidebar
  // was resized between messages re-clamps without anyone asking it to.
  useEffect(() => {
    const onResize = (): void => setViewport(measureViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Measured before paint, so the panel never shows one frame at the wrong size.
  useLayoutEffect(() => {
    if (!expanded) return;
    setPanelTop((current) => {
      const top = panelRef.current?.offsetTop ?? 0;
      return top === current ? current : top;
    });
  }, [expanded, panelRef]);

  const room = useMemo(
    () => ({
      width: viewport.width,
      // 90% of the viewport, and never past the space between where the panel
      // actually starts and the bottom of the window.
      height: Math.max(
        PANEL_MIN_HEIGHT,
        Math.min(
          Math.floor(viewport.height * VIEWPORT_HEIGHT_FRACTION),
          viewport.height - panelTop - VIEWPORT_EDGE_GAP_PX,
        ),
      ),
    }),
    [viewport, panelTop],
  );

  const size = expanded
    ? clampPanelSize(
        chosen ??
          savedByHost ?? {
            // The default: today's width, and as tall as this viewport allows.
            width: Math.min(DEFAULT_PANEL_WIDTH, room.width),
            height: room.height,
          },
        room.width,
        room.height,
      )
    : undefined;

  const finishDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    dragStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture is already gone when the pointer left the window mid-drag.
    }
    // One write per drag, not one per pointer move: the plan's ledger counts a
    // resize as one `globalState` update.
    const moved = liveSizeRef.current;
    liveSizeRef.current = null;
    if (moved) post(moved);
  };

  return {
    size,
    gripProps: {
      className: 'history-resize-grip',
      role: 'separator',
      'aria-label': 'Resize the history panel',
      'aria-valuetext': size ? `${size.width} by ${size.height} pixels` : 'default size',
      tabIndex: 0,
      onPointerDown: (event) => {
        if (!size) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
        dragStartRef.current = {
          x: event.clientX,
          y: event.clientY,
          width: size.width,
          height: size.height,
        };
        liveSizeRef.current = size;
      },
      onPointerMove: (event) => {
        const start = dragStartRef.current;
        if (!start) return;
        const next = clampPanelSize(
          {
            width: start.width + (event.clientX - start.x),
            height: start.height + (event.clientY - start.y),
          },
          room.width,
          room.height,
        );
        liveSizeRef.current = next;
        setChosen(next);
      },
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
      onKeyDown: (event) => {
        const step = event.shiftKey ? SHIFT_KEY_STEP_PX : KEY_STEP_PX;
        const delta =
          event.key === 'ArrowRight'
            ? { width: step, height: 0 }
            : event.key === 'ArrowLeft'
              ? { width: -step, height: 0 }
              : event.key === 'ArrowDown'
                ? { width: 0, height: step }
                : event.key === 'ArrowUp'
                  ? { width: 0, height: -step }
                  : undefined;
        if (!delta || !size) return;
        event.preventDefault();
        const next = clampPanelSize(
          { width: size.width + delta.width, height: size.height + delta.height },
          room.width,
          room.height,
        );
        if (sameSize(next, size)) return;
        setChosen(next);
        // A key press is one action, so it saves on the press rather than
        // waiting for the next one: a person who presses once and leaves should
        // get the size they pressed for.
        post(next);
      },
      onDoubleClick: () => {
        // Reset forgets the key entirely, so the default returns for every
        // window rather than for this one only.
        setChosen(null);
        post(null);
      },
    },
  };
}
