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

import { ForgeInstructionsLoader } from '../../src/llm/ForgeInstructionsLoader';
import {
  MAX_INSTRUCTION_BYTES,
  clampUtf8,
  collectChainDirectories,
  renderInstructionChain,
} from '../../src/llm/forgeInstructionsChain';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chain-')));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('collectChainDirectories', () => {
  it('walks root to leaf, inclusive', () => {
    const root = path.resolve('/ws');
    expect(collectChainDirectories(root, path.join(root, 'a', 'b'))).toEqual([
      root,
      path.join(root, 'a'),
      path.join(root, 'a', 'b'),
    ]);
  });

  it('returns only the root for a target outside it, or no target at all', () => {
    const root = path.resolve('/ws');
    expect(collectChainDirectories(root)).toEqual([root]);
    expect(collectChainDirectories(root, path.resolve('/elsewhere/x'))).toEqual([root]);
  });
});

describe('clampUtf8', () => {
  it('never splits a multibyte sequence', () => {
    const value = '€'.repeat(10); // 3 bytes each
    const clamped = clampUtf8(value, 8);
    expect(clamped.truncated).toBe(true);
    expect(Buffer.byteLength(clamped.text, 'utf8')).toBe(6);
    expect(clamped.text).toBe('€€');
  });
});

describe('renderInstructionChain budget', () => {
  const file = (name: string, scope: string, content: string) => ({
    path: `/ws/${name}`,
    displayPath: name,
    scope,
    content,
  });

  it('keeps a single file byte-for-byte, with no delimiter cost', () => {
    const rendered = renderInstructionChain([file('FORGE.md', '', 'root rules')]);
    expect(rendered?.text).toBe('root rules');
  });

  it('allocates root-first, truncating the leaf rather than dropping the root', () => {
    const rendered = renderInstructionChain(
      [
        file('FORGE.md', '', 'R'.repeat(14000)),
        file('packages/api/FORGE.md', 'packages/api', 'L'.repeat(4000)),
      ],
      MAX_INSTRUCTION_BYTES,
    );
    expect(rendered?.text).toContain('R'.repeat(14000));
    expect(rendered?.truncated).toEqual(['packages/api/FORGE.md']);
    expect(Buffer.byteLength(rendered?.text ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_INSTRUCTION_BYTES,
    );
  });

  it('marks a leaf omitted, rather than silently dropping it, when nothing fits', () => {
    const rendered = renderInstructionChain(
      [
        file('FORGE.md', '', 'R'.repeat(14900)),
        file('packages/api/FORGE.md', 'packages/api', 'L'.repeat(4000)),
      ],
      MAX_INSTRUCTION_BYTES,
    );
    expect(rendered?.omitted).toEqual(['packages/api/FORGE.md']);
    expect(rendered?.text).toContain('Omitted, project-instruction budget exhausted');
    expect(Buffer.byteLength(rendered?.text ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_INSTRUCTION_BYTES,
    );
  });

  it('states precedence between the documents without claiming authority over anything else', () => {
    const rendered = renderInstructionChain([
      file('FORGE.md', '', 'root'),
      file('api/FORGE.md', 'api', 'leaf'),
    ]);
    expect(rendered?.text).toContain('outermost first');
    expect(rendered?.text).toContain('does not override the system prompt');
    expect(rendered?.text.indexOf('root')).toBeLessThan(rendered?.text.indexOf('leaf') ?? -1);
  });

  it('returns undefined when the chain holds nothing', () => {
    expect(renderInstructionChain([])).toBeUndefined();
  });
});

describe('ForgeInstructionsLoader chain assembly', () => {
  it('appends the nearest instructions to the repository root ones', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'repository rules');
    write(root, 'packages/api/FORGE.md', 'api rules');
    const loader = new ForgeInstructionsLoader(root);

    const out = loader.instructionsFor('packages/api/server.ts') ?? '';
    expect(out).toContain('repository rules');
    expect(out).toContain('api rules');
    expect(out).toContain('packages/api/FORGE.md — applies to packages/api/');
    // A target elsewhere in the tree must not pick up the api rules.
    expect(loader.instructionsFor('packages/web/app.ts')).toBe('repository rules');
    loader.dispose();
  });

  it('prefers FORGE.md over AGENTS.md at each level independently', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'AGENTS.md', 'root agents');
    write(root, 'pkg/FORGE.md', 'pkg forge');
    write(root, 'pkg/AGENTS.md', 'pkg agents');
    const loader = new ForgeInstructionsLoader(root);

    const out = loader.instructionsFor('pkg/a.ts') ?? '';
    expect(out).toContain('root agents');
    expect(out).toContain('pkg forge');
    expect(out).not.toContain('pkg agents');
    loader.dispose();
  });

  it('skips levels without an instruction file', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'root');
    write(root, 'a/b/c/FORGE.md', 'deep');
    const loader = new ForgeInstructionsLoader(root);

    const out = loader.instructionsFor('a/b/c/x.ts') ?? '';
    expect(out).toContain('root');
    expect(out).toContain('deep');
    expect(out.match(/=====/gu)?.length).toBe(4); // two headers, opening and closing
    loader.dispose();
  });

  it('starts a nested repository’s chain at that repository, not the outer one', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'outer rules');
    fs.mkdirSync(path.join(root, 'vendor', 'lib', '.git'), { recursive: true });
    write(root, 'vendor/lib/FORGE.md', 'vendored rules');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructionsFor('vendor/lib/src/a.ts')).toBe('vendored rules');
    loader.dispose();
  });

  it('resolves a file that does not exist yet to its directory', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'root');
    write(root, 'pkg/FORGE.md', 'pkg');
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructionsFor('pkg/not-created-yet.ts') ?? '').toContain('pkg');
    loader.dispose();
  });

  it('falls back to the workspace root for a target outside the workspace', () => {
    const root = makeRoot();
    write(root, 'FORGE.md', 'root');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructionsFor(path.join(os.tmpdir(), 'elsewhere', 'a.ts'))).toBe('root');
    loader.dispose();
  });

  it('refuses instructions reached through a link out of the workspace, and says so', () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'root');
    write(outside, 'FORGE.md', 'rules from outside the workspace');
    // A link inside the workspace must not become a way to read instructions
    // from outside it — silently, and at the head of every prompt.
    fs.symlinkSync(outside, path.join(root, 'pkg'), 'junction');
    const loader = new ForgeInstructionsLoader(root);

    const out = loader.instructionsFor('pkg/a.ts') ?? '';
    expect(out).toContain('[unreadable: resolves outside the workspace]');
    expect(out).not.toContain('rules from outside the workspace');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Forge: pkg/FORGE.md exists but could not be read.',
    );
    loader.dispose();
  });

  it('does not reuse a chain across different targets', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'FORGE.md', 'root');
    write(root, 'a/FORGE.md', 'a rules');
    write(root, 'b/FORGE.md', 'b rules');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructionsFor('a/x.ts') ?? '').toContain('a rules');
    expect(loader.instructionsFor('b/x.ts') ?? '').toContain('b rules');
    expect(loader.instructionsFor('b/x.ts') ?? '').not.toContain('a rules');
    loader.dispose();
  });

  it('does not let one chain’s truncation shorten another chain', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.git'));
    // Big root file: in the deep chain it is truncated to make room for a
    // header; on its own it must still arrive at its full length.
    write(root, 'FORGE.md', 'R'.repeat(14990));
    write(root, 'pkg/FORGE.md', 'P'.repeat(600));
    const loader = new ForgeInstructionsLoader(root);

    const deep = loader.instructionsFor('pkg/a.ts') ?? '';
    expect(deep).toContain('Omitted, project-instruction budget exhausted');
    const shallow = loader.instructionsFor('a.ts') ?? '';
    expect(shallow).toBe('R'.repeat(14990));
    loader.dispose();
  });
});
