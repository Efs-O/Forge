import { describe, expect, it } from 'vitest';
import { describeDelete } from '../../src/sidebar/deletePreview';

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
});
