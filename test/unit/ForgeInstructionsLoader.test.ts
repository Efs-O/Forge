import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    createFileSystemWatcher: vi.fn(),
    RelativePattern: vi.fn(),
  },
  window: { showWarningMessage: vi.fn() },
}));

import {
  ensureForgeInstructionsFile,
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
});

describe('ensureForgeInstructionsFile', () => {
  it('creates a small AGENTS.md starter in a workspace without project instructions', () => {
    const root = makeRoot();

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    const content = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(content).toContain('# Project Instructions');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(8192);
  });

  it('keeps an existing AGENTS.md and prefers it over the legacy FORGE.md', () => {
    const root = makeRoot();
    const target = path.join(root, 'AGENTS.md');
    fs.writeFileSync(target, '# Existing instructions\n', 'utf8');
    fs.writeFileSync(path.join(root, 'FORGE.md'), '# Legacy instructions\n', 'utf8');

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('# Existing instructions\n');
    expect(resolveProjectInstructionsPath(root)).toBe(target);
  });

  it('keeps loading a legacy FORGE.md when AGENTS.md is absent', () => {
    const root = makeRoot();
    const target = path.join(root, 'FORGE.md');
    fs.writeFileSync(target, '# Existing instructions\n', 'utf8');

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('exists');
    expect(result.path).toBe(target);
  });
});
