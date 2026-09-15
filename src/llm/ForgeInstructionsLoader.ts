import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_MD,
  INSTRUCTION_FILES,
  MAX_INSTRUCTION_BYTES,
  collectChainDirectories,
  renderInstructionChain,
  type ChainFile,
} from './forgeInstructionsChain';

const RELOAD_DEBOUNCE_MS = 150;
const STARTER_CONTENT = `# Project Instructions

Keep this file concise (under 25,000 bytes). Forge includes it in every native local-agent prompt.

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
  /**
   * Full file contents, keyed by absolute path.
   *
   * Deliberately never holds a truncated version: the same file can appear in
   * chains with different remaining allocations, so a copy cut to fit one chain
   * would silently shorten every other chain that reuses it. Truncation is
   * applied at render time, against that chain's budget.
   */
  private readonly contentByPath = new Map<string, LoadedInstructionFile>();
  /** Rendered chains, keyed by chain root and target directory together. */
  private readonly chainByKey = new Map<string, string | undefined>();
  private watcher: vscode.Disposable | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly budgetWarnings = new Set<string>();

  constructor(private readonly workspaceRoot: string) {
    this.watch();
  }

  get instructions(): string | undefined {
    return this.instructionsFor();
  }
  get root(): string {
    return this.workspaceRoot;
  }

  /**
   * Instructions for `target`, assembled from the repository root down to the
   * directory containing it.
   *
   * Each level contributes at most one file, `FORGE.md` preferred over
   * `AGENTS.md`, and levels without one are simply skipped. A target outside
   * the workspace, or none at all, yields the workspace root's own file — the
   * behaviour this method has always had.
   */
  instructionsFor(target?: string): string | undefined {
    const chainRoot = resolveInstructionScopeRoot(this.workspaceRoot, target);
    const targetDirectory = resolveTargetDirectory(this.workspaceRoot, target);
    const key = `${chainRoot}\u0000${targetDirectory ?? ''}`;
    if (this.chainByKey.has(key)) return this.chainByKey.get(key);

    const files: ChainFile[] = [];
    for (const directory of collectChainDirectories(chainRoot, targetDirectory)) {
      const file = this.loadNearestInstructionFile(directory, chainRoot);
      if (file) files.push(file);
    }

    const rendered = renderInstructionChain(files, MAX_INSTRUCTION_BYTES);
    const text = rendered?.text;
    this.chainByKey.set(key, text);
    if (rendered) this.reportBudget(rendered.truncated, rendered.omitted, rendered.unreadable);
    return text;
  }

  /** The one instruction file governing `directory`, if it has one. */
  private loadNearestInstructionFile(directory: string, chainRoot: string): ChainFile | undefined {
    for (const fileName of INSTRUCTION_FILES) {
      const filePath = path.join(directory, fileName);
      const loaded = this.readInstructionFile(filePath);
      if (loaded.state === 'absent') continue;
      return {
        path: filePath,
        displayPath: displayPathFor(this.workspaceRoot, filePath),
        scope: path.relative(chainRoot, directory).split(path.sep).join('/'),
        ...(loaded.state === 'loaded'
          ? { content: loaded.content ?? '' }
          : { readError: loaded.error ?? 'unknown error' }),
      };
    }
    return undefined;
  }

  private readInstructionFile(filePath: string): LoadedInstructionFile {
    const cached = this.contentByPath.get(filePath);
    if (cached) return cached;
    const loaded = readInstructionFileFromDisk(filePath, this.workspaceRoot);
    this.contentByPath.set(filePath, loaded);
    return loaded;
  }

  /**
   * Surface budget pressure once per file until its content changes.
   *
   * Silence here would be the worst outcome: instructions the user wrote would
   * simply not reach the model, and nothing in the chat would say so.
   */
  private reportBudget(truncated: string[], omitted: string[], unreadable: string[]): void {
    const notify = (paths: string[], message: (p: string) => string): void => {
      for (const displayPath of paths) {
        if (this.budgetWarnings.has(displayPath)) continue;
        this.budgetWarnings.add(displayPath);
        void vscode.window.showWarningMessage(message(displayPath));
      }
    };
    notify(
      truncated,
      (p) =>
        `Forge: ${p} was truncated to fit the ${MAX_INSTRUCTION_BYTES}-byte project-instruction budget.`,
    );
    notify(
      omitted,
      (p) => `Forge: ${p} was omitted; the project-instruction budget was already exhausted.`,
    );
    notify(unreadable, (p) => `Forge: ${p} exists but could not be read.`);
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
          // Both caches, plus the warning suppression: a changed .git
          // boundary or a new nested FORGE.md changes which chain a target
          // resolves to, not only the content of one file.
          this.contentByPath.clear();
          this.chainByKey.clear();
          this.budgetWarnings.clear();
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

interface LoadedInstructionFile {
  state: 'loaded' | 'absent' | 'error';
  content?: string;
  error?: string;
}

/**
 * Read one instruction file, telling absence apart from failure.
 *
 * A missing file is the ordinary case and says nothing. A file that exists but
 * cannot be read is a fact the user needs, because the rules they wrote are
 * silently not reaching the model.
 */
function readInstructionFileFromDisk(
  filePath: string,
  workspaceRoot: string,
): LoadedInstructionFile {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return { state: 'absent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'error', error: code ?? String(error) };
  }

  // A symlink inside the workspace must not be a way to read instructions from
  // outside it. Resolve first, then check containment on the resolved path.
  try {
    const real = fs.realpathSync(filePath);
    if (!containsPath(fs.realpathSync(workspaceRoot), real)) {
      return { state: 'error', error: 'resolves outside the workspace' };
    }
  } catch {
    // A path we cannot resolve is handled by the read below.
  }

  try {
    return { state: 'loaded', content: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'error', error: code ?? String(error) };
  }
}

/** Directory a target names, or undefined when there is no usable target. */
function resolveTargetDirectory(workspaceRoot: string, target?: string): string | undefined {
  if (!target) return undefined;
  const boundary = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(boundary, target);
  let directory: string;
  try {
    directory = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    // A file that does not exist yet still names the directory it belongs to.
    directory = path.dirname(resolved);
  }
  return containsPath(boundary, directory) ? directory : undefined;
}

function displayPathFor(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : filePath;
}
