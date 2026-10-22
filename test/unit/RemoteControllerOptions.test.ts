import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { RemoteConfigSchema } from '../../src/config/remoteSchema';
import { buildRemoteControllerOptions } from '../../src/remote/remoteControllerOptions';

function config(remote: Record<string, unknown>) {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: { enabled: true, ...remote },
  });
}

const deps = {
  workspaceId: 'workspace',
  onError: () => undefined,
  voiceOutputEnabled: () => false,
  setVoiceOutput: async () => undefined,
  hasConfigPath: false,
  switchWorkspace: async () => undefined,
};

describe('remote.unlock_backlog_max', () => {
  it('defaults to five and accepts only integers from one through fifty', () => {
    expect(RemoteConfigSchema.parse({}).unlock_backlog_max).toBe(5);
    expect(RemoteConfigSchema.parse({ unlock_backlog_max: 1 }).unlock_backlog_max).toBe(1);
    expect(RemoteConfigSchema.parse({ unlock_backlog_max: 50 }).unlock_backlog_max).toBe(50);
    expect(RemoteConfigSchema.safeParse({ unlock_backlog_max: 0 }).success).toBe(false);
    expect(RemoteConfigSchema.safeParse({ unlock_backlog_max: 51 }).success).toBe(false);
    expect(RemoteConfigSchema.safeParse({ unlock_backlog_max: 2.5 }).success).toBe(false);
  });

  it('maps the live config value into RemoteControllerOptions', () => {
    expect(buildRemoteControllerOptions(config({}), deps).unlockBacklogMax).toBe(5);
    expect(buildRemoteControllerOptions(config({ unlock_backlog_max: 17 }), deps).unlockBacklogMax)
      .toBe(17);
  });
});
