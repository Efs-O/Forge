// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as {
    acquireVsCodeApi?: () => {
      postMessage: () => void;
      getState: () => undefined;
      setState: () => void;
    };
  }
).acquireVsCodeApi = () => ({ postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() });

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

const COMMANDS = [
  { id: 'unloadModel', trigger: 'unload', title: 'Unload Model', description: 'Stop backend.' },
  {
    id: 'newChat',
    trigger: 'new',
    title: 'New Chat',
    description: 'Open a new conversation tab.',
    availableWhileStreaming: true,
  },
];

function renderInput(
  streaming: boolean,
  onRunSlashCommand = vi.fn(),
  remote: { transports: string[]; paired: boolean } = { transports: [], paired: false },
): typeof onRunSlashCommand {
  act(() => {
    root.render(
      React.createElement(InputRow, {
        onSend: vi.fn(),
        onCancel: vi.fn(),
        streaming,
        backendReady: true,
        prefillText: '/',
        onPrefillConsumed: vi.fn(),
        clankerMode: false,
        onRunSlashCommand,
        slashCommands: COMMANDS,
        models: [],
        activeModel: null,
        onModelChange: vi.fn(),
        modelPickerDisabled: false,
        remote,
        activeConversationId: 'test-conversation',
      }),
    );
  });
  return onRunSlashCommand;
}

function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.slash-item'));
}

describe('InputRow slash commands', () => {
  it('lists every command while streaming, disabling the ones that would break the turn', () => {
    // Filtering these out left a one-entry menu that read as broken, and hid
    // the fact that the commands exist at all.
    renderInput(true);

    expect(container.querySelector('#slash-menu')).not.toBeNull();
    expect(container.textContent).toContain('New Chat');
    expect(container.textContent).toContain('Unload Model');

    const [unload, newChat] = items();
    expect(unload!.disabled).toBe(true);
    expect(unload!.textContent).toContain('Unavailable while the agent is generating');
    expect(newChat!.disabled).toBe(false);
  });

  it('runs a streaming-safe command and ignores a disabled one', () => {
    const onRunSlashCommand = renderInput(true);

    const [unload, newChat] = items();
    act(() => unload!.click());
    expect(onRunSlashCommand).not.toHaveBeenCalled();

    act(() => newChat!.click());
    expect(onRunSlashCommand).toHaveBeenCalledWith('newChat');
  });

  it('highlights the first runnable command rather than a disabled one', () => {
    renderInput(true);
    // Enter would silently do nothing if the selection rested on /unload.
    expect(items()[0]!.className).not.toContain('selected');
    expect(items()[1]!.className).toContain('selected');
  });

  it('enables everything once the turn ends', () => {
    renderInput(false);
    expect(items().every((item) => !item.disabled)).toBe(true);
    expect(items()[0]!.className).toContain('selected');
  });
});

describe('remote-control chip', () => {
  const chip = (): HTMLElement | null => container.querySelector('#remote-chip');

  it('says nothing when no transport is running', () => {
    renderInput(false, vi.fn(), { transports: [], paired: false });
    expect(chip()).toBeNull();
  });

  it('reads active only once an owner is paired', () => {
    renderInput(false, vi.fn(), { transports: ['telegram'], paired: true });
    expect(chip()?.textContent).toBe('Remote active');
    expect(chip()?.className).toContain('is-paired');
  });

  // The distinction the chip exists to make: a running transport with nobody
  // paired answers /pair and nothing else, so it must not claim to be reachable.
  it('reads waiting while a running transport has no owner', () => {
    renderInput(false, vi.fn(), { transports: ['whatsapp'], paired: false });
    expect(chip()?.textContent).toBe('Remote waiting');
    expect(chip()?.className).toContain('is-unpaired');
    expect(chip()?.getAttribute('title')).toContain('no owner is paired');
  });

  it('names every running transport in one chip, not one chip each', () => {
    renderInput(false, vi.fn(), { transports: ['telegram', 'whatsapp'], paired: true });
    expect(container.querySelectorAll('#remote-chip')).toHaveLength(1);
    expect(chip()?.getAttribute('title')).toContain('telegram · whatsapp');
  });
});
