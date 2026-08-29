import * as fs from 'fs/promises';
import * as path from 'path';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, fallback?: T): T | undefined => fallback,
  }),
  fs: {
    async readDirectory(uri: { fsPath: string }): Promise<Array<[string, FileType]>> {
      const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : FileType.File,
      ]);
    },
    async stat(uri: { fsPath: string }): Promise<{
      type: FileType;
      size: number;
      ctime: number;
      mtime: number;
    }> {
      const stats = await fs.stat(uri.fsPath);
      return {
        type: stats.isDirectory() ? FileType.Directory : FileType.File,
        size: stats.size,
        ctime: stats.birthtimeMs,
        mtime: stats.mtimeMs,
      };
    },
  },
  findFiles: async (): Promise<Array<{ fsPath: string }>> => [],
  asRelativePath: (uri: { fsPath: string }): string => {
    const root = workspace.workspaceFolders[0]?.uri.fsPath;
    return root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath;
  },
  openTextDocument: async (uri: { fsPath: string }) => ({
    uri,
    save: async () => true,
  }),
  applyEdit: async () => true,
  createFileSystemWatcher: () => ({
    onDidChange: () => undefined,
    onDidCreate: () => undefined,
    onDidDelete: () => undefined,
    dispose: () => undefined,
  }),
};

export const window = {
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as Array<{ document: { uri: { fsPath: string } } }>,
  createOutputChannel: () => ({
    appendLine: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async (): Promise<string | undefined> => undefined,
  showInputBox: async (): Promise<string | undefined> => undefined,
  showTextDocument: async (document: unknown) => document,
  createTerminal: () => ({ show: () => undefined, sendText: () => undefined }),
};

let clipboardText = '';
export const env = {
  appRoot: undefined as string | undefined,
  clipboard: {
    writeText: async (value: string): Promise<void> => {
      clipboardText = value;
    },
    readText: async (): Promise<string> => clipboardText,
  },
  openExternal: async (): Promise<boolean> => true,
};

export const languages = {
  getDiagnostics: (_uri?: unknown): unknown => [],
};

export const extensions = {
  getExtension: (_id: string): unknown => undefined,
};

export class Disposable {
  constructor(private readonly fn?: () => void) {}

  dispose(): void {
    this.fn?.();
  }

  static from(...values: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => {
      for (const value of values) value.dispose();
    });
  }
}

export class RelativePattern {
  constructor(
    public readonly base: string,
    public readonly pattern: string,
  ) {}
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
    fsPath: path.join(base.fsPath, ...segments),
  }),
  parse: (value: string) => ({ fsPath: value, toString: () => value }),
};

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
}

export const commands = {
  executeCommand: async (): Promise<unknown> => undefined,
};
