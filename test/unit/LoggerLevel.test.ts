/**
 * `forge.logLevel` is contributed in package.json and shows up in the settings
 * UI, but nothing read it until 0.13.0: a user who set it to `debug` silently
 * got `info`. That was found the hard way — a debug line the two-window smoke
 * test relied on never appeared, on a machine where the setting said `debug`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { value: undefined as string | undefined };
const lines: string[] = [];

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => lines.push(line),
      dispose: () => {},
      show: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => settings.value }),
  },
}));

const { initLogger, getLogger } = await import('../../src/util/logger');

describe('forge.logLevel', () => {
  beforeEach(() => {
    lines.length = 0;
    getLogger().setLevel('info');
  });

  it('raises verbosity so debug lines reach the channel', () => {
    settings.value = 'debug';
    initLogger(undefined);
    getLogger().debug('reclaimed stale runtime lease');
    expect(lines.some((l) => l.includes('reclaimed stale runtime lease'))).toBe(true);
  });

  it('leaves debug lines suppressed at the default level', () => {
    settings.value = undefined;
    initLogger(undefined);
    getLogger().debug('invisible');
    expect(lines).toHaveLength(0);
  });

  it('ignores a value that is not a level rather than throwing', () => {
    settings.value = 'verbose';
    initLogger(undefined);
    getLogger().debug('invisible');
    getLogger().warn('visible');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('visible');
  });
});
