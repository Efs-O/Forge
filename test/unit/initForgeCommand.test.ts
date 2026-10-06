import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { runInitForgeCommand } from '../../src/sidebar/initForgeCommand';
import type { SlashCommandDeps } from '../../src/sidebar/SlashCommandHandler';

const workspace = vi.hoisted(() => ({ folders: undefined as { uri: { fsPath: string } }[] | undefined }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return workspace.folders;
    },
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() })),
  },
}));

describe('/init', () => {
  let root: string;
  let submitPrompt: ReturnType<typeof vi.fn>;
  let deps: SlashCommandDeps;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-'));
    workspace.folders = [{ uri: { fsPath: root } }];
    submitPrompt = vi.fn(async () => undefined);
    deps = { submitPrompt } as unknown as SlashCommandDeps;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the starter and hands the agent a turn to fill it in', async () => {
    await runInitForgeCommand(deps);

    expect(fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8')).toContain('## Commands');
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    const prompt = submitPrompt.mock.calls[0][0] as string;
    expect(prompt).toContain('`FORGE.md`');
    expect(prompt).toMatch(/Run each command before you write it down/);
    expect(prompt).toMatch(/Never delete or rewrite text a person wrote/);
  });

  it('leaves an existing FORGE.md byte-for-byte and still starts the turn', async () => {
    const existing = '# Mine\n\nHand-written rules.\n';
    fs.writeFileSync(path.join(root, 'FORGE.md'), existing);

    await runInitForgeCommand(deps);

    expect(fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8')).toBe(existing);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('starts no turn without a workspace folder', async () => {
    workspace.folders = undefined;

    await runInitForgeCommand(deps);

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});
