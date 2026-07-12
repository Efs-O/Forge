import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';

describe('CheckpointStack', () => {
  let root: string;
  let checkpoints: CheckpointStack;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkpoint-'));
    checkpoints = new CheckpointStack();
    checkpoints.beginTurn('turn-1');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('restores binary files without UTF-8 conversion', () => {
    const target = path.join(root, 'asset.bin');
    const original = Buffer.from([0, 255, 1, 254]);
    fs.writeFileSync(target, original);
    checkpoints.snapshotBefore(target);
    fs.writeFileSync(target, Buffer.from([9]));
    checkpoints.commitTurn();
    checkpoints.undo();
    expect(fs.readFileSync(target)).toEqual(original);
  });

  it('removes a directory created during the turn', () => {
    const target = path.join(root, 'new', 'nested');
    checkpoints.snapshotBefore(target);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'file.txt'), 'new');
    checkpoints.commitTurn();
    checkpoints.undo();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('restores a recursively deleted directory', () => {
    const target = path.join(root, 'tree');
    fs.mkdirSync(path.join(target, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(target, 'nested', 'text.txt'), 'before');
    checkpoints.snapshotBefore(target);
    fs.rmSync(target, { recursive: true });
    checkpoints.commitTurn();
    checkpoints.undo();
    expect(fs.readFileSync(path.join(target, 'nested', 'text.txt'), 'utf8')).toBe('before');
    expect(fs.statSync(path.join(target, 'empty')).isDirectory()).toBe(true);
  });

  it('restores both sides of a move', () => {
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    fs.writeFileSync(source, 'source');
    checkpoints.snapshotBefore(source);
    checkpoints.snapshotBefore(destination);
    fs.renameSync(source, destination);
    checkpoints.commitTurn();
    checkpoints.undo();
    expect(fs.readFileSync(source, 'utf8')).toBe('source');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('retains the original state when the same file is snapshotted repeatedly', () => {
    const target = path.join(root, 'repeat.txt');
    fs.writeFileSync(target, 'original');
    checkpoints.snapshotBefore(target);
    fs.writeFileSync(target, 'first write');
    checkpoints.snapshotBefore(target);
    fs.writeFileSync(target, 'second write');
    checkpoints.commitTurn();
    checkpoints.undo();
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });

  it('keeps exactly the most recent completed turn', () => {
    const first = path.join(root, 'first.txt');
    fs.writeFileSync(first, 'before first');
    checkpoints.snapshotBefore(first);
    fs.writeFileSync(first, 'after first');
    checkpoints.commitTurn();

    checkpoints.beginTurn('turn-2');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(second, 'before second');
    checkpoints.snapshotBefore(second);
    fs.writeFileSync(second, 'after second');
    checkpoints.commitTurn();

    checkpoints.keep();
    checkpoints.undo();
    expect(fs.readFileSync(first, 'utf8')).toBe('before first');
    expect(fs.readFileSync(second, 'utf8')).toBe('after second');
  });
});
