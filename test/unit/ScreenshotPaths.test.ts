import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  screenshotDirectory,
  screenshotRoot,
} from '../../src/tools/browser/screenshotPaths';
import { saveScreenshot } from '../../src/tools/browser/browserTools';

const SAVED_OVERRIDE = process.env.FORGE_SCREENSHOT_DIR;
let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (SAVED_OVERRIDE === undefined) delete process.env.FORGE_SCREENSHOT_DIR;
  else process.env.FORGE_SCREENSHOT_DIR = SAVED_OVERRIDE;
});

describe('screenshot root (BL-011)', () => {
  it("is the owner's home Forge folder when nothing overrides it", () => {
    delete process.env.FORGE_SCREENSHOT_DIR;
    const home = path.join(os.homedir(), '.forge', 'screenshots');
    expect(screenshotRoot()).toBe(home);
    expect(screenshotDirectory('chat-1')).toBe(path.join(home, 'chat-1'));
    // A turn with no conversation shares the `default` folder, which is why
    // send_file refuses it as a per-chat root.
    expect(screenshotDirectory(undefined)).toBe(path.join(home, 'default'));
  });

  it('a blank override is not an override', () => {
    process.env.FORGE_SCREENSHOT_DIR = '   ';
    expect(screenshotRoot()).toBe(path.join(os.homedir(), '.forge', 'screenshots'));
  });

  it('is read at call time, so a test can point the writer elsewhere mid-run', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shots-'));
    process.env.FORGE_SCREENSHOT_DIR = root;
    // Real bytes through the real writer: what `browser_screenshot` and
    // `desktop_capture` actually do, not a fake that returns a made-up path.
    const png = Buffer.from('89504e4d0d0a1a0a', 'hex');
    const saved = await saveScreenshot('conv-a', png);
    expect(path.dirname(saved)).toBe(path.join(root, 'conv-a'));
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.readdirSync(path.join(root, 'conv-a'))).toHaveLength(1);
  });

  it('the override is resolved, so a relative value still names one folder', () => {
    process.env.FORGE_SCREENSHOT_DIR = 'screenshots-under-cwd';
    expect(screenshotRoot()).toBe(path.join(process.cwd(), 'screenshots-under-cwd'));
  });
});
