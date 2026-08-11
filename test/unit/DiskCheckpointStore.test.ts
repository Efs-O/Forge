import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliChat } from '../../src/agents/CliChatRunner';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import { assertCheckpointWithinLimits } from '../../src/checkpoint/CheckpointPolicy';

const testRoots: string[] = [];

function fixture(limits = { maxBytes: 32 * 1024 * 1024, maxFiles: 10_000 }): {
  root: string;
  storage: string;
  stack: CheckpointStack;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-disk-checkpoint-'));
  testRoots.push(base);
  const root = path.join(base, 'workspace');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(root);
  return { root, storage, stack: new CheckpointStack({ storageRoot: storage, limits }) };
}

afterEach(() => {
  for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('disk-backed workspace checkpoints', () => {
  it('rejects a multi-gigabyte logical inventory without allocating its contents', () => {
    expect(() =>
      assertCheckpointWithinLimits(
        { totalBytes: 8 * 1024 ** 3, fileCount: 2_632 },
        { maxBytes: 2 * 1024 ** 3, maxFiles: 100_000 },
      ),
    ).toThrow(/8\.00 GiB.*maxBytes/i);
  });

  it('restores modified/deleted binary trees, removes creations, and never restores .forge', async () => {
    const { root, stack } = fixture();
    const binary = path.join(root, 'asset.bin');
    const deletedTree = path.join(root, 'tree');
    const liveConfig = path.join(root, '.forge', 'config.yaml');
    fs.writeFileSync(binary, Buffer.from([0, 255, 1, 254]));
    fs.mkdirSync(path.join(deletedTree, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(deletedTree, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(deletedTree, 'nested', 'file.txt'), 'before');
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.writeFileSync(liveConfig, 'live-before');

    const checkpoint = stack.beginTurn('turn-1', 'conversation-1');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);
    fs.writeFileSync(binary, Buffer.from([9]));
    fs.rmSync(deletedTree, { recursive: true });
    fs.mkdirSync(path.join(root, 'created', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'created', 'nested', 'new.txt'), 'new');
    fs.writeFileSync(liveConfig, 'live-after');
    await capture.finish();
    stack.commitTurn(checkpoint);

    expect(stack.canUndo('conversation-1')).toBe(true);
    await stack.undo('conversation-1');
    expect(fs.readFileSync(binary)).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(fs.readFileSync(path.join(deletedTree, 'nested', 'file.txt'), 'utf8')).toBe('before');
    expect(fs.statSync(path.join(deletedTree, 'empty')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, 'created'))).toBe(false);
    expect(fs.readFileSync(liveConfig, 'utf8')).toBe('live-after');
  });

  it('detects same-size content changes even when the timestamp is restored', async () => {
    const { root, stack } = fixture();
    const target = path.join(root, 'same-size.txt');
    fs.writeFileSync(target, 'aaaa');
    const originalStat = fs.statSync(target);
    const checkpoint = stack.beginTurn('turn-hash', 'hash-conversation');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);

    fs.writeFileSync(target, 'bbbb');
    fs.utimesSync(target, originalStat.atime, originalStat.mtime);
    await capture.finish();
    stack.commitTurn(checkpoint);
    expect(stack.canUndo('hash-conversation')).toBe(true);
    await stack.undo('hash-conversation');
    expect(fs.readFileSync(target, 'utf8')).toBe('aaaa');
  });

  it('restores directory symlink targets without following them into the checkpoint', async () => {
    const { root, stack } = fixture();
    const firstTarget = path.join(root, 'target-one');
    const secondTarget = path.join(root, 'target-two');
    const link = path.join(root, 'linked-directory');
    fs.mkdirSync(firstTarget);
    fs.mkdirSync(secondTarget);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(firstTarget, link, linkType);
    const checkpoint = stack.beginTurn('turn-link', 'link-conversation');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);

    fs.unlinkSync(link);
    fs.symlinkSync(secondTarget, link, linkType);
    await capture.finish();
    stack.commitTurn(checkpoint);
    await stack.undo('link-conversation');

    expect(fs.realpathSync(link)).toBe(fs.realpathSync(firstTarget));
  });

  it('does not retain a checkpoint for a read-only turn', async () => {
    const { root, storage, stack } = fixture();
    fs.writeFileSync(path.join(root, 'read-only.txt'), 'unchanged');
    const checkpoint = stack.beginTurn('turn-read', 'read-conversation');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);
    await capture.finish();
    stack.commitTurn(checkpoint);

    expect(stack.canUndo('read-conversation')).toBe(false);
    expect(fs.readdirSync(storage)).toEqual([]);
  });

  it('blocks an over-budget CLI turn before invoking the driver', async () => {
    const { root, stack } = fixture({ maxBytes: 4, maxFiles: 100 });
    fs.writeFileSync(path.join(root, 'too-large.txt'), '12345');
    const checkpoint = stack.beginTurn('turn-limit', 'limit-conversation');
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'should not run' }));
    const onPrepared = vi.fn();

    await expect(
      runCliChat({
        prepared: { cliName: 'claude', executable: 'claude' },
        model: { name: 'claude-code', provider: 'cli', cli: 'claude' },
        messages: [{ role: 'user', content: 'inspect this' }],
        workspaceRoot: root,
        checkpoint,
        signal: new AbortController().signal,
        onText: vi.fn(),
        onStatus: vi.fn(),
        onPrepared,
        driver: { run } as unknown as CliAgentDriver,
      }),
    ).rejects.toThrow(/did not start the external CLI.*maxBytes/i);
    expect(run).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it('cancels preparation without leaving a pending checkpoint directory', async () => {
    const { root, storage, stack } = fixture();
    fs.writeFileSync(path.join(root, 'first.bin'), Buffer.alloc(128 * 1024, 1));
    fs.writeFileSync(path.join(root, 'second.bin'), Buffer.alloc(128 * 1024, 2));
    const controller = new AbortController();
    const checkpoint = stack.beginTurn('turn-cancel', 'cancel-conversation');

    await expect(
      checkpoint.prepareWorkspace(root, controller.signal, (progress) => {
        if (progress.phase === 'capture') controller.abort(new Error('cancelled by test'));
      }),
    ).rejects.toThrow(/cancelled by test/);
    expect(fs.readdirSync(storage)).toEqual([]);
  });

  it('Keep removes disk checkpoint data without changing the workspace', async () => {
    const { root, storage, stack } = fixture();
    const target = path.join(root, 'keep.txt');
    fs.writeFileSync(target, 'before');
    const checkpoint = stack.beginTurn('turn-keep', 'keep-conversation');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);
    fs.writeFileSync(target, 'after');
    await capture.finish();
    stack.commitTurn(checkpoint);
    expect(fs.readdirSync(storage).length).toBe(1);

    await stack.keep('keep-conversation');
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(fs.readdirSync(storage)).toEqual([]);
  });

  it('retains recovery data when a checkpoint blob is corrupt', async () => {
    const { root, storage, stack } = fixture();
    const target = path.join(root, 'corrupt.txt');
    fs.writeFileSync(target, 'before');
    const checkpoint = stack.beginTurn('turn-corrupt', 'corrupt-conversation');
    const capture = await checkpoint.prepareWorkspace(root, new AbortController().signal);
    fs.writeFileSync(target, 'after!');
    await capture.finish();
    stack.commitTurn(checkpoint);
    const checkpointDir = path.join(storage, fs.readdirSync(storage)[0]!);
    const blob = path.join(
      checkpointDir,
      'blobs',
      fs.readdirSync(path.join(checkpointDir, 'blobs'))[0]!,
    );
    fs.writeFileSync(blob, 'xxxxxx');

    await expect(stack.undo('corrupt-conversation')).rejects.toThrow(/recovery data retained/);
    expect(stack.canUndo('corrupt-conversation')).toBe(true);
    expect(fs.existsSync(checkpointDir)).toBe(true);
  });

  it('keeps checkpoint stacks isolated by conversation', async () => {
    const { root, stack } = fixture();
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');

    const checkpointA = stack.beginTurn('turn-a', 'conversation-a');
    const captureA = await checkpointA.prepareWorkspace(root, new AbortController().signal);
    fs.writeFileSync(first, 'first-after');
    await captureA.finish();
    stack.commitTurn(checkpointA);

    const checkpointB = stack.beginTurn('turn-b', 'conversation-b');
    const captureB = await checkpointB.prepareWorkspace(root, new AbortController().signal);
    fs.writeFileSync(second, 'second-after');
    await captureB.finish();
    stack.commitTurn(checkpointB);

    await stack.undo('conversation-a');
    expect(fs.readFileSync(first, 'utf8')).toBe('first-before');
    expect(fs.readFileSync(second, 'utf8')).toBe('second-after');
    expect(stack.canUndo('conversation-b')).toBe(true);
    await stack.undo('conversation-b');
    expect(fs.readFileSync(second, 'utf8')).toBe('second-before');
  });

  it('limits a scoped worker checkpoint to its declared writable path', async () => {
    const { root, stack } = fixture();
    const covered = path.join(root, 'covered.txt');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(covered, 'covered-before');
    fs.writeFileSync(outside, 'outside-before');
    const checkpoint = stack.beginTurn('turn-scoped', 'scoped-conversation');
    const capture = await checkpoint.preparePaths(root, [covered], new AbortController().signal);
    fs.writeFileSync(covered, 'covered-after');
    fs.writeFileSync(outside, 'outside-after');
    await capture.finish();
    stack.commitTurn(checkpoint);

    await stack.undo('scoped-conversation');
    expect(fs.readFileSync(covered, 'utf8')).toBe('covered-before');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-after');
  });
});
