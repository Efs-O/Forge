import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const FORGE_MD = 'FORGE.md';
const MAX_BYTES = 8192; // guard against accidentally huge files eating context

export class ForgeInstructionsLoader implements vscode.Disposable {
  private content: string | undefined;
  private watcher: fs.FSWatcher | undefined;
  private readonly filePath: string;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, FORGE_MD);
    this.load();
    this.watch();
  }

  get instructions(): string | undefined { return this.content; }
  get root(): string { return this.workspaceRoot; }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.content = undefined;
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.content = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    } catch {
      this.content = undefined;
    }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(path.dirname(this.filePath), (_, filename) => {
        if (filename === FORGE_MD) this.load();
      });
    } catch {
      // non-fatal — no watch on unsupported FS
    }
  }

  dispose(): void {
    try { this.watcher?.close(); } catch { /* already closed */ }
  }
}

export function createForgeInstructionsLoader(): ForgeInstructionsLoader | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  return new ForgeInstructionsLoader(root);
}
