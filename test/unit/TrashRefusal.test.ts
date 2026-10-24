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
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(extendedPath(root), { recursive: true, force: true });
});

describe('recycle-bin refusal diagnosis', () => {
  it('finds long paths and reports their count and longest relative path', async () => {
    const root = makeTempRoot();
    let directory = path.join(root, 'long');
    for (let index = 0; index < 10; index++) {
      directory = path.join(directory, `segment-${'x'.repeat(20)}`);
    }
    fs.mkdirSync(extendedPath(directory), { recursive: true });
    const target = path.join(directory, 'trajectory.json');
    fs.writeFileSync(extendedPath(target), '{}');

    const diagnosis = await diagnoseTrashRefusal(path.join(root, 'long'));

    expect(diagnosis).toMatch(/Found \d+ paths of 260\+ characters/u);
    expect(diagnosis).toMatch(/longest \d+: .*trajectory\.json/u);
  });

  it('mentions network or WSL only for UNC paths and names common unknown causes', async () => {
    const readDirectory = (): fs.Dirent[] => [];
    const local = await diagnoseTrashRefusal('N:\\workspace\\results', { readDirectory });
    const unc = await diagnoseTrashRefusal('\\\\wsl.localhost\\Ubuntu\\home\\results', {
      readDirectory,
    });

    expect(local).toContain('Cause unknown');
    expect(local).toContain('a file open in another program');
    expect(local).toContain("the recycle bin's size limit");
    expect(local).not.toMatch(/network|UNC|WSL/iu);
    expect(unc).toContain('UNC network/WSL path');
  });

  it('reports when the bounded walk reaches its entry cap', async () => {
    const root = makeTempRoot();
    for (const name of ['one', 'two', 'three']) fs.writeFileSync(path.join(root, name), 'x');

    expect(await diagnoseTrashRefusal(root, { entryLimit: 2 })).toContain(
      'Checked the first 2 entries.',
    );
  });

  it('reports when the bounded walk reaches its time limit', async () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, 'one'), 'x');
    let now = 0;

    expect(await diagnoseTrashRefusal(root, { timeLimitMs: 2, now: () => now++ })).toContain(
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

  it('keys a refusal by the real path, so the preview finds it under either spelling', () => {
    const root = makeTempRoot();
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.mkdirSync(real);
      fs.symlinkSync(real, link, linkType);
    } catch {
      // Links are unavailable on some filesystems; skip rather than fail.
      return;
    }
    // The delete tool keys a refusal by the real path it resolved; the sidebar
    // preview passes the path the user asked for, which may go through a link —
    // and on macOS the whole temp root is under a link (`/var` is
    // `/private/var`), so the two spellings differ for every path there.
    const inReal = path.join(real, 'result.txt');
    const inLink = path.join(link, 'result.txt');
    fs.writeFileSync(inReal, 'result');
    rememberTrashRefusal(inReal, 'diagnosis under the real path');
    expect(trashRefusalForPath(inLink)).toBe('diagnosis under the real path');

    // The same lookup after the target is gone: a deleted (or never-created)
    // target must still resolve through the nearest existing ancestor, because
    // that is where the tool wrote the key while the file existed.
    const goneReal = path.join(real, 'gone.txt');
    const goneLink = path.join(link, 'gone.txt');
    fs.writeFileSync(goneReal, 'gone');
    rememberTrashRefusal(goneReal, 'diagnosis for a deleted target');
    fs.rmSync(goneReal);
    expect(trashRefusalForPath(goneLink)).toBe('diagnosis for a deleted target');
  });
});
