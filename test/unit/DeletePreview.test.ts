import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeDelete, isDangerousDelete } from '../../src/sidebar/deletePreview';
import {
  clearTrashRefusals,
  rememberTrashRefusal,
} from '../../src/tools/trashRefusal';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  clearTrashRefusals();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('describeDelete', () => {
  it('names every target of a paths batch in the approval text', async () => {
    // The dialog read only `path`, so a batch showed "(invalid path)" and the
    // user approved deletes they could not see.
    const text = await describeDelete({ paths: ['gone-a.txt', 'gone-b.txt'] });

    expect(text).toContain('About to move to the recycle bin 2 targets:');
    expect(text).toContain('Target: gone-a.txt');
    expect(text).toContain('Target: gone-b.txt');
    expect(text).not.toContain('(invalid path)');
    expect(text.match(/Recoverable from the recycle bin/g)).toHaveLength(1);
  });

  it('keeps the single-path header', async () => {
    const text = await describeDelete({ path: 'gone.txt', to_trash: false });

    expect(text.startsWith('About to permanently delete:\nTarget: gone.txt')).toBe(true);
  });

  it('classifies only permanent deletes as dangerous', () => {
    expect(isDangerousDelete({ recursive: true })).toBe(false);
    expect(isDangerousDelete({ recursive: true, to_trash: true })).toBe(false);
    expect(isDangerousDelete({ to_trash: false })).toBe(true);
    expect(isDangerousDelete({ recursive: true, to_trash: false })).toBe(true);
  });

  it('shows a cached recycle-bin refusal only for a permanent-delete preview', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-delete-preview-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'result.txt');
    fs.writeFileSync(target, 'result');
    rememberTrashRefusal(target, 'Cause unknown; the item may exceed a recycle-bin limit.');

    const permanent = await describeDelete({ path: target, to_trash: false });
    const recoverable = await describeDelete({ path: target, to_trash: true });

    expect(permanent).toContain(
      'Recycle bin refused it: Cause unknown; the item may exceed a recycle-bin limit.',
    );
    expect(recoverable).not.toContain('Recycle bin refused it:');
  });

  it('does not show a refusal after its one-hour cache expiry', async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-delete-preview-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'result.txt');
    fs.writeFileSync(target, 'result');
    rememberTrashRefusal(target, 'reason');
    vi.advanceTimersByTime(60 * 60_000);

    expect(await describeDelete({ path: target, to_trash: false })).not.toContain(
      'Recycle bin refused it:',
    );
  });
});
