import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    createFileSystemWatcher: vi.fn(),
    RelativePattern: vi.fn(),
  },
  extensions: { getExtension: vi.fn() },
  window: { showWarningMessage: vi.fn() },
}));

import {
  discoverWorkspaceRepositoryRoots,
  ensureForgeInstructionsFile,
  ForgeInstructionsLoader,
  resolveProjectInstructionsPath,
} from '../../src/llm/ForgeInstructionsLoader';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-instructions-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('ensureForgeInstructionsFile', () => {
  it('creates a small FORGE.md starter in a repository without one', () => {
    const root = makeRoot();

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    const content = fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8');
    expect(content).toContain('# Project Instructions');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(8192);
  });

  it('creates FORGE.md without overwriting an existing AGENTS.md fallback', () => {
    const root = makeRoot();
    const agents = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agents, '# Existing shared instructions\n', 'utf8');

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    expect(fs.readFileSync(agents, 'utf8')).toBe('# Existing shared instructions\n');
    expect(result.path).toBe(path.join(root, 'FORGE.md'));
  });

  it('prefers FORGE.md when both instruction conventions exist', () => {
    const root = makeRoot();
    const forge = path.join(root, 'FORGE.md');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Shared instructions\n', 'utf8');
    fs.writeFileSync(forge, '# Forge instructions\n', 'utf8');

    expect(resolveProjectInstructionsPath(root)).toBe(forge);
  });

  it('falls back to AGENTS.md when FORGE.md is absent', () => {
    const root = makeRoot();
    const agents = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agents, '# Shared instructions\n', 'utf8');

    expect(resolveProjectInstructionsPath(root)).toBe(agents);
  });
});

describe('ForgeInstructionsLoader', () => {
  it('loads the FORGE.md belonging to the target nested repository', () => {
    const root = makeRoot();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'src'));
    fs.writeFileSync(path.join(root, 'FORGE.md'), '# Workspace instructions\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'FORGE.md'), '# Nested instructions\n', 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructions).toBe('# Workspace instructions\n');
    expect(loader.instructionsFor(path.join(nested, 'src', 'a.ts'))).toBe(
      '# Nested instructions\n',
    );
    loader.dispose();
  });

  it('uses the repository AGENTS.md only as a local fallback', () => {
    const root = makeRoot();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'FORGE.md'), '# Workspace instructions\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), '# Nested fallback\n', 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructionsFor(path.join(nested, 'new.ts'))).toBe('# Nested fallback\n');
    loader.dispose();
  });
});

describe('discoverWorkspaceRepositoryRoots', () => {
  it('returns every Git repository discovered inside the workspace', async () => {
    const root = makeRoot();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ rootUri: { fsPath: first } }, { rootUri: { fsPath: second } }],
        }),
      },
    } as never);

    await expect(discoverWorkspaceRepositoryRoots(root)).resolves.toEqual([first, second]);
  });
});
