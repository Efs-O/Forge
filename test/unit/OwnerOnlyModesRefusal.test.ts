import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { applyOwnerOnlyWriteGuard, ownerOnlySetFor } from '../../src/tools/ownerPaths';
import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeShellTool } from '../../src/tools/shellTool';
import { TEST_BASH } from '../support/bash';
import type { RegisteredTool } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';

/**
 * The mode table from Lane A of `docs/plans/OWNER_GUARDS_PLAN.md` item 4: an
 * owner-only target is refused in normal, unattended and `/clanker` mode, with no
 * card and no auto-pass — because the unattended run that could edit
 * its own guards would otherwise approve the edit itself, and `ConfigLoader.ts`
 * watches the file, so the new rules would be live ~150 ms later.
 *
 * Each mode gets the same two calls: the owner-only write, and an ordinary write
 * to the same folder. The ordinary one is the control — it shows the card
 * machinery is live in that mode, so the owner refusal is a refusal and not a
 * side effect of nothing being wired. One scripted turn per mode, in the order
 * `ToolDispatch.ts` uses the parts: `invalidArgs` (which now carries
 * `refuseBeforeApproval`), the tool's own approval hook, the decision, the handler.
 */
const pwshConfig = { permissions: { exec: { shell: 'pwsh' } } } as unknown as ForgeConfig;

let workspace: string;
let home: string;
const context = { beforeMutate: () => undefined } as never;

function ownerOnlyTargets() {
  return ownerOnlySetFor({
    configPath: path.join(workspace, '.forge', 'config.yaml'),
    workspaceRoot: workspace,
    home,
    platform: 'win32',
  });
}

function harness(mode: 'attended' | 'unattended' | 'clanker', conversationId: string) {
  const posted: HostToWebview[] = [];
  const service = new ToolApprovalService(
    (message) => posted.push(message),
    () => ({}) as never,
    undefined,
    () => undefined,
  );
  if (mode === 'clanker') service.setClankerMode(conversationId, true);
  const registry = new ToolRegistry();
  const targets = ownerOnlyTargets();
  const wrapped = (tool: RegisteredTool) => applyOwnerOnlyWriteGuard(tool, () => targets);
  registry.register(wrapped(makeWriteFileTool(() => [home])));
  registry.register(
    makeShellTool({
      getConfig: () => pwshConfig,
      home,
      platform: 'win32',
      ownerOnly: () => targets.roots,
    }),
  );
  const cards = () =>
    posted.filter((message) => message.type === 'confirmRequest') as Extract<
      HostToWebview,
      { type: 'confirmRequest' }
    >[];
  const log: string[] = [];
  const marker = mode === 'unattended' ? unattendedConversations.mark(conversationId) : undefined;

  /** `ToolDispatch.ts`'s own order, including the permission rule that decides
   *  whether an ordinary write or shell call needs a card. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = registry.get(name)!;
    const invalid = registry.invalidArgs(tool, args);
    if (invalid) {
      log.push(`${name}: refused before any card — ${invalid}`);
      return;
    }
    const metadata = await tool.approval?.(args, { conversationId });
    const autoApproved = tool.autoApprove === true || tool.autoApproveIf?.(args) === true;
    const needsConfirm =
      metadata !== undefined ||
      (!autoApproved && ['write', 'delete', 'headless', 'terminal'].includes(tool.permission));
    try {
      if (needsConfirm) {
        const outcome = await service.request(
          name,
          metadata?.detail ?? JSON.stringify(args),
          metadata?.dangerous ?? false,
          conversationId,
          undefined,
          metadata?.gateKind ? { gateKind: metadata.gateKind } : undefined,
        );
        if (outcome !== 'approved') {
          log.push(`${name}: not approved (${String(outcome)})`);
          return;
        }
      }
      const result = await tool.handler(args, context);
      log.push(`${name}: ran — ${String(result)}`);
    } catch (err) {
      log.push(`${name}: refused — ${(err as Error).message}`);
    }
  };

  return {
    call,
    log,
    cards,
    service,
    registry,
    finish: () => marker?.dispose(),
    /** Resolve the card a control call raised, so the scripted turn does not hang. */
    answerCard: (approve: boolean) => {
      const card = cards()[0];
      if (card) service.resolve(card.id, approve ? 'approve' : 'decline', 'webview');
    },
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-modes-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-modes-home-'));
  fs.mkdirSync(path.join(workspace, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.forge', 'config.yaml'), 'active_model: none\n');
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(home, '.forge', 'note.txt'), 'owner notes\n');
  vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(workspace) });
});

afterEach(() => {
  vscode.workspace.workspaceFolders?.splice(0);
  for (const dir of [workspace, home]) fs.rmSync(dir, { recursive: true, force: true });
});

const CONFIG_EDIT = { path: '.forge/config.yaml', content: 'permissions:\n  fs:\n    delete: true\n' };
const ORDINARY_WRITE = { path: 'notes.txt', content: 'agent notes\n' };
const CONFIG_SHELL = { command: 'Add-Content .forge/config.yaml permissions:', shell: 'pwsh' };
const ORDINARY_SHELL = { command: 'Add-Content notes.txt agent-notes', shell: 'pwsh' };

describe('a read of Forge own config still runs, in a bash the runner has', () => {
  it('runs `cat` on the config and a redirect onto a file outside .forge/, and refuses the write', async () => {
    const targets = ownerOnlyTargets();
    const tool = makeShellTool({
      bashPath: TEST_BASH,
      getConfig: () =>
        ({ permissions: { exec: { shell: 'bash' } } }) as unknown as ForgeConfig,
      home,
      platform: 'win32',
      ownerOnly: () => targets.roots,
    });
    const read = await tool.handler({ command: 'cat .forge/config.yaml', shell: 'bash' }, context);
    expect(String(read)).toContain('active_model: none');
    // `git diff` on a path with no git repo behind it still reaches the program:
    // the guard did not refuse it.
    const diff = await tool.handler(
      { command: 'git diff .forge/config.yaml', shell: 'bash' },
      context,
    );
    expect(String(diff)).toMatch(/exit \d+/u);
    expect(String(diff)).not.toMatch(/owner/);
    await tool.handler({ command: 'echo not-the-config > config.yaml', shell: 'bash' }, context);
    expect(fs.readFileSync(path.join(workspace, 'config.yaml'), 'utf8')).toContain('not-the-config');
    // The write onto the config, same tool, same folder, one word different.
    await expect(
      tool.handler({ command: 'echo x > .forge/config.yaml', shell: 'bash' }, context),
    ).rejects.toThrow(/owner/);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(
      'active_model: none\n',
    );
  });
});

describe('an unattended run cannot change Forge own configuration, and asks nobody', () => {
  it('refuses the file tool at once, with no card, and leaves the config as it was', async () => {
    const run = harness('unattended', 'owner-unattended-1');
    try {
      await run.call('write_file', CONFIG_EDIT);
      expect(run.log[0]).toContain('refused before any card');
      expect(run.log[0]).toMatch(/only the owner/);
      expect(run.log[0]).toMatch(/Tell the user what change you want and why/);
      expect(run.cards()).toHaveLength(0);
      expect(run.service.pending()).toBeUndefined();
      expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(
        'active_model: none\n',
      );
      // The control: an ordinary write in the same folder is what an unattended
      // run always did — approved with no card, so a handler-only refusal here
      // would have been an auto-passed card.
      await run.call('write_file', ORDINARY_WRITE);
      expect(run.log[1]).toContain('ran —');
      expect(run.cards()).toHaveLength(0);
    } finally {
      run.finish();
    }
  });

  it('refuses the shell route too, because a refused classification raises no card', async () => {
    const run = harness('unattended', 'owner-unattended-2');
    try {
      await run.call('shell', CONFIG_SHELL);
      expect(run.log[0]).toContain('refused —');
      expect(run.log[0]).toMatch(/owner only|only the owner/);
      expect(run.log[0]).toContain('.forge/config.yaml');
      expect(run.cards()).toHaveLength(0);
      expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(
        'active_model: none\n',
      );
      // The control: the same command on another file is an ordinary `headless`
      // call, which unattended approves itself with no card — so a refusal that
      // only lived in the handler would have been an auto-passed write. It is not
      // run here, because that would spawn a real PowerShell on a runner that may
      // not have one.
      expect(run.registry.get('shell')!.autoApproveIf?.(ORDINARY_SHELL)).toBe(false);
    } finally {
      run.finish();
    }
  });
});

describe('/clanker does not approve past the owner guard either', () => {
  it('refuses the config write and the config shell, with no card', async () => {
    const run = harness('clanker', 'owner-clanker-1');
    run.service.setClankerMode('owner-clanker-1', true);
    try {
      await run.call('write_file', CONFIG_EDIT);
      await run.call('shell', CONFIG_SHELL);
      expect(run.log[0]).toContain('refused before any card');
      expect(run.log[1]).toContain('refused —');
      expect(run.cards()).toHaveLength(0);
      expect(run.service.pending()).toBeUndefined();
      // The control: `/clanker` still approves its own ordinary calls, so this
      // refusal is the owner rule, not `/clanker` being switched off.
      await run.call('write_file', ORDINARY_WRITE);
      expect(run.log[2]).toContain('ran —');
      expect(run.cards()).toHaveLength(0);
      expect(run.registry.get('shell')!.autoApproveIf?.(ORDINARY_SHELL)).toBe(false);
    } finally {
      run.finish();
    }
  });
});

describe('attended mode refuses before the card, not after it', () => {
  it('refuses the config write with no card, while an ordinary write still asks', async () => {
    const run = harness('attended', 'owner-attended-1');
    try {
      await run.call('write_file', CONFIG_EDIT);
      expect(run.log[0]).toContain('refused before any card');
      expect(run.cards()).toHaveLength(0);
      // The control: the very same tool, same folder, one file away from the
      // config, still raises the card an attended write always raised.
      const ordinary = run.call('write_file', ORDINARY_WRITE);
      // The card is raised inside an awaited hook, so it lands a microtask later.
      await vi.waitFor(() => expect(run.cards()).toHaveLength(1));
      run.answerCard(false);
      await ordinary;
      expect(run.log[1]).toContain('not approved');
      // And the shell control: `approval` returns metadata for a command the
      // owner guard does not refuse, so a card would have been raised for it,
      // while the owner-only command is auto-approved (no card) and then refused
      // by its own handler.
      const shellTool = run.registry.get('shell')!;
      expect(
        shellTool.approval?.(ORDINARY_SHELL, { conversationId: 'owner-attended-1' }),
      ).toBeDefined();
      expect(shellTool.autoApproveIf?.(ORDINARY_SHELL)).toBe(false);
      expect(shellTool.autoApproveIf?.(CONFIG_SHELL)).toBe(true);
    } finally {
      run.finish();
    }
  });
});
