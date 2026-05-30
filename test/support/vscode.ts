export const workspace = {
  workspaceFolders: [],
  createFileSystemWatcher: () => ({
    onDidChange: () => undefined,
    onDidCreate: () => undefined,
    onDidDelete: () => undefined,
    dispose: () => undefined,
  }),
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
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
};
