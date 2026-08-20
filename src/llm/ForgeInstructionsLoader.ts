import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const AGENTS_MD = 'AGENTS.md';
const FORGE_MD = 'FORGE.md';
const INSTRUCTION_FILES = [FORGE_MD, AGENTS_MD] as const;
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
 * FORGE.md is authoritative for Forge-native agents. AGENTS.md remains a
 * compatibility fallback for repositories that have not adopted it yet.
 */
export function resolveProjectInstructionsPath(workspaceRoot: string): string {
  for (const fileName of INSTRUCTION_FILES) {
    const candidate = path.join(workspaceRoot, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return preferredProjectInstructionsPath(workspaceRoot);
}

export function preferredProjectInstructionsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, FORGE_MD);
}

/**
 * Creates the deliberately small starter only when a workspace has no project
 * instructions. It never replaces user-authored content.
 */
export function ensureForgeInstructionsFile(
  repositoryRoot: string,
): ForgeInstructionsBootstrapResult {
  const filePath = preferredProjectInstructionsPath(repositoryRoot);
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
  private readonly contentByPath = new Map<string, string | undefined>();
  private watcher: vscode.Disposable | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly truncationWarnings = new Set<string>();

  constructor(private readonly workspaceRoot: string) {
    this.watch();
  }

  get instructions(): string | undefined {
    return this.instructionsFor();
  }
  get root(): string {
    return this.workspaceRoot;
  }

  /** Instructions for the repository containing `target`, or the workspace
   * root when no target/repository can be identified. */
  instructionsFor(target?: string): string | undefined {
    const scopeRoot = resolveInstructionScopeRoot(this.workspaceRoot, target);
    const filePath = resolveProjectInstructionsPath(scopeRoot);
    if (this.contentByPath.has(filePath)) return this.contentByPath.get(filePath);
    try {
      if (!fs.existsSync(filePath)) {
        this.contentByPath.set(filePath, undefined);
        return undefined;
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      const bytes = Buffer.from(raw, 'utf8');
      if (bytes.length > MAX_BYTES) {
        let end = MAX_BYTES;
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
        const truncated = bytes.subarray(0, end).toString('utf8');
        this.contentByPath.set(filePath, truncated);
        if (!this.truncationWarnings.has(filePath)) {
          this.truncationWarnings.add(filePath);
          void vscode.window.showWarningMessage(
            `Forge: ${filePath} exceeds ${MAX_BYTES} bytes and was truncated before prompt injection.`,
          );
        }
        return truncated;
      }

      this.truncationWarnings.delete(filePath);
      this.contentByPath.set(filePath, raw);
      return raw;
    } catch {
      this.contentByPath.set(filePath, undefined);
      return undefined;
    }
  }

  private watch(): void {
    try {
      const pattern = new vscode.RelativePattern(
        this.workspaceRoot,
        `**/{${INSTRUCTION_FILES.join(',')}}`,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const scheduleLoad = (): void => {
        if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          this.contentByPath.clear();
          this.truncationWarnings.clear();
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

/** Nearest repository root for a target, bounded by the workspace root. */
export function resolveInstructionScopeRoot(workspaceRoot: string, target?: string): string {
  const boundary = path.resolve(workspaceRoot);
  if (!target) return boundary;
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(boundary, target);
  let current =
    fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()
      ? resolvedTarget
      : path.dirname(resolvedTarget);
  if (!containsPath(boundary, current)) return boundary;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (samePath(current, boundary)) return boundary;
    const parent = path.dirname(current);
    if (parent === current || !containsPath(boundary, parent)) return boundary;
    current = parent;
  }
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

/** Git repositories currently discovered inside the workspace. */
export async function discoverWorkspaceRepositoryRoots(workspaceRoot: string): Promise<string[]> {
  const roots = new Set<string>();
  if (fs.existsSync(path.join(workspaceRoot, '.git'))) roots.add(path.resolve(workspaceRoot));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git API is untyped
    const extension = vscode.extensions.getExtension<any>('vscode.git');
    const exports = extension
      ? extension.isActive
        ? extension.exports
        : await extension.activate()
      : undefined;
    const repositories = exports?.getAPI(1)?.repositories as
      | Array<{ rootUri?: vscode.Uri }>
      | undefined;
    for (const repository of repositories ?? []) {
      const root = repository.rootUri?.fsPath;
      if (root && containsPath(workspaceRoot, root)) roots.add(path.resolve(root));
    }
  } catch {
    // Git discovery is best-effort; a non-repository workspace still receives
    // its own FORGE.md when auto-create is enabled.
  }
  return roots.size ? [...roots] : [path.resolve(workspaceRoot)];
}

export function createForgeInstructionsLoader(): ForgeInstructionsLoader | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  return new ForgeInstructionsLoader(root);
}
