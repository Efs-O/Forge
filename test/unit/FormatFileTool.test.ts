import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { makeFormatFileTool, resolveFormattingOptions } from '../../src/tools/formatFileTool';

const win = vscode.window as unknown as { visibleTextEditors: unknown[] };
const ws = vscode.workspace as unknown as {
  openTextDocument: ReturnType<typeof vi.fn>;
  getConfiguration: ReturnType<typeof vi.fn>;
  applyEdit: ReturnType<typeof vi.fn>;
};
const cmds = vscode.commands as unknown as { executeCommand: ReturnType<typeof vi.fn> };

// The document most recently created by doc(); the applyEdit mock bumps its
// version by one, mirroring the real workspace.applyEdit committing a single
// transaction. A test that needs a different bump (a keystroke in flight)
// overrides the mock with its own implementation.
let activeDoc: { version: number } | undefined;
// The document's text, as the mocks see it: `applyEdit` commits the edits a test
// handed it, and the result's line count is read from this text the way the real
// tool reads it from the buffer.
let text = '';

function doc(opts: { version?: number; save?: () => Promise<boolean>; text?: string } = {}) {
  const d = {
    uri: { fsPath: '/ws/a.ts', toString: () => 'file:///ws/a.ts' },
    languageId: 'typescript',
    version: opts.version ?? 1,
    save: opts.save ?? (async () => true),
    getText: () => text,
  };
  text = opts.text ?? '';
  activeDoc = d;
  return d;
}

const format = (path = 'a.ts', context?: Parameters<ReturnType<typeof makeFormatFileTool>['handler']>[1]) =>
  makeFormatFileTool().handler({ path }, context) as Promise<string>;

describe('format_file', () => {
  let root: string;
  beforeEach(() => {
    // A real directory: format_file now resolves its target with
    // resolveRealWorkspacePath, which real-paths the workspace root, so the
    // old fake '/ws' (absent on disk) would fail the containment check.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-format-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    vi.clearAllMocks();
    win.visibleTextEditors = [];
    ws.applyEdit.mockImplementation(async () => {
      text = 'x\n';
      if (activeDoc) activeDoc.version += 1;
      return true;
    });
    ws.getConfiguration.mockReturnValue({ get: () => undefined });
  });
  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('formats through the provider without opening, showing or closing an editor', async () => {
    const save = vi.fn(async () => true);
    const d = doc({ save });
    ws.openTextDocument.mockResolvedValue(d);
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);

    const out = await format();
    // The two facts the old result skipped: which formatter ran, and how much it
    // changed. A model that cannot see either cannot notice a 165-line rewrite.
    expect(out).toContain("Formatted with the editor's formatter for typescript");
    expect(out).toContain('a.ts');
    expect(out).toContain('1 line(s) changed');

    const commandNames = cmds.executeCommand.mock.calls.map((c) => c[0]);
    expect(commandNames).toEqual(['vscode.executeFormatDocumentProvider']);
    expect(commandNames).not.toContain('workbench.action.closeActiveEditor');
    expect(commandNames).not.toContain('editor.action.formatDocument');
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(ws.applyEdit).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
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

  it('refuses to save when the document changes while the edit is applied', async () => {
    const save = vi.fn(async () => true);
    const d = doc({ version: 1 });
    d.save = save;
    ws.openTextDocument.mockResolvedValue(d);
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);
    // applyEdit's own transaction bumps the version by one; a user keystroke
    // that lands while the async apply is in flight bumps it again, so after
    // apply the version is two ahead of the one the formatter computed against.
    ws.applyEdit.mockImplementation(async () => {
      d.version += 2;
      return true;
    });
    await expect(format()).rejects.toThrow(/changed while the edit was applied/);
    expect(save).not.toHaveBeenCalled();
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

describe("format_file prefers the formatter the project chose", () => {
  let root: string;
  // Flipped by a test once the child formatter has proved it started: the user
  // typing in the editor is the case the guards after the subprocess must catch.
  let dirtyDuringRun = false;
  const target = (): string => path.join(root, 'a.ts');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-format-project-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    vi.clearAllMocks();
    dirtyDuringRun = false;
    win.visibleTextEditors = [];
    ws.getConfiguration.mockReturnValue({ get: () => undefined });
    fs.writeFileSync(target(), 'one\ntwo\n', 'utf8');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'proj', devDependencies: { prettier: '^3.0.0' } }),
      'utf8',
    );
  });
  afterEach(async () => {
    vscode.workspace.workspaceFolders.splice(0);
    // A formatter killed by Stop can hold the folder it ran in for a moment after
    // it exits, and Windows refuses to remove a directory a process still uses —
    // EPERM, which `maxRetries` does not retry. Wait until it can go, then go.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  /** A prettier that does something observable, so a test can prove which formatter ran. */
  const installFormatter = (body: string): void => {
    const bin = path.join(root, 'node_modules', 'prettier', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'prettier.cjs'), body, 'utf8');
  };
  const docForDisk = (): unknown => doc({ text: fs.readFileSync(target(), 'utf8') });
  /** A doc whose dirty flag a test can raise while the child formatter runs. */
  const docWatchingForEdits = (): unknown => {
    const d = docForDisk() as { isDirty?: boolean };
    Object.defineProperty(d, 'isDirty', {
      get: () => dirtyDuringRun,
      configurable: true,
    });
    return d;
  };
  const providerAnswers = (): void => {
    ws.applyEdit.mockImplementation(async () => {
      text = 'x\n';
      if (activeDoc) activeDoc.version += 1;
      return true;
    });
    cmds.executeCommand.mockResolvedValue([{ newText: 'x' }]);
  };

  it("runs the project's own Prettier, and names it and the change", async () => {
    installFormatter(
      'const fs=require("fs");const p=process.argv[3];' +
        'fs.writeFileSync(p, fs.readFileSync(p,"utf8").toUpperCase());',
    );
    ws.openTextDocument.mockResolvedValue(docForDisk());

    const out = await format('a.ts');

    expect(out).toContain("Formatted with the project's own Prettier: a.ts");
    expect(out).toContain('4 line(s) changed');
    expect(fs.readFileSync(target(), 'utf8')).toBe('ONE\nTWO\n');
    // The editor's formatter must not also have run: two formatters on one file
    // is how a project's own `--check` stops passing.
    expect(cmds.executeCommand).not.toHaveBeenCalled();
  });

  it("falls back to the editor's formatter naming both, when the project's fails", async () => {
    installFormatter('console.error("no parser for this file");process.exit(2);');
    ws.openTextDocument.mockResolvedValue(docForDisk());
    providerAnswers();

    const out = await format('a.ts');

    expect(out).toContain("the project's own Prettier failed (no parser for this file)");
    expect(out).toContain("Formatted with the editor's formatter for typescript");
    expect(cmds.executeCommand).toHaveBeenCalledOnce();
  });

  it('says so when the project declares prettier but never installed it', async () => {
    ws.openTextDocument.mockResolvedValue(docForDisk());
    providerAnswers();

    const out = await format('a.ts');

    expect(out).toContain('could not find its CLI in node_modules');
    expect(cmds.executeCommand).toHaveBeenCalledOnce();
  });

  it('uses the editor formatter without a note when the project declares nothing', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'proj' }), 'utf8');
    ws.openTextDocument.mockResolvedValue(docForDisk());
    providerAnswers();

    const out = await format('a.ts');

    expect(out).toContain("Formatted with the editor's formatter for typescript");
    expect(out).not.toContain('prettier');
  });

  it('says when the formatter ran and the file was already formatted', async () => {
    installFormatter('const fs=require("fs");void fs.readFileSync(process.argv[3],"utf8");');
    ws.openTextDocument.mockResolvedValue(docForDisk());

    const out = await format('a.ts');

    expect(out).toContain("No changes: the project's own Prettier left a.ts as it is");
  });

  it('says so when only bytes changed, which a line diff cannot see', async () => {
    // A formatter that adds the missing trailing newline changes no whole line:
    // the line diff reports nothing, and the old result claimed "No changes".
    fs.writeFileSync(target(), 'one\ntwo', 'utf8');
    installFormatter(
      'const fs=require("fs");const p=process.argv[3];const t=fs.readFileSync(p,"utf8");' +
        'fs.writeFileSync(p, t.endsWith("\\n") ? t : t + "\\n");',
    );
    ws.openTextDocument.mockResolvedValue(docForDisk());

    const out = await format('a.ts');

    expect(out).toContain('no whole line changed, but the text did (7 → 8 characters');
  });

  it('refuses a formatter killed by Stop, and says the file may be part-written', async () => {
    installFormatter('setTimeout(() => process.exit(0), 5000);');
    ws.openTextDocument.mockResolvedValue(docForDisk());
    const controller = new AbortController();
    const running = format('a.ts', { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toThrow(/cancelled while the formatter ran/u);
    expect(cmds.executeCommand).not.toHaveBeenCalled();
  });

  it("refuses to fall back to the editor's formatter once the buffer has unsaved edits", async () => {
    // The child signals it started by writing a side file, so the test raises the
    // dirty flag at a point that is certainly inside the formatter's run.
    installFormatter(
      'require("fs").writeFileSync(process.argv[3] + ".started", "");' +
        'setTimeout(() => { console.error("boom"); process.exit(2); }, 300);',
    );
    ws.openTextDocument.mockResolvedValue(docWatchingForEdits());

    const running = format('a.ts');
    await vi.waitFor(() => expect(fs.existsSync(`${target()}.started`)).toBe(true));
    dirtyDuringRun = true;

    await expect(running).rejects.toThrow(/gained unsaved editor changes while the formatter ran/u);
    expect(cmds.executeCommand).not.toHaveBeenCalled();
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
