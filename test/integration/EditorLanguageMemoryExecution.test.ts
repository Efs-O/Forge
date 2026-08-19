import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFindFilesTool } from '../../src/tools/dirTools';
import { makeFormatFileTool, makeRenameSymbolTool } from '../../src/tools/fileEditTools';
import {
  makeFindReferencesTool,
  makeGetDiagnosticsTool,
  makeGetDocumentSymbolsTool,
  makeGetHoverTool,
  makeGetWorkspaceSymbolsTool,
  makeGoToDefinitionTool,
} from '../../src/tools/lspTools';
import {
  makeListMemoriesTool,
  makeRecallTool,
  makeRememberTool,
} from '../../src/tools/memoryTools';
import { makeSearchCodebaseTool } from '../../src/tools/semanticSearchTool';
import {
  makeAskUserTool,
  makeCopyToClipboardTool,
  makeOpenUrlTool,
  makeReadClipboardTool,
  makeShowDiffTool,
  makeShowNotificationTool,
} from '../../src/tools/uxTools';
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
    await expect(makeGetDiagnosticsTool().handler({ path: 'sample.ts' })).resolves.toBe(
      'sample.ts:1: warning: fixture warning',
    );

    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(
      async (command: string): Promise<unknown> => {
        if (command === 'vscode.executeDocumentSymbolProvider') {
          return [
            {
              name: 'sample',
              kind: vscode.SymbolKind.Variable,
              range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)),
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

    await expect(makeGetDocumentSymbolsTool().handler({ path: 'sample.ts' })).resolves.toContain(
      'Variable sample (line 1)',
    );
    await expect(makeGetWorkspaceSymbolsTool().handler({ query: 'sample' })).resolves.toContain(
      'Variable sample — sample.ts:1',
    );
    await expect(
      makeGetHoverTool().handler({ path: 'sample.ts', line: 0, character: 1 }),
    ).resolves.toBe('const sample: 1');
    await expect(
      makeGoToDefinitionTool().handler({ path: 'sample.ts', line: 0, character: 1 }),
    ).resolves.toBe('sample.ts:1:1');
    await expect(
      makeFindReferencesTool().handler({ path: 'sample.ts', line: 0, character: 1 }),
    ).resolves.toBe('sample.ts:1:1');
  });

  it('executes controlled diff, prompt, notification, clipboard, and URL handlers', async () => {
    const command = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('fixture answer');
    const notification = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    await expect(
      makeShowDiffTool().handler({ original_path: 'sample.ts', modified_path: 'sample.ts' }),
    ).resolves.toBe('Diff opened.');
    expect(command).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      'Forge Diff',
    );
    await expect(makeAskUserTool().handler({ prompt: 'Question?' })).resolves.toBe(
      'fixture answer',
    );
    await makeShowNotificationTool().handler({ message: 'notice', level: 'warning' });
    expect(notification).toHaveBeenCalledWith('notice');
    await makeCopyToClipboardTool().handler({ text: 'clipboard fixture' });
    await expect(makeReadClipboardTool().handler({})).resolves.toBe('clipboard fixture');
    await makeOpenUrlTool().handler({ url: 'https://example.com/' });
    expect(open).toHaveBeenCalledOnce();
    await expect(makeOpenUrlTool().handler({ url: 'file:///secret' })).rejects.toThrow(
      'must start with',
    );
  });

  it('executes format and rename through disposable VS Code adapters', async () => {
    const save = vi.fn().mockResolvedValue(true);
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
      uri: vscode.Uri.file(path.join(root, 'sample.ts')),
      save,
    } as never);
    const workspaceEdit = {
      entries: () => [[vscode.Uri.file(path.join(root, 'sample.ts')), []]],
    };
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command: string) =>
      command === 'vscode.executeDocumentRenameProvider' ? workspaceEdit : undefined,
    );
    const apply = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);

    await expect(makeFormatFileTool().handler({ path: 'sample.ts' })).resolves.toBe(
      'Formatted: sample.ts',
    );
    expect(save).toHaveBeenCalledOnce();
    const beforeMutate = vi.fn();
    await expect(
      makeRenameSymbolTool().handler(
        { path: 'sample.ts', line: 0, character: 1, new_name: 'renamed' },
        { beforeMutate },
      ),
    ).resolves.toBe('Renamed to renamed');
    expect(beforeMutate).toHaveBeenCalledWith([path.join(root, 'sample.ts')]);
    expect(apply).toHaveBeenCalledWith(workspaceEdit);
  });

  it('executes memory create, recall, and list semantics with fake workspace state', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => void values.set(key, value),
    } as unknown as vscode.Memento;
    await makeRememberTool(state).handler({ key: 'decision', value: 'keep local' });
    await expect(makeRecallTool(state).handler({ key: 'decision' })).resolves.toBe('keep local');
    await expect(makeListMemoriesTool(state).handler({})).resolves.toBe('decision');
  });
});
