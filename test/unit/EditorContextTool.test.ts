import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined as unknown,
    tabGroups: { all: [] as unknown[] },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/ws' } }],
    asRelativePath: (u: { fsPath: string }) => u.fsPath.replace(/^\/ws\//, ''),
    openTextDocument: async () => undefined,
  },
  commands: { executeCommand: vi.fn() },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { makeGetEditorContextTool } from '../../src/tools/builtinTools';
import { makeFindImplementationsTool } from '../../src/tools/lspTools';

const win = vscode.window as unknown as {
  activeTextEditor: unknown;
  tabGroups: { all: unknown[] };
};

function editor(text: string, sel: { sl: number; sc: number; el: number; ec: number }) {
  const start = { line: sel.sl, character: sel.sc };
  const end = { line: sel.el, character: sel.ec };
  return {
    document: {
      uri: { fsPath: '/ws/src/app.ts' },
      languageId: 'typescript',
      lineCount: 42,
      getText: () => text,
    },
    selection: {
      start,
      end,
      active: end,
      isEmpty: sel.sl === sel.el && sel.sc === sel.ec,
    },
  };
}

describe('get_editor_context', () => {
  beforeEach(() => {
    win.activeTextEditor = undefined;
    win.tabGroups.all = [];
  });

  it('reports no active editor without throwing', async () => {
    const out = (await makeGetEditorContextTool().handler({})) as string;
    expect(out).toContain('Active editor: (none)');
    expect(out).toContain('Open tabs: (none)');
  });

  it('returns the selected text and a one-based range', async () => {
    win.activeTextEditor = editor('const x = 1;', { sl: 9, sc: 0, el: 11, ec: 5 });
    const out = (await makeGetEditorContextTool().handler({})) as string;
    expect(out).toContain('Active editor: src/app.ts (typescript, 42 lines)');
    expect(out).toContain('Cursor (1-based): line 12, column 6');
    expect(out).toContain('Selection (1-based): lines 10-12, 12 chars');
    expect(out).toContain('const x = 1;');
  });

  it('marks an empty selection rather than emitting a blank block', async () => {
    win.activeTextEditor = editor('', { sl: 3, sc: 4, el: 3, ec: 4 });
    const out = (await makeGetEditorContextTool().handler({})) as string;
    expect(out).toContain('Selection: (empty)');
    expect(out).not.toContain('--- selected text ---');
  });

  it('lists open tabs, skipping non-file tabs and deduplicating splits', async () => {
    win.tabGroups.all = [
      { tabs: [{ input: { uri: { fsPath: '/ws/a.ts' } } }, { input: undefined }] },
      { tabs: [{ input: { uri: { fsPath: '/ws/a.ts' } } }, { input: { uri: { fsPath: '/ws/b.ts' } } }] },
    ];
    const out = (await makeGetEditorContextTool().handler({})) as string;
    expect(out).toContain('Open tabs (2):');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
  });
});

describe('find_implementations', () => {
  it('renders LocationLink results, which the provider may return instead of Location', async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
      { targetUri: { fsPath: '/ws/src/impl.ts' }, targetRange: { start: { line: 7, character: 2 } } },
    ] as never);
    const out = (await makeFindImplementationsTool().handler({
      path: 'src/app.ts',
      line: 3,
      character: 10,
    })) as string;
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.executeImplementationProvider',
      expect.anything(),
      expect.anything(),
    );
    expect(out).toBe('src/impl.ts:8:3');
  });

  it('says so when nothing implements the symbol', async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined as never);
    const out = (await makeFindImplementationsTool().handler({
      path: 'src/app.ts',
      line: 1,
      character: 1,
    })) as string;
    expect(out).toBe('No implementations found.');
  });
});
