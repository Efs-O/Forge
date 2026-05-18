import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn().mockReturnValue({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

describe('CheckpointStack', () => {
  let stack: CheckpointStack;
  let tempDir: string;
  let testFile: string;
  let newFile: string;

  beforeEach(() => {
    stack = new CheckpointStack();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkpoint-'));
    testFile = path.join(tempDir, 'test.txt');
    newFile = path.join(tempDir, 'new.txt');
    fs.writeFileSync(testFile, 'original content', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('begins a turn with empty pending snapshots', () => {
    stack.beginTurn('turn-1');
    expect(stack.depth()).toBe(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('snapshots a file before it is written', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(testFile);
    expect(stack.canUndo()).toBe(false); // not committed yet

    fs.writeFileSync(testFile, 'modified content', 'utf8');
    stack.commitTurn();

    expect(stack.depth()).toBe(1);
    expect(stack.canUndo()).toBe(true);
  });

  it('restores original content on undo', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'modified content', 'utf8');
    stack.commitTurn();

    const restored = stack.undo();
    expect(restored).toContain(testFile);
    expect(fs.readFileSync(testFile, 'utf8')).toBe('original content');
    expect(stack.depth()).toBe(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('deletes a newly created file on undo when original was null', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(newFile);
    fs.writeFileSync(newFile, 'new content', 'utf8');
    stack.commitTurn();

    expect(fs.existsSync(newFile)).toBe(true);
    stack.undo();
    expect(fs.existsSync(newFile)).toBe(false);
  });

  it('is idempotent — only snapshots the first call per file per turn', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(testFile);
    stack.snapshotBefore(testFile);
    stack.snapshotBefore(testFile);

    fs.writeFileSync(testFile, 'first modification', 'utf8');
    stack.commitTurn();

    // Second turn, another snapshot of same file
    stack.beginTurn('turn-2');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'second modification', 'utf8');
    stack.commitTurn();

    expect(stack.depth()).toBe(2);

    // Undo second turn — should restore to 'first modification'
    stack.undo();
    expect(fs.readFileSync(testFile, 'utf8')).toBe('first modification');

    // Undo first turn — should restore to 'original content'
    stack.undo();
    expect(fs.readFileSync(testFile, 'utf8')).toBe('original content');
  });

  it('discards checkpoint on keep without restoring', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'modified content', 'utf8');
    stack.commitTurn();

    stack.keep();
    expect(stack.depth()).toBe(0);
    expect(fs.readFileSync(testFile, 'utf8')).toBe('modified content');
  });

  it('throws when undoing with empty stack', () => {
    expect(() => stack.undo()).toThrow('nothing to undo');
  });

  it('throws when keeping with empty stack', () => {
    expect(() => stack.keep()).toThrow('nothing to keep');
  });

  it('does not commit when no snapshots were taken', () => {
    stack.beginTurn('turn-1');
    stack.commitTurn();
    expect(stack.depth()).toBe(0);
  });

  it('tracks depth across multiple turns', () => {
    stack.beginTurn('turn-1');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'v1', 'utf8');
    stack.commitTurn();

    stack.beginTurn('turn-2');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'v2', 'utf8');
    stack.commitTurn();

    stack.beginTurn('turn-3');
    stack.snapshotBefore(testFile);
    fs.writeFileSync(testFile, 'v3', 'utf8');
    stack.commitTurn();

    expect(stack.depth()).toBe(3);

    stack.undo();
    expect(fs.readFileSync(testFile, 'utf8')).toBe('v2');
    expect(stack.depth()).toBe(2);

    stack.undo();
    expect(fs.readFileSync(testFile, 'utf8')).toBe('v1');
    expect(stack.depth()).toBe(1);

    stack.undo();
    expect(fs.readFileSync(testFile, 'utf8')).toBe('original content');
    expect(stack.depth()).toBe(0);
  });

  it('resolves relative paths to absolute', () => {
    const relativePath = path.relative(process.cwd(), testFile);
    stack.beginTurn('turn-1');
    stack.snapshotBefore(relativePath);
    fs.writeFileSync(testFile, 'modified', 'utf8');
    stack.commitTurn();

    const restored = stack.undo();
    expect(restored).toHaveLength(1);
    expect(path.isAbsolute(restored[0])).toBe(true);
    expect(fs.readFileSync(testFile, 'utf8')).toBe('original content');
  });

  it('handles non-existent files gracefully during snapshot', () => {
    const nonExistent = path.join(tempDir, 'does-not-exist.txt');
    stack.beginTurn('turn-1');
    // should not throw
    stack.snapshotBefore(nonExistent);
    fs.writeFileSync(nonExistent, 'created content', 'utf8');
    stack.commitTurn();

    expect(fs.existsSync(nonExistent)).toBe(true);
    stack.undo();
    expect(fs.existsSync(nonExistent)).toBe(false);
  });

  it('gracefully handles unreadable files during snapshot', () => {
    const unreadableDir = path.join(tempDir, 'unreadable');
    fs.mkdirSync(unreadableDir, { mode: 0o000 });
    const unreadableFile = path.join(unreadableDir, 'secret.txt');
    fs.writeFileSync(unreadableFile, 'secret', 'utf8');
    fs.chmodSync(unreadableDir, 0o000);

    try {
      stack.beginTurn('turn-1');
      // should not throw even though file is unreadable
      stack.snapshotBefore(unreadableFile);
      expect(stack.canUndo()).toBe(false); // commitTurn won't add anything if snapshot failed
    } finally {
      fs.chmodSync(unreadableDir, 0o755);
    }

    fs.rmSync(unreadableDir, { recursive: true, force: true });
  });
});
