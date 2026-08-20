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

import { ensureForgeInstructionsFile } from '../../src/llm/ForgeInstructionsLoader';

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
  it('creates a small starter in a workspace without FORGE.md', () => {
    const root = makeRoot();

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    const content = fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8');
    expect(content).toContain('# Forge Project Notes');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(8192);
  });

  it('never overwrites existing project instructions', () => {
    const root = makeRoot();
    const target = path.join(root, 'FORGE.md');
    fs.writeFileSync(target, '# Existing instructions\n', 'utf8');

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('# Existing instructions\n');
  });
});
