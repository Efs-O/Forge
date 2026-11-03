import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import {
  HISTORY_PANEL_SIZE_KEY,
  historyPanelSizeSchema,
  readHistoryPanelSize,
  storeHistoryPanelSize,
  type PanelSizeLog,
} from '../../src/sidebar/historyPanelSizeStore';
import { PANEL_MAX_WIDTH, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH } from '../../src/sidebar/historyPanelSize';

/** The same shape `HistoryArchive.test.ts` uses: a plain object is enough for a
 *  `Memento`, and casting it keeps the test from re-implementing VS Code's API. */
function makeMemento(store: Record<string, unknown>): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) => {
      const value = store[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    keys: () => Object.keys(store),
    update: (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

/** A log that keeps what it was told, so `warn` is asserted rather than watched. */
function capturingLog(): { log: PanelSizeLog; lines: string[] } {
  const lines: string[] = [];
  return { log: { warn: (message: string) => lines.push(message) }, lines };
}

describe("the history panel's stored size", () => {
  it('saves a size the webview settled on and reads it back', () => {
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    storeHistoryPanelSize(memento, { width: 512, height: 640 }, capturingLog().log);
    expect(store[HISTORY_PANEL_SIZE_KEY]).toEqual({ width: 512, height: 640 });
    expect(readHistoryPanelSize(memento, capturingLog().log)).toEqual({ width: 512, height: 640 });
  });

  it('stores one write per action, not one per pointer move', () => {
    // The webview posts only at the end of a drag, so the key holds the size the
    // person left the panel at — the last value wins, and no half-drag survives.
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    const log = capturingLog().log;
    storeHistoryPanelSize(memento, { width: 300, height: 300 }, log);
    storeHistoryPanelSize(memento, { width: 410, height: 380 }, log);
    expect(readHistoryPanelSize(memento, log)).toEqual({ width: 410, height: 380 });
    expect(Object.keys(store)).toEqual([HISTORY_PANEL_SIZE_KEY]);
  });

  it('a reset removes the key, so the default returns', () => {
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    const log = capturingLog().log;
    storeHistoryPanelSize(memento, { width: 500, height: 700 }, log);
    storeHistoryPanelSize(memento, null, log);
    // Not the default value: the key's absence is what makes the default the
    // default again, and a stored 480 could not be told apart from a resize.
    expect(HISTORY_PANEL_SIZE_KEY in store).toBe(false);
    expect(Object.keys(store)).toEqual([]);
    expect(readHistoryPanelSize(memento, log)).toBeUndefined();
  });

  it('refuses an out-of-range message and leaves what was stored alone', () => {
    const store: Record<string, unknown> = { [HISTORY_PANEL_SIZE_KEY]: { width: 480, height: 320 } };
    const memento = makeMemento(store);
    const { log, lines } = capturingLog();
    storeHistoryPanelSize(memento, { width: 120, height: 320 }, log);
    expect(readHistoryPanelSize(memento, log)).toEqual({ width: 480, height: 320 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('out-of-range');
    // A message from a stale webview cannot widen the key's bounds either.
    storeHistoryPanelSize(memento, { width: 5000, height: 320 }, log);
    expect(readHistoryPanelSize(memento, log)).toEqual({ width: 480, height: 320 });
    expect(lines).toHaveLength(2);
  });

  it('removes a stored value it cannot use, logs one line, and uses the default', () => {
    // Four shapes of unusable: out of range, fractional, the wrong type, and a
    // key that is not an object at all. Each is removed rather than left to fail
    // the same way on every load, so a later build can tell a corrupt key from a
    // missing one.
    for (const unusable of [
      { width: 40, height: 300 },
      { width: 480.5, height: 300 },
      { width: '480', height: 300 },
      'wider please',
      { width: 480, height: 300, extra: true },
    ]) {
      const store: Record<string, unknown> = { [HISTORY_PANEL_SIZE_KEY]: unusable };
      const memento = makeMemento(store);
      const { log, lines } = capturingLog();
      expect(readHistoryPanelSize(memento, log)).toBeUndefined();
      expect(HISTORY_PANEL_SIZE_KEY in store).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(HISTORY_PANEL_SIZE_KEY);
    }
  });

  it('a window with no globalState opens at the default without throwing', () => {
    const { log, lines } = capturingLog();
    expect(readHistoryPanelSize(undefined, log)).toBeUndefined();
    storeHistoryPanelSize(undefined, { width: 480, height: 400 }, log);
    storeHistoryPanelSize(undefined, null, log);
    expect(lines).toEqual([]);
  });

  it('the bounds the host stores inside are the bounds the webview clamps to', () => {
    // The host cannot know this window's sidebar, so it stores generously and
    // the webview clamps to reality. What both must agree on is the floor.
    expect(PANEL_MIN_WIDTH).toBe(260);
    expect(PANEL_MIN_HEIGHT).toBe(300);
    expect(PANEL_MAX_WIDTH).toBeGreaterThan(PANEL_MIN_WIDTH);
    const schema = historyPanelSizeSchema.safeParse({ width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT });
    expect(schema.success).toBe(true);
    expect(historyPanelSizeSchema
      .safeParse({ width: PANEL_MIN_WIDTH - 1, height: PANEL_MIN_HEIGHT })
      .success).toBe(false);
  });
});
