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
const { shortenName } = await import('../../webview-ui/src/components/AttachmentTray');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;
let onSend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onSend = vi.fn();
  act(() => {
    root.render(
      React.createElement(InputRow, {
        onSend,
        onCancel: vi.fn(),
        streaming: false,
        backendReady: true,
        prefillText: null,
        onPrefillConsumed: vi.fn(),
        clankerMode: false,
        onRunSlashCommand: vi.fn(),
        slashCommands: [],
        models: [],
        activeModel: null,
        onModelChange: vi.fn(),
        modelPickerDisabled: false,
        remote: { transports: [], paired: false },
        activeConversationId: 'test-conversation',
      }),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function textFile(name: string, size = 12): File {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' });
}

/** jsdom has no DataTransfer, and React only reads the fields we set here. */
function fileEvent(type: 'drop' | 'dragenter' | 'paste', files: File[], text = ''): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type })),
    types: ['Files'],
    dropEffect: 'none',
    getData: () => text,
  };
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', {
    value: transfer,
  });
  return event;
}

/** Attachments land through FileReader callbacks, so flush the microtask queue. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function drop(files: File[]): Promise<void> {
  const row = container.querySelector('#input-row')!;
  act(() => {
    row.dispatchEvent(fileEvent('drop', files));
  });
  await settle();
}

function tiles(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.attachment-tile'));
}

function errors(): string[] {
  return Array.from(container.querySelectorAll('.attachment-error-list span')).map(
    (node) => node.textContent ?? '',
  );
}

describe('InputRow attachments', () => {
  it('stages files dropped onto the composer', async () => {
    await drop([textFile('notes.md'), textFile('main.ts')]);

    expect(tiles()).toHaveLength(2);
    expect(container.textContent).toContain('notes.md');
    expect(container.textContent).toContain('main.ts');
    expect(errors()).toEqual([]);
  });

  it('stages files pasted into the textarea', async () => {
    const textarea = container.querySelector('#prompt')!;
    act(() => {
      textarea.dispatchEvent(fileEvent('paste', [textFile('pasted.ts')]));
    });
    await settle();

    expect(tiles()).toHaveLength(1);
    expect(container.textContent).toContain('pasted.ts');
  });

  it('rejects only the unsupported file and keeps the rest', async () => {
    // The old picker alerted once per bad file and dropped the whole batch.
    await drop([
      textFile('good.ts'),
      new File(['x'], 'setup.exe', { type: 'application/x-msdos-program' }),
    ]);

    expect(tiles()).toHaveLength(1);
    expect(container.textContent).toContain('good.ts');
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain('setup.exe');
  });

  it('names the limit a too-large file broke', async () => {
    await drop([textFile('huge.ts', 3 * 1024 * 1024)]);

    expect(tiles()).toHaveLength(0);
    expect(errors()[0]).toContain('2.0 MiB');
  });

  it('caps the batch at ten files per message', async () => {
    await drop(Array.from({ length: 12 }, (_, i) => textFile(`f${i}.ts`)));

    expect(tiles()).toHaveLength(10);
    expect(errors()).toHaveLength(2);
    expect(errors()[0]).toContain('10 files per message');
  });

  it('removes one attachment and clears the rest', async () => {
    await drop([textFile('a.ts'), textFile('b.ts'), textFile('c.ts')]);

    act(() => container.querySelector<HTMLButtonElement>('.attachment-remove')!.click());
    expect(tiles()).toHaveLength(2);
    expect(container.textContent).not.toContain('a.ts');

    act(() => container.querySelector<HTMLButtonElement>('.attachment-clear')!.click());
    expect(tiles()).toHaveLength(0);
  });

  it('sends the staged files and empties the tray', async () => {
    await drop([textFile('a.ts')]);
    act(() => container.querySelector<HTMLButtonElement>('#btn-send')!.click());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![1]).toHaveLength(1);
    expect(tiles()).toHaveLength(0);
  });

  it('arms the drop target for files and ignores a text drag', () => {
    const row = container.querySelector('#input-row')!;

    act(() => {
      const bare = new Event('dragenter', { bubbles: true });
      Object.defineProperty(bare, 'dataTransfer', { value: { types: ['text/plain'] } });
      row.dispatchEvent(bare);
    });
    expect(container.querySelector('#drop-overlay')).toBeNull();

    act(() => {
      row.dispatchEvent(fileEvent('dragenter', [textFile('a.ts')]));
    });
    expect(container.querySelector('#drop-overlay')).not.toBeNull();

    act(() => {
      row.dispatchEvent(new Event('dragleave', { bubbles: true }));
    });
    expect(container.querySelector('#drop-overlay')).toBeNull();
  });
});

describe('shortenName', () => {
  it('trims the middle so the extension survives', () => {
    expect(shortenName('ContextBudgetPublisher.test.ts')).toContain('…');
    expect(shortenName('ContextBudgetPublisher.test.ts').endsWith('test.ts')).toBe(true);
    expect(shortenName('short.ts')).toBe('short.ts');
  });
});
