import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrashRefusals,
  diagnoseTrashRefusal,
  forgetTrashRefusal,
  rememberTrashRefusal,
  trashRefusalForPath,
} from '../../src/tools/trashRefusal';

const temporaryRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trash-refusal-'));
  temporaryRoots.push(root);
  return root;
}

function extendedPath(targetPath: string): string {
  if (process.platform !== 'win32' || targetPath.startsWith('\\\\?\\')) return targetPath;
  if (targetPath.startsWith('\\\\')) return `\\\\?\\UNC\\${targetPath.slice(2)}`;
  return `\\\\?\\${targetPath}`;
}

afterEach(() => {
  vi.useRealTimers();
  clearTrashRefusals();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(extendedPath(root), { recursive: true, force: true });
});

describe('recycle-bin refusal diagnosis', () => {
  it('finds long paths and reports their count and longest relative path', () => {
    const root = makeTempRoot();
    let directory = path.join(root, 'long');
    for (let index = 0; index < 10; index++) {
      directory = path.join(directory, `segment-${'x'.repeat(20)}`);
    }
    fs.mkdirSync(extendedPath(directory), { recursive: true });
    const target = path.join(directory, 'trajectory.json');
    fs.writeFileSync(extendedPath(target), '{}');

    const diagnosis = diagnoseTrashRefusal(path.join(root, 'long'));

    expect(diagnosis).toMatch(/Found \d+ paths of 260\+ characters/u);
    expect(diagnosis).toMatch(/longest \d+: .*trajectory\.json/u);
  });

  it('mentions network or WSL only for UNC paths and names common unknown causes', () => {
    const readDirectory = (): fs.Dirent[] => [];
    const local = diagnoseTrashRefusal('N:\\workspace\\results', { readDirectory });
    const unc = diagnoseTrashRefusal('\\\\wsl.localhost\\Ubuntu\\home\\results', {
      readDirectory,
    });

    expect(local).toContain('Cause unknown');
    expect(local).toContain('a file open in another program');
    expect(local).toContain("the recycle bin's size limit");
    expect(local).not.toMatch(/network|UNC|WSL/iu);
    expect(unc).toContain('UNC network/WSL path');
  });

  it('reports when the bounded walk reaches its entry cap', () => {
    const root = makeTempRoot();
    for (const name of ['one', 'two', 'three']) fs.writeFileSync(path.join(root, name), 'x');

    expect(diagnoseTrashRefusal(root, { entryLimit: 2 })).toContain('Checked the first 2 entries.');
  });

  it('reports when the bounded walk reaches its time limit', () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, 'one'), 'x');
    let now = 0;

    expect(diagnoseTrashRefusal(root, { timeLimitMs: 2, now: () => now++ })).toContain(
      'Stopped after 2 ms.',
    );
  });

  it('expires cached diagnoses after one hour, drops the oldest past 100, and supports clearing', () => {
    vi.useFakeTimers();
    const root = makeTempRoot();
    rememberTrashRefusal(root, 'long-path diagnosis');
    expect(trashRefusalForPath(root)).toBe('long-path diagnosis');
    vi.advanceTimersByTime(60 * 60_000);
    expect(trashRefusalForPath(root)).toBeUndefined();

    for (let index = 0; index < 101; index++) {
      rememberTrashRefusal(`N:\\refusals\\${index}`, `diagnosis ${index}`);
    }
    expect(trashRefusalForPath('N:\\refusals\\0')).toBeUndefined();
    expect(trashRefusalForPath('N:\\refusals\\100')).toBe('diagnosis 100');
    forgetTrashRefusal('N:\\refusals\\100');
    expect(trashRefusalForPath('N:\\refusals\\100')).toBeUndefined();
    rememberTrashRefusal(root, 'to clear');
    clearTrashRefusals();
    expect(trashRefusalForPath(root)).toBeUndefined();
  });
});
