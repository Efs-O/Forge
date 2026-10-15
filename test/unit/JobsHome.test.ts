import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { JobsConfigSchema } from '../../src/config/jobsSchema';
import type { ForgeConfig } from '../../src/config/types';
import { homeNote, isHomeWindow } from '../../src/jobs/jobsHome';
import { workspaceIdFor } from '../../src/remote/RemoteWorkspaceHandoff';

function config(homeWorkspace?: string): ForgeConfig {
  return {
    jobs: JobsConfigSchema.parse({
      enabled: true,
      ...(homeWorkspace === undefined ? {} : { home_workspace: homeWorkspace }),
    }),
  } as ForgeConfig;
}

describe('jobs.home_workspace', () => {
  it('preserves current behavior when the field is absent', () => {
    expect(isHomeWindow(config(), 'any-workspace')).toBe(true);
    expect(homeNote(config(), 'any-workspace')).toBeUndefined();
  });

  it('matches only the workspace id for the configured absolute folder', () => {
    const home = path.resolve('forge-home');
    const other = path.resolve('other-workspace');
    const settings = config(home);

    expect(isHomeWindow(settings, workspaceIdFor(home))).toBe(true);
    expect(isHomeWindow(settings, workspaceIdFor(other))).toBe(false);
    expect(homeNote(settings, workspaceIdFor(home))).toBeUndefined();
    expect(homeNote(settings, workspaceIdFor(other))).toBe(
      `Jobs run in the window for ${home}. This one runs there on that window's next tick, or when that folder is next opened.`,
    );
  });

  it('never treats a window without a folder as home when the field is set', () => {
    const settings = config(path.resolve('forge-home'));
    expect(isHomeWindow(settings, undefined)).toBe(false);
    expect(homeNote(settings, undefined)).toContain('Jobs run in the window for');
  });

  it('requires an absolute path and names the field in the validation error', () => {
    const absolute = path.resolve('forge-home');
    expect(JobsConfigSchema.parse({ home_workspace: absolute }).home_workspace).toBe(absolute);

    try {
      JobsConfigSchema.parse({ home_workspace: 'relative/forge-home' });
      throw new Error('expected a relative path to fail validation');
    } catch (error) {
      expect(String(error)).toContain('jobs.home_workspace');
    }
  });
});
