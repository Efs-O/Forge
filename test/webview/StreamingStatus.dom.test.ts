// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLANKER_PHRASES, CLOUD_PHRASES, LOCAL_PHRASES } from '../../webview-ui/src/statusPhrases';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { StreamingStatus } = await import('../../webview-ui/src/components/StreamingStatus');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(streaming: boolean, local = true, clanker = false): void {
  act(() => {
    root.render(React.createElement(StreamingStatus, { streaming, local, clanker }));
  });
}

const text = (): string =>
  container.querySelector<HTMLElement>('.streaming-status-text')?.textContent ?? '';

describe('StreamingStatus', () => {
  it('stays mounted when idle so the composer never shifts', () => {
    render(false);
    expect(container.querySelector('#streaming-status')).not.toBeNull();
    expect(text()).toBe('');
  });

  it('shows a local phrase while streaming a local model', () => {
    render(true, true);
    expect(LOCAL_PHRASES as readonly string[]).toContain(text());
  });

  it('shows a cloud phrase for a remote model, never a local one', () => {
    render(true, false);
    expect(CLOUD_PHRASES as readonly string[]).toContain(text());
    expect(LOCAL_PHRASES as readonly string[]).not.toContain(text());
  });

  it('can draw a clanker phrase when clanker mode is on', () => {
    // Probabilistic by nature, so drive many rotations and assert the pool
    // widened rather than that any single tick landed on one.
    render(true, true, true);
    const seen = new Set<string>([text()]);
    for (let i = 0; i < 80; i++) {
      act(() => void vi.advanceTimersByTime(3500));
      seen.add(text());
    }
    const clanker = [...seen].filter((p) => (CLANKER_PHRASES as readonly string[]).includes(p));
    expect(clanker.length).toBeGreaterThan(0);
  });

  it('rotates to a different phrase on each tick — the liveness signal', () => {
    render(true, true);
    const first = text();
    act(() => void vi.advanceTimersByTime(3500));
    expect(text()).not.toBe(first);
  });

  it('clears the phrase when the turn ends', () => {
    render(true, true);
    expect(text()).not.toBe('');
    render(false, true);
    expect(text()).toBe('');
  });

  it('hides the rotating text from assistive tech and announces once instead', () => {
    render(true, true);
    expect(container.querySelector('.streaming-status-text')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    const live = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(live?.textContent).toBe('Generating');
    expect(live?.className).toContain('visually-hidden');
  });
});
