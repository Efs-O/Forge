import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const AGENTS_MD = 'AGENTS.md';
const LEGACY_FORGE_MD = 'FORGE.md';
const INSTRUCTION_FILES = [AGENTS_MD, LEGACY_FORGE_MD] as const;
const MAX_BYTES = 8192; // guard against accidentally huge files eating context
const RELOAD_DEBOUNCE_MS = 150;
const STARTER_CONTENT = `# Project Instructions

Keep this file concise (under 8 KB). Forge includes it in every native local-agent prompt.

## Project facts
- Purpose and important architecture decisions:

## Commands
- Build:
- Test:

## Working rules
- Add durable conventions and safety constraints here.
`;

export type ForgeInstructionsBootstrapResult =
  | { status: 'created'; path: string }
  | { status: 'exists'; path: string }
  | { status: 'error'; path: string; error: Error };

/**
 * AGENTS.md is the shared workspace convention. FORGE.md remains supported for
 * existing workspaces, but a new workspace receives AGENTS.md only when neither
 * instruction file exists.
 */
export function resolveProjectInstructionsPath(workspaceRoot: string): string {
  for (const fileName of INSTRUCTION_FILES) {
    const candidate = path.join(workspaceRoot, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(workspaceRoot, AGENTS_MD);
}

/**
 * Creates the deliberately small starter only when a workspace has no project
 * instructions. It never replaces user-authored content.
 */
export function ensureForgeInstructionsFile(
  workspaceRoot: string,
): ForgeInstructionsBootstrapResult {
  const filePath = resolveProjectInstructionsPath(workspaceRoot);
  try {
    if (fs.existsSync(filePath)) return { status: 'exists', path: filePath };
    fs.writeFileSync(filePath, STARTER_CONTENT, { encoding: 'utf8', flag: 'wx' });
    return { status: 'created', path: filePath };
  } catch (error) {
    // Another VS Code window can create the file between existsSync and write.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { status: 'exists', path: filePath };
    }
    return { status: 'error', path: filePath, error: error as Error };
  }
}

export class ForgeInstructionsLoader implements vscode.Disposable {
  private content: string | undefined;
  private watcher: vscode.Disposable | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private filePath: string;
  private truncationWarningShown = false;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = resolveProjectInstructionsPath(workspaceRoot);
    this.load();
    this.watch();
  }

  get instructions(): string | undefined {
    return this.content;
  }
  get root(): string {
    return this.workspaceRoot;
  }

  private load(): void {
    try {
      this.filePath = resolveProjectInstructionsPath(this.workspaceRoot);
      if (!fs.existsSync(this.filePath)) {
        this.content = undefined;
        this.truncationWarningShown = false;
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (raw.length > MAX_BYTES) {
        this.content = raw.slice(0, MAX_BYTES);
        if (!this.truncationWarningShown) {
          this.truncationWarningShown = true;
          void vscode.window.showWarningMessage(
            `Forge: ${path.basename(this.filePath)} exceeds ${MAX_BYTES} bytes and was truncated before prompt injection.`,
          );
        }
        return;
      }

      this.truncationWarningShown = false;
      this.content = raw;
    } catch {
      this.content = undefined;
    }
  }

  private watch(): void {
    try {
      const pattern = new vscode.RelativePattern(
        this.workspaceRoot,
        `{${INSTRUCTION_FILES.join(',')}}`,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const scheduleLoad = (): void => {
        if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          this.load();
        }, RELOAD_DEBOUNCE_MS);
      };

      watcher.onDidChange(scheduleLoad);
      watcher.onDidCreate(scheduleLoad);
      watcher.onDidDelete(scheduleLoad);
      this.watcher = watcher;
    } catch {
      // non-fatal: keep last loaded instructions if the host FS cannot be watched
    }
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.watcher?.dispose();
  }
}

export function createForgeInstructionsLoader(): ForgeInstructionsLoader | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  return new ForgeInstructionsLoader(root);
}
