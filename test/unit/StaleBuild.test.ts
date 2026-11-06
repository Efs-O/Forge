/**
 * What this covers: the stale-window check a job start and a config failure
 * depend on. VS Code swaps an installed extension in only at a window reload, so
 * the running version and the installed version can differ for weeks — and on
 * 2026-10-27 that gap was the real cause of a failed 08:04 job while the config
 * was fine. Both halves are tested against a temp directory, never the real
 * extensions folder, so a test cannot be made red by whatever the machine has
 * installed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareSemver,
  detectStaleBuild,
  newestInstalledVersion,
  staleBuildNoticeFor,
} from '../../src/vscode/staleBuild';

const PREFIX = 'efsoo.forge-llm-';

const mocks = vi.hoisted(() => ({
  /** What `vscode.extensions.getExtension('Efsoo.forge-llm')` reports. */
  extension: undefined as { packageJSON: { version: string }; extensionPath: string } | undefined,
  warnings: [] as string[],
  commands: [] as string[],
  warningResult: 'Reload Window' as string | undefined,
  warningPromise: undefined as Promise<string | undefined> | undefined,
}));

vi.mock('vscode', () => ({
  extensions: { getExtension: () => mocks.extension },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    showWarningMessage: async (message: string) => {
      mocks.warnings.push(message);
      return mocks.warningPromise ?? mocks.warningResult;
    },
  },
  commands: {
    executeCommand: async (id: string) => {
      mocks.commands.push(id);
      return undefined;
    },
  },
}));

const tempDirs: string[] = [];

function mkExtensionsDir(versions: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stale-build-'));
  tempDirs.push(dir);
  for (const version of versions) fs.mkdirSync(path.join(dir, `${PREFIX}${version}`));
  return dir;
}

afterEach(() => {
  mocks.extension = undefined;
  mocks.warnings.length = 0;
  mocks.commands.length = 0;
  mocks.warningResult = 'Reload Window';
  mocks.warningPromise = undefined;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('compareSemver', () => {
  it('compares segments as numbers, not as text', () => {
    // The mistake this module exists to avoid: `0.17.10` sorts before `0.17.9`
    // as a string, so a plain comparison would hide the newest build.
    expect(compareSemver('0.17.10', '0.17.9')).toBeGreaterThan(0);
    expect(compareSemver('0.17.87', '0.17.86')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.17.86', '0.17.86')).toBe(0);
  });

  it('puts a pre-release or build suffix below the plain version', () => {
    expect(compareSemver('0.17.87-dev', '0.17.87')).toBeLessThan(0);
    expect(compareSemver('0.17.87', '0.17.87-dev')).toBeGreaterThan(0);
  });

  it('returns undefined when either side is not a version', () => {
    expect(compareSemver('0.17', '0.17.0')).toBeUndefined();
    expect(compareSemver('partial-install', '0.17.0')).toBeUndefined();
  });
});

describe('newestInstalledVersion', () => {
  it('picks the newest folder by number', () => {
    expect(newestInstalledVersion(mkExtensionsDir(['0.17.9', '0.17.10']), PREFIX)).toBe('0.17.10');
    expect(newestInstalledVersion(mkExtensionsDir(['0.17.86', '0.17.9']), PREFIX)).toBe('0.17.86');
    expect(newestInstalledVersion(mkExtensionsDir(['0.17.86', '0.17.87']), PREFIX)).toBe('0.17.87');
  });

  it('ignores other extensions, half-installed folders and files', () => {
    const dir = mkExtensionsDir(['0.17.86']);
    fs.mkdirSync(path.join(dir, 'other.publisher-9.9.9'));
    fs.mkdirSync(path.join(dir, `${PREFIX}partial-install`));
    fs.mkdirSync(path.join(dir, `${PREFIX}0.17.87`));
    fs.writeFileSync(path.join(dir, `${PREFIX}9.9.9.txt`), 'not a folder');
    fs.writeFileSync(path.join(dir, '.obsolete'), 'x');
    expect(newestInstalledVersion(dir, PREFIX)).toBe('0.17.87');
  });

  it('says nothing when the extensions folder is not there', () => {
    expect(
      newestInstalledVersion(path.join(os.tmpdir(), 'forge-no-such-extensions-dir'), PREFIX),
    ).toBeUndefined();
  });
});

describe('staleBuildNoticeFor', () => {
  it('names both versions and what to do about it', () => {
    const dir = mkExtensionsDir(['0.17.86', '0.17.87']);
    expect(staleBuildNoticeFor('0.17.86', dir, PREFIX)).toBe(
      'Forge 0.17.87 is installed; this window still runs 0.17.86. Reload the window.',
    );
  });

  it('says nothing when this window is current or ahead of what is installed', () => {
    const dir = mkExtensionsDir(['0.17.86', '0.17.87']);
    expect(staleBuildNoticeFor('0.17.87', dir, PREFIX)).toBeUndefined();
    expect(staleBuildNoticeFor('0.18.0', dir, PREFIX)).toBeUndefined();
    expect(staleBuildNoticeFor('0.17.86', mkExtensionsDir(['0.17.86']), PREFIX)).toBeUndefined();
  });
});

describe('detectStaleBuild', () => {
  it('derives the folder prefix from this extension own folder, not from a path', () => {
    const dir = mkExtensionsDir(['0.17.86', '0.17.87']);
    mocks.extension = {
      packageJSON: { version: '0.17.86' },
      extensionPath: path.join(dir, `${PREFIX}0.17.86`),
    };
    expect(detectStaleBuild()).toBe(
      'Forge 0.17.87 is installed; this window still runs 0.17.86. Reload the window.',
    );
  });

  it('says nothing outside a packaged host, where the installed set is unknowable', () => {
    const dir = mkExtensionsDir(['0.17.87']);
    // A development host or an unpacked VSIX: the folder does not carry the
    // running version, so nothing can be concluded about its siblings.
    mocks.extension = {
      packageJSON: { version: '0.17.86' },
      extensionPath: path.join(dir, 'forge-llm'),
    };
    expect(detectStaleBuild()).toBeUndefined();
    mocks.extension = undefined;
    expect(detectStaleBuild()).toBeUndefined();
  });
});

describe('showStaleBuildWarning', () => {
  let showStaleBuildWarning: typeof import('../../src/vscode/staleBuild').showStaleBuildWarning;

  beforeEach(async () => {
    // A fresh module represents a fresh extension host/window.
    vi.resetModules();
    ({ showStaleBuildWarning } = await import('../../src/vscode/staleBuild'));
  });

  it('the warning offers the command that actually fixes it', async () => {
    await showStaleBuildWarning('Forge 0.17.87 is installed; this window still runs 0.17.86.');
    expect(mocks.warnings).toEqual(['Forge 0.17.87 is installed; this window still runs 0.17.86.']);
    expect(mocks.commands).toEqual(['workbench.action.reloadWindow']);
  });

  it('does not reopen a dismissed warning on repeated job or config checks', async () => {
    mocks.warningResult = undefined;
    const notice = staleBuildNoticeFor('0.17.86', mkExtensionsDir(['0.17.87']), PREFIX)!;
    await showStaleBuildWarning(notice);
    await showStaleBuildWarning(notice);
    await showStaleBuildWarning(notice);
    expect(mocks.warnings).toEqual([notice]);
    expect(mocks.commands).toEqual([]);
  });

  it('does not duplicate a warning while its reload action is still pending', async () => {
    let choose!: (picked: string | undefined) => void;
    mocks.warningPromise = new Promise((resolve) => {
      choose = resolve;
    });
    const first = showStaleBuildWarning('pending version notice');
    await showStaleBuildWarning('pending version notice');
    expect(mocks.warnings).toEqual(['pending version notice']);
    choose('Reload Window');
    await first;
    expect(mocks.commands).toEqual(['workbench.action.reloadWindow']);
  });

  it('warns again for a newer installed version, without repeating earlier notices', async () => {
    mocks.warningResult = undefined;
    const dir = mkExtensionsDir(['0.17.86', '0.17.87']);
    const first = staleBuildNoticeFor('0.17.86', dir, PREFIX)!;
    await showStaleBuildWarning(first);
    fs.mkdirSync(path.join(dir, `${PREFIX}0.17.88`));
    const next = staleBuildNoticeFor('0.17.86', dir, PREFIX)!;
    await showStaleBuildWarning(next);
    await showStaleBuildWarning(first);
    expect(mocks.warnings).toEqual([first, next]);
  });

  it('shows the same warning again in a fresh window', async () => {
    mocks.warningResult = undefined;
    await showStaleBuildWarning('version notice');
    vi.resetModules();
    const freshWindow = await import('../../src/vscode/staleBuild');
    await freshWindow.showStaleBuildWarning('version notice');
    expect(mocks.warnings).toEqual(['version notice', 'version notice']);
  });
});

/**
 * The check is only useful where a failure is about to be reported. These rows
 * pin that it is asked at exactly those two points — a scheduled job start, and
 * a config load or write failure — so a stale window cannot be blamed on the
 * config it is validating.
 */
describe('where the check is asked', () => {
  const read = (...parts: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...parts), 'utf8');

  it('a scheduled job start asks it, and a failed run carries the answer', () => {
    const setup = read('vscode', 'jobsSetup.ts');
    expect(setup).toContain('staleWindow: () => {');
    expect(setup).toContain('detectStaleBuild()');
    const runner = read('jobs', 'agentTask.ts');
    expect(runner).toContain('const staleWindow = this.deps.staleWindow?.();');
    expect(runner).toContain('if (failed && staleWindow)');
  });

  it('every config load or write failure reports it too', () => {
    for (const file of [
      ['vscode', 'configBootstrap.ts'],
      ['vscode', 'configReload.ts'],
      ['sidebar', 'modelManager', 'ModelManagerPanel.ts'],
    ] as const) {
      expect(read(...file)).toContain('noticeStaleBuildOnConfigFailure()');
    }
  });
});
