// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionTabMeta } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TabStrip } = await import('../../webview-ui/src/components/TabStrip');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TabStrip', () => {
  it('keeps active time available in the tab tooltip without cluttering the title', () => {
    const tabs: SessionTabMeta[] = [
      { id: 'one', title: 'First task', createdAt: 0, updatedAt: 0, active_time_ms: 3_661_000 },
      { id: 'two', title: 'Second task', createdAt: 0, updatedAt: 0, active_time_ms: 0 },
    ];

    act(() => {
      root.render(
        React.createElement(TabStrip, {
          tabs,
          activeId: 'one',
          streamingIds: new Set<string>(),
          onSwitch: () => {},
          onNew: () => {},
          onClose: () => {},
        }),
      );
    });

    expect(container.querySelectorAll('.tab-chip-time')).toHaveLength(0);
    expect(container.querySelector<HTMLButtonElement>('.tab-chip-label')?.title).toContain(
      'active time 01:01:01',
    );
  });
});
