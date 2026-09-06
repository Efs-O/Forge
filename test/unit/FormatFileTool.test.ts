import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  window: {
    visibleTextEditors: [] as unknown[],
    // Present so a regression that reintroduces editor activation fails loudly
    // rather than silently passing against an undefined mock.
    showTextDocument: vi.fn(async () => {
      throw new Error('format_file must not show an editor');
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/ws' } }],
    openTextDocument: vi.fn(),
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
    applyEdit: vi.fn(async () => true),
  },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  WorkspaceEdit: class {
    entries_: Array<[unknown, unknown]> = [];
    set(uri: unknown, edits: unknown) {
      this.entries_.push([uri, edits]);
    }
  },
}));

import { makeFormatFileTool, resolveFormattingOptions } from '../../src/tools/fileEditTools';

const win = vscode.window as unknown as { visibleTextEditors: unknown[] };
const ws = vscode.workspace as unknown as {
  openTextDocument: ReturnType<typeof vi.fn>;
  getConfiguration: ReturnType<typeof vi.fn>;
  applyEdit: ReturnType<typeof vi.fn>;
};
const cmds = vscode.commands as unknown as { executeCommand: ReturnType<typeof vi.fn> };

function doc(opts: { version?: number; save?: () => Promise<boolean> } = {}) {
  return {
    uri: { fsPath: '/ws/a.ts', toString: () => 'file:///ws/a.ts' },
    languageId: 'typescript',
    version: opts.version ?? 1,
    save: opts.save ?? (async () => true),
  };
}

const format = (path = 'a.ts', context?: Parameters<ReturnType<typeof makeFormatFileTool>['handler']>[1]) =>
  makeFormatFileTool().handler({ path }, context) as Promise<string>;

describe('format_file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    win.visibleTextEditors = [];
    ws.applyEdit.mockResolvedValue(true);
    ws.getConfiguration.mockReturnValue({ get: () => undefined });
  });

  it('formats through the provider without opening, showing or closing an editor', async () => {
    const d = doc();
    ws.openTextDocument.mockResolvedValue(d);
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);

    expect(await format()).toBe('Formatted: a.ts');

    const commandNames = cmds.executeCommand.mock.calls.map((c) => c[0]);
    expect(commandNames).toEqual(['vscode.executeFormatDocumentProvider']);
    expect(commandNames).not.toContain('workbench.action.closeActiveEditor');
    expect(commandNames).not.toContain('editor.action.formatDocument');
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(ws.applyEdit).toHaveBeenCalledOnce();
  });

  it('reports the absent/no-result ambiguity instead of claiming success', async () => {
    ws.openTextDocument.mockResolvedValue(doc());
    cmds.executeCommand.mockResolvedValue(undefined);

    const out = await format();
    expect(out).toContain('a formatter may not be available');
    expect(out).not.toContain('Formatted:');
    expect(ws.applyEdit).not.toHaveBeenCalled();
  });

  it('distinguishes an empty edit list from a missing provider', async () => {
    ws.openTextDocument.mockResolvedValue(doc());
    cmds.executeCommand.mockResolvedValue([]);

    expect(await format()).toContain('returned no edits');
    expect(ws.applyEdit).not.toHaveBeenCalled();
  });

  it('refuses to apply edits computed against a stale document version', async () => {
    const d = doc({ version: 1 });
    ws.openTextDocument.mockResolvedValue(d);
    cmds.executeCommand.mockImplementation(async () => {
      d.version = 2;
      return [{ newText: 'x' }];
    });

    await expect(format()).rejects.toThrow(/changed while formatting/);
    expect(ws.applyEdit).not.toHaveBeenCalled();
  });

  it('does not apply edits after cancellation', async () => {
    ws.openTextDocument.mockResolvedValue(doc());
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);
    const controller = new AbortController();
    controller.abort();

    await expect(format('a.ts', { beforeMutate: () => {}, abortSignal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(ws.applyEdit).not.toHaveBeenCalled();
  });

  it('reports a rejected workspace edit rather than success', async () => {
    ws.openTextDocument.mockResolvedValue(doc());
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);
    ws.applyEdit.mockResolvedValue(false);

    await expect(format()).rejects.toThrow(/workspace edit was rejected/);
  });

  it('reports a failed save rather than success', async () => {
    ws.openTextDocument.mockResolvedValue(doc({ save: async () => false }));
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);

    await expect(format()).rejects.toThrow(/could not be saved/);
  });

  it('propagates a provider error', async () => {
    ws.openTextDocument.mockResolvedValue(doc());
    cmds.executeCommand.mockRejectedValue(new Error('prettier exploded'));

    await expect(format()).rejects.toThrow(/prettier exploded/);
  });
});

describe('resolveFormattingOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    win.visibleTextEditors = [];
    ws.getConfiguration.mockReturnValue({ get: () => undefined });
  });

  it('reuses a visible editor’s resolved options without activating it', () => {
    const d = doc();
    win.visibleTextEditors = [{ document: d, options: { tabSize: 2, insertSpaces: false } }];
    expect(resolveFormattingOptions(d as unknown as vscode.TextDocument)).toEqual({
      tabSize: 2,
      insertSpaces: false,
    });
    expect(ws.getConfiguration).not.toHaveBeenCalled();
  });

  it('falls back to document- and language-scoped configuration', () => {
    ws.getConfiguration.mockReturnValue({
      get: (k: string) => (k === 'tabSize' ? 8 : false),
    });
    expect(resolveFormattingOptions(doc() as unknown as vscode.TextDocument)).toEqual({
      tabSize: 8,
      insertSpaces: false,
    });
    expect(ws.getConfiguration).toHaveBeenCalledWith('editor', {
      uri: expect.anything(),
      languageId: 'typescript',
    });
  });

  it('ignores an unresolved "auto" editor option and non-numeric settings', () => {
    const d = doc();
    win.visibleTextEditors = [{ document: d, options: { tabSize: 'auto', insertSpaces: 'auto' } }];
    ws.getConfiguration.mockReturnValue({ get: (k: string) => (k === 'tabSize' ? '4' : 'yes') });
    // Neither source yields usable values, so the documented defaults apply
    // rather than NaN reaching the formatter.
    expect(resolveFormattingOptions(d as unknown as vscode.TextDocument)).toEqual({
      tabSize: 4,
      insertSpaces: true,
    });
  });
});
