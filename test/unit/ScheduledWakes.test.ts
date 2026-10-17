import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnAndWait } = vi.hoisted(() => ({ spawnAndWait: vi.fn() }));

vi.mock('../../src/util/processSpawn', () => ({ spawnAndWait }));

import { PowerControl, SCHEDULED_WAKE_TASK_NAME } from '../../src/system/PowerControl';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

describe('PowerControl.setScheduledWakes', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    spawnAndWait.mockReset();
    spawnAndWait.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  afterEach(() => Object.defineProperty(process, 'platform', platform));

  it('deletes the recurring task instead of registering invalid XML for an empty list', async () => {
    await new PowerControl().setScheduledWakes([]);

    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.stringMatching(/\\System32\\schtasks\.exe$/i),
      ['/delete', '/tn', SCHEDULED_WAKE_TASK_NAME, '/f'],
      expect.any(String),
      10_000,
    );
  });
});

describe('PowerControl task deletion (U14-03)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    spawnAndWait.mockReset();
  });

  afterEach(() => Object.defineProperty(process, 'platform', platform));

  it('reports a missing one-shot task as nothing armed', async () => {
    spawnAndWait.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
    await expect(new PowerControl().clearWakeTimer()).resolves.toBe(false);
  });

  it('throws when the delete fails and the task is still there', async () => {
    spawnAndWait
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await expect(new PowerControl().setScheduledWakes([])).rejects.toThrow('Access is denied');
  });
});
