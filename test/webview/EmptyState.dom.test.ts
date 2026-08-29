// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { EmptyState, describeBackend } = await import('../../webview-ui/src/components/EmptyState');
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

describe('describeBackend', () => {
  it('reports a resident local model with its per-slot window', () => {
    expect(
      describeBackend({ modelName: 'qwen3.8-27b', residency: 'ready', contextMax: 32768 }),
    ).toEqual({ tone: 'ok', primary: 'qwen3.8-27b · resident', secondary: '32.8k ctx per slot' });
  });

  it('replaces the ctx line while a model is still spawning', () => {
    expect(
      describeBackend({ modelName: 'qwen3.8-27b', residency: 'loading', contextMax: 32768 }),
    ).toEqual({
      tone: 'warn',
      primary: 'qwen3.8-27b · loading',
      secondary: 'spawning llama-server…',
    });
  });

  it('says a cold model is not loaded without claiming it is unavailable', () => {
    expect(describeBackend({ modelName: 'gemma3', residency: 'cold', contextMax: 8192 })).toEqual({
      tone: 'idle',
      primary: 'gemma3 · not loaded',
      secondary: '8.2k ctx per slot',
    });
  });

  it('names the provider for a remote route rather than inventing a load state', () => {
    // Absent residency is the remote case by design — rendering it as `cold`
    // would advertise a VRAM load cost that does not exist.
    expect(describeBackend({ modelName: 'grok-4', provider: 'xai', contextMax: 131072 })).toEqual({
      tone: 'ok',
      primary: 'grok-4 · xai',
      secondary: '131.1k ctx per slot',
    });
  });

  it('drops the ctx line when the per-slot window is unknown', () => {
    expect(describeBackend({ modelName: 'gemma3', residency: 'ready', contextMax: 0 })).toEqual({
      tone: 'ok',
      primary: 'gemma3 · resident',
    });
  });

  it('reports no selection rather than guessing one', () => {
    expect(describeBackend({ modelName: null, contextMax: 0 })).toEqual({
      tone: 'idle',
      primary: 'no model selected',
    });
  });
});

describe('EmptyState', () => {
  it('renders the mark and the backend lines, reusing the picker residency dot', () => {
    act(() => {
      root.render(
        React.createElement(EmptyState, {
          modelName: 'qwen3.8-27b',
          residency: 'ready',
          contextMax: 32768,
        }),
      );
    });

    expect(container.querySelector('#empty-mark')).not.toBeNull();
    expect(container.textContent).toContain('qwen3.8-27b · resident');
    expect(container.textContent).toContain('32.8k ctx per slot');
    // The same class the model picker uses, so the two can never disagree.
    expect(container.querySelector('.ms-dot--ready')).not.toBeNull();
  });
});
