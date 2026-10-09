// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityGroupItem } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ActivityGroup } = await import('../../webview-ui/src/components/ActivityGroup');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function tool(id: string, extra: Partial<AppMessage> = {}): AppMessage {
  return { id, role: 'tool', content: 'edit_file', toolName: 'edit_file', toolResultTotal: 10, ...extra };
}

function activityItems(options: { failed?: boolean; pending?: boolean } = {}): ActivityGroupItem[] {
  const first: AppMessage = {
    id: 'thought', role: 'assistant', content: '', reasoning: 'planning', reasoningMs: 1_000,
  };
  const finalTool = options.pending
    ? tool('pending', { toolResultTotal: undefined })
    : tool('completed', options.failed ? { toolIsError: true } : {});
  return [
    { kind: 'step', step: { attempts: [{ thoughts: [first], tools: [finalTool] }], diffs: [] } },
    { kind: 'step', step: { attempts: [{ thoughts: [], tools: [tool('second')] }], diffs: [] } },
  ];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetDisclosures();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(items: ActivityGroupItem[], live: boolean, streaming: boolean): void {
  act(() => root.render(React.createElement(ActivityGroup, { items, live, streaming })));
}

function toggle(): void {
  act(() => container.querySelector<HTMLButtonElement>('.activity-group-toggle')!.click());
}

describe('ActivityGroup', () => {
  it('starts open while live and shows the working header', () => {
    render(activityItems(), true, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('● working · 2 calls');
    expect(container.querySelectorAll('.activity-row')).toHaveLength(2);
  });

  it('collapses when live ends if the reader did not toggle it', () => {
    const items = activityItems();
    render(items, true, true);
    render(items, false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.activity-group-body')).toBeNull();
  });

  it('keeps a manual toggle across the live-to-not-live transition', () => {
    const items = activityItems();
    render(items, true, true);
    toggle(); // Explicitly close the live group.
    render(items, false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.activity-group-body')).toBeNull();
  });

  it('starts open for an unrecovered failure', () => {
    render(activityItems({ failed: true }), false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.activity-group-failed')?.textContent).toBe('[1 failed]');
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('✕');
  });

  it('starts open for pending calls while streaming', () => {
    render(activityItems({ pending: true }), false, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('○');
  });

  it('counts recovered retries with the right plural', () => {
    const failedTry = (id: string) => ({ thoughts: [], tools: [tool(id, { toolIsError: true })] });
    const recovered = (n: number): ActivityGroupItem => ({ kind: 'step', step: {
      attempts: [...Array.from({ length: n }, (_, i) => failedTry(`f${n}-${i}`)), { thoughts: [], tools: [tool(`ok${n}`)] }],
      diffs: [],
    } });
    render([recovered(1), { kind: 'step', step: { attempts: [{ thoughts: [], tools: [tool('x')] }], diffs: [] } }], false, false);
    expect(container.querySelector('.activity-group-retry')?.textContent).toBe('[1 retry]');
    render([recovered(1), recovered(2)], false, false);
    expect(container.querySelector('.activity-group-retry')?.textContent).toBe('[3 retries]');
  });
});
