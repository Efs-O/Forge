// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as {
  acquireVsCodeApi?: () => { postMessage: () => void; getState: () => undefined; setState: () => void };
}).acquireVsCodeApi = () => ({ postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() });

const { InputRow } = await import('../../webview-ui/src/components/InputRow');
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

describe('InputRow slash commands', () => {
  it('offers a new conversation while streaming without exposing conflicting commands', () => {
    const onRunSlashCommand = vi.fn();
    act(() => {
      root.render(
        React.createElement(InputRow, {
          onSend: vi.fn(),
          onCancel: vi.fn(),
          streaming: true,
          backendReady: true,
          prefillText: '/',
          onPrefillConsumed: vi.fn(),
          clankerMode: false,
          onRunSlashCommand,
          slashCommands: [
            { id: 'unloadModel', trigger: 'unload', title: 'Unload Model', description: 'Stop backend.' },
            {
              id: 'newChat',
              trigger: 'new',
              title: 'New Chat',
              description: 'Open a new conversation tab.',
              availableWhileStreaming: true,
            },
          ],
        }),
      );
    });

    expect(container.querySelector('#slash-menu')).not.toBeNull();
    expect(container.textContent).toContain('New Chat');
    expect(container.textContent).not.toContain('Unload Model');
    act(() => container.querySelector<HTMLButtonElement>('.slash-item')!.click());
    expect(onRunSlashCommand).toHaveBeenCalledWith('newChat');
  });
});
