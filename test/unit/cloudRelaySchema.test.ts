import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';

type Model = Record<string, unknown>;

function parse(model: Model, cloudRelay: Record<string, unknown>) {
  return ForgeConfigSchema.safeParse({
    models: [model],
    active_model: model.name,
    cloud_relay: cloudRelay,
    model_starter: { enabled: false, port: 8798, shared_ports: [8090] },
    llama_server: { port: 8080, binary: 'llama-server' },
  });
}

function issues(result: ReturnType<typeof parse>): string {
  return JSON.stringify(result.success ? [] : result.error.issues);
}

describe('cloud_relay config schema', () => {
  it('applies the documented relay defaults', () => {
    const parsed = parse(
      { name: 'cloud', provider: 'openrouter', api_key_secret: 'test.secret.reference' },
      { models: ['cloud'] },
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.cloud_relay).toEqual({
      enabled: false,
      port: 8797,
      max_body_mb: 32,
      models: ['cloud'],
    });
  });

  it('refuses port clashes with :8799 and :8798', () => {
    const control = ForgeConfigSchema.safeParse({
      models: [{ name: 'cloud', provider: 'openai', api_key_secret: 'test.ref' }],
      active_model: 'cloud',
      cloud_relay: { enabled: false, port: 8799, models: ['cloud'] },
    });
    expect(issues(control as ReturnType<typeof parse>)).toContain('must differ from control_server.port');
    const starter = parse(
      { name: 'cloud', provider: 'openai', api_key_secret: 'test.ref' },
      { enabled: false, port: 8798, models: ['cloud'] },
    );
    expect(issues(starter)).toContain('must differ from model_starter.port');
  });

  it('refuses keyless compatible, non-cloud Ollama and remote Ollama entries', () => {
    // A name whose model has been deleted is NOT a schema error: the whole
    // config used to be refused for it, so one stale entry blocked every
    // config write (the 2026-10-27 llama.cpp switch). It survives the parse so
    // `findLeftoverModelRefs` can name it, and the relay refuses a request for
    // it with the reason. `CloudRelayRoutes.test.ts` covers that refusal.
    const stale = parse(
      { name: 'cloud', provider: 'openai', api_key_secret: 'test.ref' },
      { models: ['missing'] },
    );
    expect(stale.success).toBe(true);
    if (stale.success) expect(stale.data.cloud_relay?.models).toEqual(['missing']);
    const keyless = parse(
      { name: 'compatible', provider: 'openai-compatible', endpoint: 'https://api.example.test' },
      { models: ['compatible'] },
    );
    expect(issues(keyless)).toContain('keyed cloud provider');
    // The type check stays strict: a model that IS configured but is not a
    // cloud model is still a hard error, because this list is a security
    // allowlist, not a preference.
    const nonCloud = parse(
      { name: 'ollama-local', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      { models: ['ollama-local'] },
    );
    expect(issues(nonCloud)).toContain('Ollama cloud model');
    const dashCloud = parse(
      { name: 'gemma4:31b-cloud', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      { models: ['gemma4:31b-cloud'] },
    );
    expect(dashCloud.success).toBe(true);
    const remote = parse(
      { name: 'ollama-cloud:cloud', provider: 'ollama', endpoint: 'http://192.0.2.8:11434' },
      { models: ['ollama-cloud:cloud'] },
    );
    expect(issues(remote)).toContain('loopback endpoint');
  });

  it('requires a non-empty allowlist', () => {
    const empty = parse(
      { name: 'cloud', provider: 'xai' },
      { models: [] },
    );
    expect(empty.success).toBe(false);
  });
});
