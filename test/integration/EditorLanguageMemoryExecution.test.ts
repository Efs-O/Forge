import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFindFilesTool } from '../../src/tools/dirTools';
import { MemoryStore, attachMemoryStore } from '../../src/memory/memoryStore';
import { makeRenameSymbolTool } from '../../src/tools/fileEditTools';
import { makeCodeIntelTool } from '../../src/tools/codeIntelTool';
import {
  makeListMemoriesTool,
  makeRecallTool,
  makeRememberTool,
} from '../../src/tools/memoryTools';
import { makeSearchCodebaseTool } from '../../src/tools/semanticSearchTool';
import type { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { makeCopyToClipboardTool, makeReadClipboardTool } from '../../src/tools/clipboardTools';
import {
  makeOpenUrlTool,
  makeOpenFileTool,
  makeShowDiffTool,
  makeShowNotificationTool,
} from '../../src/tools/uxTools';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import type { IndexManager } from '../../src/search/IndexManager';

describe('isolated editor, language, search, and memory tool execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-editor-tools-'));
    fs.writeFileSync(path.join(root, 'sample.ts'), 'const sample = 1;\n', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('executes discovery and semantic-search handlers with controlled results', async () => {
    // find_files runs ripgrep now, not vscode.workspace.findFiles — one engine
    // shared with search_code, so the two cannot disagree about the workspace.
    const stub = path.join(root, 'rg-stub.js');
    fs.writeFileSync(stub, "process.stdout.write('sample.ts');", 'utf8');
    const resolveStub = () => ({
      command: process.execPath,
      argsPrefix: [stub],
      candidates: [] as string[],
    });
    await expect(
      makeFindFilesTool(resolveStub).handler({ pattern: '**/*.ts', max_results: 5 }),
    ).resolves.toBe('sample.ts');

    const search = vi
      .fn()
      .mockResolvedValue([
        { path: 'sample.ts', startLine: 1, endLine: 1, score: 0.9, snippet: 'const sample = 1;' },
      ]);
    const tool = makeSearchCodebaseTool({ search } as unknown as IndexManager);
    await expect(tool.handler({ query: 'sample constant', top_k: 1 })).resolves.toContain(
      'sample.ts',
    );
    expect(search).toHaveBeenCalledWith('sample constant', 1, undefined);
  });

  it('serializes diagnostics, symbols, hover, definitions, and references', async () => {
    const uri = vscode.Uri.file(path.join(root, 'sample.ts'));
    vi.spyOn(vscode.languages, 'getDiagnostics').mockReturnValue([
      {
        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5)),
        severity: vscode.DiagnosticSeverity.Warning,
        message: 'fixture warning',
      },
    ] as never);
    await expect(
      makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'sample.ts' }),
    ).resolves.toBe('sample.ts:1: warning: fixture warning');

    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(
      async (command: string): Promise<unknown> => {
        if (command === 'vscode.executeDocumentSymbolProvider') {
          return [
            {
              name: 'sample',
              kind: vscode.SymbolKind.Variable,
              range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)),
              selectionRange: new vscode.Range(
                new vscode.Position(0, 6),
                new vscode.Position(0, 12),
              ),
              children: [],
            },
          ];
        }
        if (command === 'vscode.executeWorkspaceSymbolProvider') {
          return [
            {
              name: 'sample',
              kind: vscode.SymbolKind.Variable,
              location: {
                uri,
                range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)),
              },
            },
          ];
        }
        if (command === 'vscode.executeHoverProvider')
          return [{ contents: [{ value: 'const sample: 1' }] }];
        if (
          command === 'vscode.executeDefinitionProvider' ||
          command === 'vscode.executeReferenceProvider'
        ) {
          return [
            { uri, range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)) },
          ];
        }
        return undefined;
      },
    );

    await expect(
      makeCodeIntelTool().handler({ operation: 'document_symbols', path: 'sample.ts' }),
    ).resolves.toBe(
      'Variable sample (line 0, character 6)\n\nPositions are zero-based line:character, the same as the line and character inputs.',
    );
    await expect(
      makeCodeIntelTool().handler({ operation: 'workspace_symbols', query: 'sample' }),
    ).resolves.toBe(
      'Variable sample — sample.ts:0:0\n\nPositions are zero-based line:character, the same as the line and character inputs.',
    );
    await expect(
      makeCodeIntelTool().handler({ operation: 'hover', path: 'sample.ts', line: 0, character: 1 }),
    ).resolves.toBe('const sample: 1');
    await expect(
      makeCodeIntelTool().handler({
        operation: 'definition',
        path: 'sample.ts',
        line: 0,
        character: 1,
      }),
    ).resolves.toBe(
      'sample.ts:0:0\n\nPositions are zero-based line:character, the same as the line and character inputs.',
    );
    await expect(
      makeCodeIntelTool().handler({
        operation: 'references',
        path: 'sample.ts',
        line: 0,
        character: 1,
      }),
    ).resolves.toBe(
      'sample.ts:0:0\n\nPositions are zero-based line:character, the same as the line and character inputs.',
    );
  });

  it('executes controlled diff, prompt, notification, clipboard, and URL handlers', async () => {
    const command = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('fixture answer');
    const notification = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    // open_url opens through the OS opener (c6807d0b), never openExternal; the
    // double keeps this test from launching a real browser.
    const browser = new EventEmitter() as ChildProcess;
    browser.unref = vi.fn();
    const spawnProcess = vi.fn((() => {
      queueMicrotask(() => browser.emit('spawn'));
      return browser;
    }) as typeof spawn);

    await expect(
      makeShowDiffTool().handler({ original_path: 'sample.ts', modified_path: 'sample.ts' }),
    ).resolves.toBe('Diff opened.');
    expect(command).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      'Forge Diff',
    );
    // ask_user no longer owns presentation: it asks the question service, which
    // races the local box against a remote chat. The box mechanics are covered
    // in UserQuestionService's own tests, so a stub is the honest double here.
    const questions = {
      ask: vi.fn(async () => 'fixture answer'),
      askWithRecord: vi.fn(async () => ({ answer: 'fixture answer' })),
    } as unknown as UserQuestionService;
    await expect(makeAskUserTool(questions).handler({ prompt: 'Question?' })).resolves.toBe(
      'fixture answer',
    );
    await makeShowNotificationTool().handler({ message: 'notice', level: 'warning' });
    expect(notification).toHaveBeenCalledWith('notice');
    await makeCopyToClipboardTool().handler({ text: 'clipboard fixture' });
    const clipboardText = String(await makeReadClipboardTool().handler({}));
    // The clipboard is another program's text, so it arrives marked as untrusted:
    // a prompt copied out of another chat must not read as Forge's own instruction.
    expect(clipboardText).toContain('clipboard fixture');
    expect(clipboardText.startsWith('<UNTRUSTED_CONTENT>')).toBe(true);
    expect(clipboardText.endsWith('</UNTRUSTED_CONTENT>')).toBe(true);
    expect(makeReadClipboardTool().untrustedResult).toBe(true);
    await expect(
      makeOpenUrlTool({ spawnProcess }).handler({ url: 'https://example.com/' }),
    ).resolves.toBe('Opened https://example.com/ in the default browser.');
    expect(spawnProcess).toHaveBeenCalledOnce();
    await expect(
      makeOpenUrlTool({ spawnProcess }).handler({ url: 'file:///secret' }),
    ).rejects.toThrow('must start with');
  });

  // open_file exists because the plumbing did and the tool did not: the webview
  // could open a file link and auto-open-after-write could open a written file,
  // but "open config.yaml in the editor" was a request the agent had no way to
  // satisfy — it read the file into the chat instead, which is a different
  // thing. A capability the model cannot reach leaves no trace in the logs.
  it('opens a file in the editor rather than returning its contents', async () => {
    const show = vi.spyOn(vscode.window, 'showTextDocument');

    await expect(makeOpenFileTool().handler({ path: 'sample.ts' })).resolves.toBe(
      'Opened sample.ts in the editor.',
    );
    // Never a preview tab: a preview is replaced by the next thing opened, so
    // the file the user asked for would vanish behind the agent's own reads.
    expect(show.mock.calls[0]?.[1]).toMatchObject({ preview: false, preserveFocus: false });
    expect(show.mock.calls[0]?.[1]).not.toHaveProperty('viewColumn');

    await expect(makeOpenFileTool().handler({ path: 'sample.ts', beside: true })).resolves.toBe(
      'Opened sample.ts in the editor.',
    );
    expect(show.mock.calls[1]?.[1]).toMatchObject({ viewColumn: vscode.ViewColumn.Beside });
  });

  it('reports a requested line past EOF after opening at the final line', async () => {
    const show = vi.spyOn(vscode.window, 'showTextDocument');

    await expect(makeOpenFileTool().handler({ path: 'sample.ts', line: 1 })).resolves.toBe(
      'Opened sample.ts in the editor at line 1.',
    );
    await expect(makeOpenFileTool().handler({ path: 'sample.ts', line: 900 })).resolves.toBe(
      'line 900 is past the end of the file (2 lines); opened at line 2.',
    );
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('names the file it could not open instead of failing bare', async () => {
    vi.spyOn(vscode.workspace, 'openTextDocument').mockRejectedValue(new Error('ENOENT'));
    await expect(makeOpenFileTool().handler({ path: 'missing.ts' })).rejects.toThrow(
      'open_file: cannot open missing.ts',
    );
  });

  it('executes rename through a disposable VS Code adapter and saves the change', async () => {
    const save = vi.fn().mockResolvedValue(true);
    // The fake document carries a version the fake applyEdit advances.
    const doc = {
      uri: vscode.Uri.file(path.join(root, 'sample.ts')),
      save,
      version: 1,
      lineCount: 1,
      lineAt: () => ({ text: 'const sample = 1;' }),
      getWordRangeAtPosition: () => ({
        start: new vscode.Position(0, 6),
        end: new vscode.Position(0, 12),
      }),
      getText: () => 'sample',
    };
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue(doc as never);
    const workspaceEdit = {
      entries: () => [[vscode.Uri.file(path.join(root, 'sample.ts')), []]],
    };
    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockImplementation(async (command: string) => {
        if (command === 'vscode.executeDocumentRenameProvider') return workspaceEdit;
        return undefined;
      });
    const apply = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async () => {
      doc.version += 1;
      return true;
    });

    const beforeMutate = vi.fn();
    await expect(
      makeRenameSymbolTool().handler(
        { path: 'sample.ts', line: 0, character: 7, new_name: 'renamed' },
        { beforeMutate },
      ),
    ).resolves.toBe(
      'Renamed to renamed\n\nNote: a text search still finds `sample` in 1 file(s) after the rename: sample.ts. Check them with search_code; they may be comments or strings, or files the language server had not loaded.',
    );
    expect(beforeMutate).toHaveBeenCalledWith([path.join(root, 'sample.ts')]);
    expect(apply).toHaveBeenCalledWith(workspaceEdit);
    // The rename is saved so the disk checkpoint, and Undo, cover it (U15-02).
    expect(save).toHaveBeenCalledOnce();

    // A rename reaching outside the workspace is refused before applying (U15-03).
    const outside = {
      entries: () => [[vscode.Uri.file(path.join(os.tmpdir(), 'elsewhere.ts')), []]],
    };
    executeCommand.mockImplementation(async () => outside);
    apply.mockClear();
    await expect(
      makeRenameSymbolTool().handler(
        { path: 'sample.ts', line: 0, character: 7, new_name: 'renamed' },
        { beforeMutate },
      ),
    ).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });

  it('executes memory create, recall, and list semantics with fake workspace state', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => void values.set(key, value),
    } as unknown as vscode.Memento;
    attachMemoryStore(state, await MemoryStore.migrate(path.join(root, '.forge-memory'), state));
    await makeRememberTool(state).handler({
      key: 'decision',
      value: 'keep local',
      description: 'Keep the local copy.',
    });
    await expect(makeRecallTool(state).handler({ key: 'decision' })).resolves.toBe('keep local');
    await expect(makeListMemoriesTool(state).handler({})).resolves.toBe(
      '- decision: Keep the local copy.',
    );
  });
});
