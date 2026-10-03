import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const { mockedHome } = vi.hoisted(() => ({ mockedHome: vi.fn<() => string>() }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockedHome };
});
vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { makeSendFileTool } from '../../src/tools/sendFileTool';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

let root: string;
let home: string;
let notifications: UserNotificationService;
let temporaryHome: string;

function setWorkspace(folder: string): void {
  (
    vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    }
  ).workspaceFolders = [{ uri: { fsPath: folder } }];
}

function context(conversationId?: string): ToolHandlerContext {
  return {
    beforeMutate: () => undefined,
    ...(conversationId ? { conversationId } : {}),
  };
}

async function writeFile(filePath: string, contents = 'file contents'): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  return filePath;
}

async function screenshotPath(conversationId: string, name: string): Promise<string> {
  return writeFile(path.join(home, '.forge', 'screenshots', conversationId, name));
}

function makeTool(deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 0 }))) {
  const service = { deliverFile } as unknown as UserNotificationService;
  return { tool: makeSendFileTool({ notifications: service }), service };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-send-file-'));
  temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-send-file-home-'));
  home = path.join(temporaryHome, 'home');
  await fs.mkdir(home, { recursive: true });
  mockedHome.mockReturnValue(home);
  setWorkspace(root);
  notifications = new UserNotificationService();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(temporaryHome, { recursive: true, force: true });
});

describe('send_file', () => {
  it('resolves and queues a workspace-relative path', async () => {
    const file = await writeFile(path.join(root, 'reports', 'summary.pdf'));
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);

    const result = await tool.handler({ path: 'reports/summary.pdf' }, context('conv-a'));

    expect(result).toBe('Queued summary.pdf for 1 remote chat(s).');
    expect(deliverFile).toHaveBeenCalledWith({
      conversationId: 'conv-a',
      text: '',
      imagePath: await fs.realpath(file),
    });
  });

  it('allows a path in this conversation screenshot directory', async () => {
    const file = await screenshotPath('conv-a', 'capture.png');
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);

    const result = await tool.handler({ path: file }, context('conv-a'));

    expect(result).toContain('Queued capture.png');
    expect(deliverFile).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: await fs.realpath(file) }),
    );
  });

  it('handles a home-directory junction and refuses screenshot symlinks that escape', async () => {
    const homeAlias = path.join(root, 'home-alias');
    await fs.symlink(home, homeAlias, 'junction');
    mockedHome.mockReturnValue(homeAlias);
    const file = await screenshotPath('conv-a', 'capture.png');
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);
    expect(await tool.handler({ path: file }, context('conv-a'))).toContain('Queued capture.png');

    const outside = path.join(root, 'outside');
    await writeFile(path.join(outside, 'stolen.txt'));
    const screenshotDir = path.join(home, '.forge', 'screenshots', 'conv-a');
    await fs.symlink(outside, path.join(screenshotDir, 'escape'), 'junction');
    const escaped = await tool.handler(
      { path: path.join(screenshotDir, 'escape', 'stolen.txt') },
      context('conv-a'),
    );
    expect(escaped).toContain('path must be in the workspace');
  });

  it('refuses a conversation directory that is a junction to another conversation', async () => {
    // "This conversation only" has to survive an alias AT the conversation
    // directory itself. realpath(conv-a) landing inside the screenshot base is
    // not enough: containment would then hand conv-b's files to conv-a.
    const fileB = await screenshotPath('conv-b', 'capture.png');
    const dirB = path.join(home, '.forge', 'screenshots', 'conv-b');
    const dirA = path.join(home, '.forge', 'screenshots', 'conv-a');
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.symlink(dirB, dirA, 'junction');
    const { tool } = makeTool();

    const result = await tool.handler({ path: fileB }, context('conv-a'));

    expect(result).toContain('path must be in the workspace');
  });

  it.each(['Default', 'DEFAULT'])(
    'refuses the shared screenshot directory when conversationId is %j',
    async (conversationId) => {
      // The filesystem is case-insensitive on Windows and macOS, so a
      // differently-cased spelling is the same shared directory.
      const file = await screenshotPath(conversationId, 'capture.png');
      const { tool } = makeTool();
      const result = await tool.handler({ path: file }, context(conversationId));
      expect(result).toContain('path must be in the workspace');
    },
  );

  it('refuses a workspace child junction that escapes the workspace', async () => {
    // send_file resolves the workspace arm through the realpath resolver, so a
    // junction inside the workspace must not become a read of anything it
    // points at. Pinning this here (not only in the resolver's own tests) means
    // a future switch to the lexical resolver fails this suite.
    const outside = path.join(root, '..', 'forge-send-file-outside');
    await fs.mkdir(outside, { recursive: true });
    try {
      await writeFile(path.join(outside, 'stolen.txt'));
      await fs.symlink(outside, path.join(root, 'link'), 'junction');
      const { tool } = makeTool();

      const result = await tool.handler({ path: 'link/stolen.txt' }, context('conv-a'));

      expect(result).toContain('path must be in the workspace');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses paths outside both roots and names the allowed locations', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outside-'));
    const file = await writeFile(path.join(outside, 'secret.txt'));
    const { tool } = makeTool();
    try {
      const result = await tool.handler({ path: file }, context('conv-a'));
      expect(result).toContain(
        "path must be in the workspace or this conversation's screenshot directory",
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses another conversation screenshot directory', async () => {
    const file = await screenshotPath('conv-b', 'capture.png');
    const { tool } = makeTool();
    const result = await tool.handler({ path: file }, context('conv-a'));
    expect(result).toContain('path must be in the workspace');
  });

  it.each(['../../x', 'other/conv', 'default'])(
    'refuses screenshot paths when conversationId is %j',
    async (conversationId) => {
      const file = await screenshotPath(conversationId, 'capture.png');
      const { tool } = makeTool();
      const result = await tool.handler({ path: file }, context(conversationId));
      expect(result).toContain('path must be in the workspace');
    },
  );

  it('does not fall back to the shared default screenshot directory without a conversation', async () => {
    const file = await screenshotPath('default', 'capture.png');
    const { tool } = makeTool();
    const result = await tool.handler({ path: file });
    expect(result).toContain('path must be in the workspace');
  });

  it('refuses missing paths and directories', async () => {
    const { tool } = makeTool();
    const missing = await tool.handler({ path: 'missing.txt' }, context('conv-a'));
    const directory = await tool.handler({ path: '.' }, context('conv-a'));
    expect(missing).toContain('path must be in the workspace');
    expect(directory).toContain('path must be in the workspace');
  });

  it('refuses files over 50 MB and reports their actual size', async () => {
    const file = path.join(root, 'large.bin');
    await fs.writeFile(file, '');
    const actualSize = 50 * 1024 * 1024 + 1;
    await fs.truncate(file, actualSize);
    const { tool } = makeTool();

    const result = await tool.handler({ path: 'large.bin' }, context('conv-a'));

    expect(result.replace(/[,.]/g, '')).toContain(String(actualSize));
    expect(result.replace(/[,.]/g, '')).toContain(String(50 * 1024 * 1024));
  });

  it('accepts a file exactly 50 MB', async () => {
    const file = path.join(root, 'limit.bin');
    await fs.writeFile(file, '');
    await fs.truncate(file, 50 * 1024 * 1024);
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);

    const result = await tool.handler({ path: 'limit.bin' }, context('conv-a'));

    expect(result).toBe('Queued limit.bin for 1 remote chat(s).');
    expect(deliverFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a zero-byte file', async () => {
    await writeFile(path.join(root, 'empty.txt'), '');
    const { tool } = makeTool();
    const result = await tool.handler({ path: 'empty.txt' }, context('conv-a'));
    expect(result).toContain('empty file');
  });

  it('reports queued rather than sent when a chat is watching', async () => {
    await writeFile(path.join(root, 'report.md'));
    const { tool } = makeTool(vi.fn(async () => ({ kind: 'queued' as const, chats: 1 })));
    const result = await tool.handler({ path: 'report.md' }, context('conv-a'));
    expect(result).toBe('Queued report.md for 1 remote chat(s).');
    expect(result).not.toContain('Sent');
  });

  it('reports when no remote chat is watching', async () => {
    await writeFile(path.join(root, 'report.md'));
    const { tool } = makeTool(vi.fn(async () => ({ kind: 'queued' as const, chats: 0 })));
    const result = await tool.handler({ path: 'report.md' }, context('conv-a'));
    expect(result).toBe('No remote chat is watching this turn, so nothing was queued.');
  });

  it('passes captions through and sends an empty caption when omitted', async () => {
    await writeFile(path.join(root, 'report.md'));
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);
    await tool.handler({ path: 'report.md', caption: 'Review this report.' }, context('conv-a'));
    await tool.handler({ path: 'report.md' }, context('conv-a'));
    expect(deliverFile.mock.calls[0]?.[0]).toMatchObject({ text: 'Review this report.' });
    expect(deliverFile.mock.calls[1]?.[0]).toMatchObject({ text: '' });
  });

  it('refuses a caption over 1024 code points but accepts one of 1024 emoji', async () => {
    // The schema's maxLength and Telegram's caption limit both mean characters.
    // Measuring an emoji-heavy caption in UTF-16 code units would refuse text
    // that fits, and the sender's trim could cut a surrogate pair.
    await writeFile(path.join(root, 'report.md'));
    const deliverFile = vi.fn(async () => ({ kind: 'queued' as const, chats: 1 }));
    const { tool } = makeTool(deliverFile);

    const fits = '🖼'.repeat(1024);
    expect(fits.length).toBe(2048);
    expect(await tool.handler({ path: 'report.md', caption: fits }, context('conv-a'))).toContain(
      'Queued',
    );

    const tooLong = await tool.handler(
      { path: 'report.md', caption: '🖼'.repeat(1025) },
      context('conv-a'),
    );
    expect(tooLong).toContain('caption must be text no longer than 1024 characters');
    expect(deliverFile).toHaveBeenCalledTimes(1);
  });

  it('includes the safety routing text in the definition', () => {
    const { tool } = makeTool();
    expect(tool.definition.function.description).toContain(
      'Send only files you created or the user asked for',
    );
  });

  it('uses fetch permission without additional permissions', () => {
    const { tool } = makeTool();
    expect(tool.permission).toBe('fetch');
    expect(tool.additionalPermissions).toBeUndefined();
    expect(tool.approval).toBeUndefined();
    expect(tool.definition.function.parameters['required']).toEqual(['path']);
    expect(
      (tool.definition.function.parameters['properties'] as Record<string, { maxLength?: number }>)[
        'caption'
      ]?.maxLength,
    ).toBe(1024);
    expect(tool.definition.function.parameters['additionalProperties']).toBe(false);
    expect(tool.requiresVision).toBeUndefined();
    expect(tool.advertise).toBeUndefined();
    expect(tool.mutation).toBeUndefined();
  });

  it('refuses the sixth delivery in a turn using the shared service budget', async () => {
    await writeFile(path.join(root, 'report.md'));
    const { tool } = makeTool(notifications.deliverFile.bind(notifications));
    const sink = vi.fn(async () => 1);
    notifications.addSink(sink);

    for (let index = 0; index < 5; index += 1) {
      expect(await tool.handler({ path: 'report.md' }, context('conv-a'))).toContain('Queued');
    }
    const sixth = await tool.handler({ path: 'report.md' }, context('conv-a'));

    expect(sixth).toContain('File delivery limit reached: 5 of 5');
    expect(sink).toHaveBeenCalledTimes(5);
  });

  it('resets the shared file budget for the next turn', async () => {
    await writeFile(path.join(root, 'report.md'));
    const { tool } = makeTool(notifications.deliverFile.bind(notifications));
    notifications.addSink(async () => 1);
    for (let index = 0; index < 5; index += 1) {
      await tool.handler({ path: 'report.md' }, context('conv-a'));
    }
    expect(await tool.handler({ path: 'report.md' }, context('conv-a'))).toContain(
      'File delivery limit reached',
    );

    notifications.resetTurn('conv-a');

    expect(await tool.handler({ path: 'report.md' }, context('conv-a'))).toContain('Queued');
  });
});
