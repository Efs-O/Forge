/**
 * The two path rewrites a remote media job's result text goes through
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2, criterion 8: no desktop path
 * crosses to the laptop).
 *
 * These are the exact strings the 0.17.195 laptop test produced, and the exact
 * strings the fix has to produce: every case is pinned whole with `toBe`, so a
 * rule that quietly stops matching (a separator written the other way, a case
 * that stopped matching, a period swallowed into the name) fails here rather
 * than in the owner's laptop chat.
 */
import { describe, expect, it } from 'vitest';
import {
  desktopPathsToNames,
  namesToLaptopPaths,
  toolResultText,
} from '../../src/media/remoteMediaResultText';

/** The desktop's job folder, in the shape it really has: a user folder with a
 *  space in it, mixed separators, and the render two folders deep. */
const JOB_DIR = 'C:\\Users\\me x\\AppData\\remote-media\\abc123';

describe('desktopPathsToNames: the desktop path never crosses', () => {
  it('rewrites a forward-slash path and a quoted backslash path to their names', () => {
    const text =
      'Generated image saved to C:/Users/me x/AppData/remote-media/abc123/out/smoke-195/fox.png ' +
      '(image/png, 3 bytes). The original "C:\\Users\\me x\\AppData\\remote-media\\abc123\\inputs\\fox.png" ' +
      'is untouched. To inspect it, call view_image on that path.';
    expect(desktopPathsToNames(text, JOB_DIR)).toBe(
      'Generated image saved to fox.png (image/png, 3 bytes). The original "fox.png" is ' +
      'untouched. To inspect it, call view_image on that path.',
    );
  });

  it('matches the folder in another case, and leaves a sentence-final period out of the name', () => {
    expect(
      desktopPathsToNames(
        'Saved to c:\\users\\me x\\appdata\\remote-media\\abc123\\out\\a.png.',
        JOB_DIR,
      ),
    ).toBe('Saved to a.png.');
  });

  it('leaves a path outside the job folder alone', () => {
    const text = 'Saved to C:/other/a.png';
    expect(desktopPathsToNames(text, JOB_DIR)).toBe(text);
  });

  it('stops the path at the punctuation that wraps it, not at the next word', () => {
    expect(
      desktopPathsToNames(
        `See ${JOB_DIR}/out/fox.png, then ${JOB_DIR}\\out\\cat.png (also ${JOB_DIR}/out/dog.png).`,
        JOB_DIR,
      ),
    ).toBe('See fox.png, then cat.png (also dog.png).');
  });

  it('returns text with no path in it unchanged', () => {
    const text = 'Upscaled to fox_x4.png from fox.png; nothing here to rewrite.';
    expect(desktopPathsToNames(text, '')).toBe(text);
    expect(desktopPathsToNames(text, JOB_DIR)).toBe(text);
  });
});

describe('namesToLaptopPaths: the laptop path the model can open', () => {
  it('rewrites the longest name first, and both spellings of a quoted name', () => {
    expect(
      namesToLaptopPaths('Upscaled to fox_x4.png from "fox.png"; see fox.png.', {
        'fox.png': 'smoke-195/fox.png',
        'fox_x4.png': 'smoke-195/fox_x4.png',
      }),
    ).toBe('Upscaled to smoke-195/fox_x4.png from "smoke-195/fox.png"; see smoke-195/fox.png.');
  });

  it('leaves a name that is part of a longer word, or grew an extension', () => {
    const text = 'myfox.png and fox.pngx and fox.png.bak';
    expect(namesToLaptopPaths(text, { 'fox.png': 'a/fox.png' })).toBe(text);
  });

  it('never rewrites a name inside a laptop path it already wrote', () => {
    const text = 'Saved on this laptop: smoke-195/fox.png, and C:\\x\\fox.png too.';
    expect(namesToLaptopPaths(text, { 'fox.png': 'smoke-195/fox.png' })).toBe(text);
  });

  it('rewrites a name at the very start and the very end of the text', () => {
    expect(namesToLaptopPaths('fox.png alone', { 'fox.png': 'pics/fox.png' })).toBe(
      'pics/fox.png alone',
    );
  });

  it('returns text unchanged when the map is empty', () => {
    const text = 'Generated image saved to cat.png';
    expect(namesToLaptopPaths(text, {})).toBe(text);
  });
});

describe('toolResultText: the handler answer as text', () => {
  it('takes a string as it is, and the text field when the result carries one', () => {
    expect(toolResultText('Generated image saved to cat.png')).toBe(
      'Generated image saved to cat.png',
    );
    expect(toolResultText({ text: '🖼 cat', content: [] })).toBe('🖼 cat');
  });
});
