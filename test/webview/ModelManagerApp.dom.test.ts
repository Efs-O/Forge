// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ModelManagerModelView,
  ModelManagerStateMsg,
} from '../../src/sidebar/modelManager/messages';

/**
 * DOM-level smoke tests for the Model Zoo Manager webview (F7/§2.3). Stubs
 * `acquireVsCodeApi` before importing the app (module-scope singleton call in
 * `webview-ui/src/modelManager/vscode.ts`), mounts `<App/>` with
 * `createRoot`, and drives it via real `window`/`document` events — no
 * `@testing-library/react` dependency, per the coordinator's "keep deps
 * minimal" note. Host-side logic (write path, snapshot assembly) is covered
 * separately in test/unit/ModelManager*.test.ts.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let posted: unknown[] = [];

// The webview module calls `acquireVsCodeApi()` once at import time — the
// stub must exist before the dynamic import below runs.
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }).acquireVsCodeApi =
  () => ({
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
  });

// Dynamic import so it executes after the stub above is installed, and after
// the jsdom environment (declared via the file-level pragma) is active.
const { App } = await import('../../webview-ui/src/modelManager/App');
const React = await import('react');

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function keydownOnDocument(key: string, opts: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

function baseModel(overrides: Partial<ModelManagerModelView>): ModelManagerModelView {
  return {
    name: 'model',
    raw: { name: 'model', provider: 'llama.cpp', gguf_path: '/models/model.gguf' },
    resolved: { name: 'model', provider: 'llama.cpp', gguf_path: '/models/model.gguf' },
    overrideKeys: ['provider', 'gguf_path'],
    provider: 'llama.cpp',
    sizeBytes: 1_000_000_000,
    lastUsed: null,
    fileMissing: false,
    isActive: false,
    isLoaded: false,
    ...overrides,
  };
}

function stateMessage(): ModelManagerStateMsg {
  return {
    type: 'state',
    models: [
      baseModel({
        name: 'alpha-model',
        raw: { name: 'alpha-model', provider: 'llama.cpp', gguf_path: '/models/alpha.gguf' },
      }),
      baseModel({
        name: 'dead-model',
        raw: { name: 'dead-model', provider: 'llama.cpp', gguf_path: '/models/missing.gguf' },
        fileMissing: true,
        sizeBytes: null,
      }),
      baseModel({ name: 'zeta-model', provider: 'ollama', raw: { name: 'zeta-model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' } }),
    ],
    groups: { workers: { num_ctx: 65536 } },
    orphans: [{ path: '/models/orphan.gguf', sizeBytes: 512_000_000 }],
    totalDiskBytes: 1_512_500_000,
    activeModel: null,
    modelDirs: ['/models'],
  };
}

describe('Model Manager webview (DOM smoke)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    posted = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(App));
    });
    // Initial mount posts { type: 'ready' } — drain it before pushing state.
    posted = [];
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: stateMessage() }));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('(a) renders every model row with name, size, and provider', () => {
    const rows = container.querySelectorAll('.mm-row');
    expect(rows.length).toBe(3);
    const text = container.textContent ?? '';
    expect(text).toContain('alpha-model');
    expect(text).toContain('dead-model');
    expect(text).toContain('zeta-model');
    expect(text).toContain('llama.cpp');
    expect(text).toContain('ollama');
    expect(text).toContain('953.7 MB'); // formatBytes(1_000_000_000)
  });

  it('(b) "/" focuses the filter, and typing narrows the visible rows', () => {
    keydownOnDocument('/');
    const filterInput = container.querySelector<HTMLInputElement>('.mm-filter')!;
    expect(document.activeElement).toBe(filterInput);

    act(() => {
      setNativeInputValue(filterInput, 'zeta');
    });

    const rows = container.querySelectorAll('.mm-row');
    expect(rows.length).toBe(1);
    expect(container.textContent).toContain('zeta-model');
    expect(container.textContent).not.toContain('alpha-model');
  });

  it('(c) ArrowDown/ArrowUp move focus, Enter opens the drawer on the Identity tab', () => {
    act(() => keydownOnDocument('ArrowDown')); // focus alpha-model (first, sorted by name)
    act(() => keydownOnDocument('ArrowDown')); // focus dead-model
    act(() => keydownOnDocument('ArrowUp')); // back to alpha-model
    act(() => keydownOnDocument('Enter'));

    const header = container.querySelector('.mm-drawer-header h2');
    expect(header?.textContent).toBe('alpha-model');

    const nameField = container.querySelector<HTMLInputElement>('.mm-tab-grid input[readonly]');
    expect(nameField?.value).toBe('alpha-model');
    expect(container.querySelector('.mm-tab-nav .mm-tab-active')?.textContent).toBe('Identity');
  });

  it('(d) Del posts a removeModel message for the focused model', () => {
    act(() => keydownOnDocument('ArrowDown'));
    act(() => keydownOnDocument('Delete'));

    const removeMsg = posted.find((m) => (m as { type: string }).type === 'removeModel');
    expect(removeMsg).toEqual({ type: 'removeModel', modelName: 'alpha-model' });
  });

  it('(e) editing a field and committing posts the expected editField message', () => {
    act(() => keydownOnDocument('ArrowDown'));
    act(() => keydownOnDocument('Enter'));

    const shortNameInput = container.querySelector<HTMLInputElement>('#mm-field-short_name')!;
    expect(shortNameInput).toBeTruthy();
    act(() => shortNameInput.focus());
    act(() => setNativeInputValue(shortNameInput, 'a1'));
    act(() => pressEnter(shortNameInput));

    const editMsg = posted.find((m) => (m as { type: string }).type === 'editField');
    expect(editMsg).toEqual({
      type: 'editField',
      modelName: 'alpha-model',
      field: 'short_name',
      value: 'a1',
    });
  });

  it('(f) purge dialog requires the exact typed name before the confirm button enables', () => {
    act(() => keydownOnDocument('ArrowDown'));
    act(() => keydownOnDocument('Delete', { ctrlKey: true }));

    const dialog = container.querySelector('.mm-modal')!;
    expect(dialog).toBeTruthy();
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Delete permanently'),
    )!;
    expect(confirmBtn.disabled).toBe(true);

    act(() => setNativeInputValue(input, 'not-the-name'));
    expect(confirmBtn.disabled).toBe(true);

    act(() => setNativeInputValue(input, 'alpha-model'));
    expect(confirmBtn.disabled).toBe(false);

    act(() => confirmBtn.click());
    const purgeMsg = posted.find((m) => (m as { type: string }).type === 'purgeModel');
    expect(purgeMsg).toEqual({ type: 'purgeModel', modelName: 'alpha-model', typedName: 'alpha-model' });
  });

  it('(g) renders the dead-entry warning icon and the orphans section', () => {
    const deadRow = Array.from(container.querySelectorAll('.mm-row')).find((r) =>
      r.textContent?.includes('dead-model'),
    )!;
    expect(deadRow.querySelector('.mm-warn')).toBeTruthy();

    const orphans = container.querySelector('.mm-orphans');
    expect(orphans).toBeTruthy();
    expect(orphans?.textContent).toContain('orphan.gguf');
  });
});
