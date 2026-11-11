import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/ConfigLoader';
import { defaultPolicyPath } from '../../src/config/PolicyLoader';

const showWarningMessage = vi.fn();

vi.mock('vscode', () => ({
  workspace: { openTextDocument: async (uri: { fsPath: string }) => ({ uri }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  window: {
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    showTextDocument: async (document: { uri?: { fsPath?: string } }) => document,
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

const tempDirs: string[] = [];

function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-'));
  tempDirs.push(dir);
  return dir;
}

/** A config.yaml + policy.yaml pair in two temp dirs (the policy file is
 *  machine-wide, so it does not sit beside the fixture config). */
function pair(configText: string, policyText?: string): { configDir: string; policyPath: string } {
  const configDir = mkDir();
  fs.writeFileSync(path.join(configDir, 'config.yaml'), configText, 'utf8');
  const home = mkDir();
  const policyPath = defaultPolicyPath(home);
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  if (policyText !== undefined) fs.writeFileSync(policyPath, policyText, 'utf8');
  return { configDir, policyPath };
}

const BASE_CONFIG = `active_model: z-cloud
models:
  - name: z-cloud
    provider: ollama
    endpoint: http://127.0.0.1:11434
`;

describe('policy.yaml beside config.yaml (phase 2 loads it, phase 3 enforces it)', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    showWarningMessage.mockClear();
  });

  it('the stubbed default keeps a unit test out of the real policy file', () => {
    // `test/support/tempGuard.setup.ts` stubs `defaultPolicyPath` for every test
    // file, because the policy file is machine-wide: without the stub, a test
    // that calls `loadConfig(dir)` with no `policyPath` would read whatever the
    // owner has in `~/.forge/policy.yaml` after running the migration, and every
    // config test would start testing their permissions instead of the fixture's.
    // If the stub stops applying, this fails out loud rather than quietly.
    const fallback = defaultPolicyPath();
    expect(path.basename(fallback)).toBe('policy.yaml');
    expect(fallback.startsWith(os.tmpdir())).toBe(true);
    expect(fallback).not.toBe(defaultPolicyPath(os.homedir()));
  });

  it('loads a policy key that lives only in policy.yaml', () => {
    const { configDir, policyPath } = pair(
      BASE_CONFIG,
      `# The owner's permissions, not the agent's.
permissions:
  fs:
    write: true
    read: true
`,
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.permissions?.fs?.write).toBe(true);
  });

  it('refuses a leftover clanker policy key with the removed-key error', () => {
    const { configDir, policyPath } = pair(BASE_CONFIG, 'clanker: {}\n');
    const accepted =
      'permissions, approvals, fetch, exec, browser, search, image_search, agent_bus, agent_links, control_server, cloud_relay, model_starter, remote, jobs, mcp_servers, extra_file_roots, templates_dir, llama_server, ollama, image_generation, voice, engines, model_hosts';
    expect(() => loadConfig(configDir, { policyPath })).toThrow(
      `Forge: policy.yaml has "clanker", which policy.yaml accepts only: ${accepted} (${policyPath}).`,
    );
  });

  it('still accepts a policy key from config.yaml while there is no policy file', () => {
    // The un-migrated state has to keep loading, or a fresh install cannot start and
    // an owner who has not run the command yet finds Forge refusing to read their
    // config at all. `pair` with no policy text creates the folder but not the file.
    const { configDir, policyPath } = pair(
      `${BASE_CONFIG}permissions:\n  fs:\n    write: true\n`,
      undefined,
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.permissions?.fs?.write).toBe(true);
    expect(fs.existsSync(policyPath)).toBe(false);
  });

  it('refuses a policy key in config.yaml once the policy file exists, naming both', () => {
    // The same config that loaded a moment ago now fails, and the difference is the
    // other file — which is exactly what an owner needs to see, because the key was
    // not in the wrong place until the split happened.
    const { configDir, policyPath } = pair(
      `${BASE_CONFIG}permissions:\n  fs:\n    write: true\n`,
      '# the owner made this file by hand, and it is empty\n',
    );
    expect(() => loadConfig(configDir, { policyPath })).toThrow(/config\.yaml holds 1 policy key/);
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('permissions');
      expect(message).toContain(policyPath);
      expect(message).toContain('Move security settings to policy.yaml');
      expect(message).toContain(configDir);
    }
  });

  it('refuses a program-named field outside models once the policy file exists', () => {
    // The rule is by name, not by location, so a later phase that adds
    // `video.ffmpeg_binary` to config.yaml is refused by the same check that
    // refuses a model's `start_command` — nobody has to remember to add the name.
    const { configDir, policyPath } = pair(
      `${BASE_CONFIG}video:\n  ffmpeg_binary: V:/Tools/ffmpeg.exe\n`,
      '# empty policy\n',
    );
    expect(() => loadConfig(configDir, { policyPath })).toThrow(/video\.ffmpeg_binary/);
  });

  it('lets a policy block keep its own program names in config.yaml before the move', () => {
    // `llama_server.binary` has always lived in config.yaml. Before the owner
    // migrates it is still the only place it can live, and refusing it here would
    // make every un-migrated install fail to load for a field that is not new.
    const { configDir, policyPath } = pair(
      `${BASE_CONFIG}llama_server:\n  binary: llama-server\n`,
      undefined,
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.llama_server.binary).toBe('llama-server');
  });

  it('refuses a model endpoint on a host that is not in model_hosts', () => {
    const { configDir, policyPath } = pair(
      `active_model: tail\nmodels:\n  - name: tail\n    provider: openai-compatible\n    endpoint: http://100.64.0.10:8080\n`,
      '# empty policy\n',
    );
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('model "tail"');
      expect(message).toContain('100.64.0.10');
      expect(message).toContain('model_hosts');
      expect(message).toContain('Move security settings to policy.yaml');
    }
  });

  it('allows that host once model_hosts names it, and never asks about loopback', () => {
    const { configDir, policyPath } = pair(
      `active_model: tail\nmodels:\n  - name: tail\n    provider: openai-compatible\n    endpoint: http://100.64.0.10:8080\n`,
      'model_hosts:\n  - 100.64.0.10\n',
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.model_hosts).toEqual(['100.64.0.10']);
    // 127.0.0.0/8 whole, not only 127.0.0.1: a server on 127.0.0.2 reaches nothing
    // an agent could leak to, and asking about it would be a wall with no door.
    const elsewhere = pair(
      `active_model: other\nmodels:\n  - name: other\n    provider: openai-compatible\n    endpoint: http://127.0.0.2:8085\n`,
      '# empty policy\n',
    );
    expect(loadConfig(elsewhere.configDir, { policyPath: elsewhere.policyPath }).models[0]?.name).toBe(
      'other',
    );
  });

  it('refuses a key that is in both files, naming the key and both paths', () => {
    const { configDir, policyPath } = pair(
      `${BASE_CONFIG}permissions:\n  fs:\n    write: true\n`,
      `permissions:\n  fs:\n    write: true\n`,
    );
    expect(() => loadConfig(configDir, { policyPath })).toThrow(
      new RegExp(`"permissions" in both[\\s\\S]*${path.basename(policyPath)}`),
    );
    try {
      loadConfig(configDir, { policyPath });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(path.join(path.dirname(policyPath), 'policy.yaml'));
      expect(message).toContain(path.join(configDir, 'config.yaml'));
      expect(message).toContain('Move security settings to policy.yaml');
      expect(message).toContain('does not merge');
    }
  });

  it('refuses a config.yaml-only key pasted into policy.yaml', () => {
    const { configDir, policyPath } = pair(BASE_CONFIG, 'active_model: z-cloud\n');
    expect(() => loadConfig(configDir, { policyPath })).toThrow(/belongs in config\.yaml/);
  });

  it('lists what policy.yaml accepts when the key is not recognised at all', () => {
    const { configDir, policyPath } = pair(BASE_CONFIG, 'wibble: 1\n');
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('policy.yaml accepts only');
      expect(message).toContain('model_hosts');
      expect(message).toContain('engines');
    }
  });

  it('names policy.yaml, not config.yaml, when the bad value is in the policy file', () => {
    const { configDir, policyPath } = pair(BASE_CONFIG, 'permissions:\n  approval_timeout_minutes: soon\n');
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('policy.yaml');
      expect(message).toContain('approval_timeout_minutes');
      // The line that names the file names the POLICY file: an owner told
      // "config.yaml is invalid" goes looking in the wrong file first.
      expect(message.split('\n')[1]).toContain('policy.yaml: permissions');
      expect(message.split('\n')[1]).not.toContain('config.yaml');
      expect(message).toContain(policyPath);
    }
  });

  it('refuses a permissions key Forge removed, by name, from the policy file', () => {
    // Zod drops unknown keys by default, so a deleted key left in the owner's
    // file would sit there doing nothing while still reading as if it configured
    // something. `permissionsSchema.ts` carries unknown keys to its refine for
    // exactly this, and `permissions` is read from both files, so one refusal
    // covers config.yaml and policy.yaml.
    const { configDir, policyPath } = pair(BASE_CONFIG, 'permissions:\n  approval_stand_in:\n    model: keep\n');
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(
        'permissions.approval_stand_in was removed in Forge 0.17.117 (the approval stand-in no longer exists). Delete it from policy.yaml.',
      );
      expect(message).toContain(policyPath);
    }
  });

  it('does not treat x_shared in both files as a duplicate key', () => {
    const { configDir, policyPath } = pair(
      `x_shared:\n  &ctx 131072\n${BASE_CONFIG}`,
      'x_shared:\n  &pctx true\n',
    );
    expect(() => loadConfig(configDir, { policyPath })).not.toThrow();
  });

  it('refuses an unknown engine at load, naming the model and the engine', () => {
    const { configDir, policyPath } = pair(
      `active_model: strata
models:
  - name: strata
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
    engine: strata-8090
`,
      `engines:
  other-engine:
    unload_path: /unload
`,
    );
    expect(() => loadConfig(configDir, { policyPath })).toThrow(
      /model "strata" names engine "strata-8090"/,
    );
  });

  it('warns about model-level exec fields while there is no policy file', () => {
    // The un-migrated state keeps the old shape working: the field is still there,
    // still used, and only warned about — refusing it here would stop every install
    // that has not run the migration from starting its servers at all.
    const { configDir, policyPath } = pair(
      `active_model: strata
groups:
  strata-8090:
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
models:
  - name: strata
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
    group: strata-8090
    start_command: ['python', 'N:/Strata/start_strata.py', '--config', 'x', 'solo']
    unload_path: /unload
`,
      undefined,
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.models[0]?.start_command).toBeDefined();
    const warning = String(showWarningMessage.mock.calls[0]?.[0] ?? '');
    expect(warning).toContain('engine "strata-8090"');
    expect(warning).toContain('Move security settings to policy.yaml');
  });

  it('refuses a model-level exec field in config.yaml once the policy file exists', () => {
    // The acceptance criterion the plan names: adding `start_command` to a
    // config.yaml model now fails the load, and says where it belongs. From phase 3
    // an agent can edit config.yaml, and a model that could name its own
    // `start_command` would let that agent point Forge at any program on this
    // machine — which is why the engine lives in the owner's file.
    const { configDir, policyPath } = pair(
      `active_model: strata
models:
  - name: strata
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
    start_command: ['python', 'N:/Strata/start_strata.py']
    stop_command: ['python', 'N:/Strata/stop_strata.py']
    unload_path: /unload
    stop_on_exit: true
`,
      '# the owner made this file by hand\n',
    );
    try {
      loadConfig(configDir, { policyPath });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('model "strata"');
      expect(message).toContain('start_command');
      expect(message).toContain('unload_path');
      expect(message).toContain(policyPath);
      expect(message).toContain('Move security settings to policy.yaml');
      expect(message).toContain(configDir);
    }
  });

  it('accepts the same model when its programs live in an engine', () => {
    // The state the migration produces: the model says `engine:`, the engine names
    // the programs, and the load succeeds with the same resolved server.
    const { configDir, policyPath } = pair(
      `active_model: strata
models:
  - name: strata
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
    engine: strata-8090
    stop_on_exit: true
`,
      `engines:
  strata-8090:
    start_command: ['python', 'N:/Strata/start_strata.py']
    stop_command: ['python', 'N:/Strata/stop_strata.py']
    unload_path: /unload
`,
    );
    const config = loadConfig(configDir, { policyPath });
    expect(config.models[0]?.engine).toBe('strata-8090');
  });
});
