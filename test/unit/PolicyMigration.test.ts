import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/ConfigLoader';
import { defaultPolicyPath } from '../../src/config/PolicyLoader';
import { runPolicyMigration } from '../../src/config/policyMigration';
import { resolveRequestModel, resolveSpawnModel } from '../../src/config/ConfigResolver';

/**
 * The migration, tested on fixture copies only — never on the owner's live
 * `~/.forge/policy.yaml`, which is why every call passes `policyPath`.
 *
 * The assertions that matter are the ones a rewrite-from-an-object implementation
 * would fail: comments survive the move, models that start the same program share
 * one engine, the backup holds the original bytes, a policy file that already
 * exists is never overwritten, and the migrated pair resolves to the same models
 * it resolved to before the split.
 */

const tempDirs: string[] = [];

function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-'));
  tempDirs.push(dir);
  return dir;
}

function policyIn(home: string): string {
  const policyPath = defaultPolicyPath(home);
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  return policyPath;
}

const NOW = new Date(2026, 10, 2, 6, 35, 12); // 20261102-063512

/** The owner's shape: comments that explain themselves, a Strata entry that owns
 *  its launcher, three llama.cpp models in one group (two of them sharing a
 *  binary, one on a patched fork), and a tailnet model that is not loopback. */
const OWNER_CONFIG = `# Forge config — the owner's file.
x_shared:
  &ctx 131072

# The permissions are the owner's, not the agent's.
permissions:
  fs:
    write: true
    read: true
  # Cards wait twenty minutes before the owner is asked to settle one.
  approval_timeout_minutes: 20

llama_server:
  # Pinned after the MTP fork started crashing on load.
  binary: 'C:/Forge/llama.cpp-b10430/llama-server.exe'
  default_num_ctx: 131072

jobs:
  enabled: true
  home_workspace: 'N:/vs code apps/Forge'

# Which browser the browser tools drive, and what it may reach.
browser:
  channel: msedge
  headless: true
  allowed_origins: ['https://docs.example.com']

# The commands the owner forbids outright, and how long a run gets.
exec:
  timeout_ms: 45000
  denylist_extra: ['Remove-Item', 'del']

# Which service the agent's search reaches, and which token it sends there.
search:
  provider: duckduckgo
  fallback: tavily
  secret_key_name: TAVILY_API_KEY

image_search:
  provider: serpapi_lens
  secret_key_name: SERPAPI_LENS_KEY
  confirm_upload: true

mcp_servers:
  - name: notes
    command: node
    args: ['M:/notes/server.js']

active_model: strata
groups:
  # Groups are model tuning, not a program Forge runs, so they stay in config.yaml
  # — and an engine is named after them, which is why the names matter.
  strata-8090:
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
  llamacpp-b10430:
    provider: llama.cpp
models:
  # Strata serves two chats at once; the launcher decides the mode.
  - name: strata
    provider: openai-compatible
    endpoint: http://127.0.0.1:8081
    group: strata-8090
    # Detached launch; the 4th item is the solo/multi switch.
    start_command:
      - 'python'
      - 'N:/Strata/start_strata.py'
      - '--config'
      - 'N:/Strata/strata-iq3_s-2gpu.json'
      - solo
    stop_command:
      - 'python'
      - 'N:/Strata/stop_strata.py'
    unload_path: /unload
    stop_on_exit: true
  - name: maya
    provider: llama.cpp
    gguf_path: 'M:/models/maya.gguf'
    group: llamacpp-b10430
    llama_server_binary: 'C:/Forge/llama.cpp-b10430/llama-server.exe'
    num_ctx: *ctx
  - name: glm
    provider: llama.cpp
    gguf_path: 'M:/models/glm.gguf'
    group: llamacpp-b10430
    llama_server_binary: 'C:/Forge/llama.cpp-b10430/llama-server.exe'
  # The unsloth fork is a different program, so it cannot share the group engine.
  - name: fork
    provider: llama.cpp
    gguf_path: 'M:/models/fork.gguf'
    group: llamacpp-b10430
    llama_server_binary: 'C:/Forge/llama.cpp-unsloth/llama-server.exe'
  - name: phone
    provider: openai-compatible
    endpoint: http://100.64.0.10:8080
`;

function writeFixture(): { configPath: string; policyPath: string } {
  const dir = mkDir();
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(configPath, OWNER_CONFIG, 'utf8');
  return { configPath, policyPath: policyIn(mkDir()) };
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('Forge: Move security settings to policy.yaml', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves every policy key, keeps the config-side keys, and reports what moved', () => {
    const { configPath, policyPath } = writeFixture();
    const result = runPolicyMigration(configPath, { policyPath, now: NOW });

    expect(result.movedKeys).toEqual(
      expect.arrayContaining([
        'permissions',
        'llama_server',
        'jobs',
        'mcp_servers',
        'browser',
        'exec',
        'search',
        'image_search',
      ]),
    );
    const policy = read(policyPath);
    const config = read(configPath);
    for (const key of [
      'permissions:',
      'llama_server:',
      'jobs:',
      'mcp_servers:',
      'browser:',
      'exec:',
      'search:',
      'image_search:',
    ]) {
      expect(policy).toContain(key);
      expect(config).not.toContain(key);
    }
    // The keys that tune models stay where an agent can edit them from phase 3 on.
    for (const key of ['active_model:', 'x_shared:', 'models:', 'group: llamacpp-b10430']) {
      expect(config).toContain(key);
    }
  });

  it('moves the comments with the block, because they are the reason it works', () => {
    const { configPath, policyPath } = writeFixture();
    runPolicyMigration(configPath, { policyPath, now: NOW });
    const policy = read(policyPath);
    expect(policy).toContain("The permissions are the owner's, not the agent's");
    expect(policy).toContain('Cards wait twenty minutes');
    expect(policy).toContain('Pinned after the MTP fork started crashing');
    // A model's launcher comment travels into the engine entry it became.
    expect(policy).toContain('the 4th item is the solo/multi switch');
    expect(read(configPath)).toContain('Strata serves two chats at once');
  });

  it('gives models that start the same program one engine and names each model after it', () => {
    const { configPath, policyPath } = writeFixture();
    const result = runPolicyMigration(configPath, { policyPath, now: NOW });
    const config = loadConfig(path.dirname(configPath), { policyPath });
    const engines = config.engines ?? {};

    expect(Object.keys(engines)).toEqual(['strata-8090', 'llamacpp-b10430', 'llamacpp-b10430-2']);
    expect(engines['strata-8090']?.start_command).toEqual([
      'python',
      'N:/Strata/start_strata.py',
      '--config',
      'N:/Strata/strata-iq3_s-2gpu.json',
      'solo',
    ]);
    expect(engines['strata-8090']?.unload_path).toBe('/unload');
    const byName = new Map(config.models.map((model) => [model.name, model]));
    // `maya` and `glm` share one engine; the fork cannot, so it got the next name.
    expect(byName.get('maya')?.engine).toBe('llamacpp-b10430');
    expect(byName.get('glm')?.engine).toBe('llamacpp-b10430');
    expect(byName.get('fork')?.engine).toBe('llamacpp-b10430-2');
    expect(byName.get('strata')?.engine).toBe('strata-8090');
    // `stop_on_exit` is a model's own choice about its own lifecycle, not a
    // program Forge runs, so it stays on the model.
    expect(byName.get('strata')?.stop_on_exit).toBe(true);
    expect(byName.get('strata')?.start_command).toBeUndefined();
    expect(result.engines.find((row) => row.name === 'llamacpp-b10430-2')?.renamedFrom).toBe(
      'llamacpp-b10430',
    );
    expect(result.engines.find((row) => row.name === 'llamacpp-b10430')?.models).toEqual([
      'maya',
      'glm',
    ]);
  });

  it('resolves the same models after the split as before it', () => {
    const { configPath, policyPath } = writeFixture();
    const before = loadConfig(path.dirname(configPath), {
      policyPath: path.join(path.dirname(configPath), 'absent-policy.yaml'),
    });
    runPolicyMigration(configPath, { policyPath, now: NOW });
    const after = loadConfig(path.dirname(configPath), { policyPath });

    for (const name of ['strata', 'maya', 'glm', 'fork', 'phone']) {
      expect(resolveRequestModel(after, name)).toEqual(resolveRequestModel(before, name));
      expect(resolveSpawnModel(after, name)).toEqual(resolveSpawnModel(before, name));
    }
    expect(after.agent_links).toEqual(before.agent_links);
  });

  it('writes the original bytes to a timestamped backup before touching either file', () => {
    const { configPath, policyPath } = writeFixture();
    const result = runPolicyMigration(configPath, { policyPath, now: NOW });
    expect(path.basename(result.backupPath)).toBe('config.yaml.pre-policy-20261102-063512');
    expect(read(result.backupPath)).toBe(OWNER_CONFIG);
  });

  it('refuses to overwrite a policy.yaml that already says something else, writing nothing', () => {
    const { configPath, policyPath } = writeFixture();
    // A key config.yaml does not have at all, so the refusal is about the policy
    // file's own content and not about one file disagreeing with the other.
    fs.writeFileSync(policyPath, '# what the owner wrote by hand last week\nmodel_hosts:\n  - 198.51.100.7\n', 'utf8');
    const configBefore = read(configPath);
    const policyBefore = read(policyPath);
    expect(() => runPolicyMigration(configPath, { policyPath, now: NOW })).toThrow(
      /already exists with different content/,
    );
    expect(read(configPath)).toBe(configBefore);
    expect(read(policyPath)).toContain('what the owner wrote by hand last week');
    expect(fs.readdirSync(path.dirname(configPath))).toEqual(['config.yaml']);
  });

  it('refuses when the two files define the same key with different values', () => {
    const { configPath, policyPath } = writeFixture();
    fs.writeFileSync(policyPath, 'jobs:\n  enabled: false\n', 'utf8');
    expect(() => runPolicyMigration(configPath, { policyPath, now: NOW })).toThrow(
      /both define "jobs" with different values/,
    );
  });

  it('a crash after the policy write leaves a loadable-by-name pair, and a re-run finishes it', () => {
    const { configPath, policyPath } = writeFixture();
    const first = runPolicyMigration(configPath, { policyPath, now: NOW });
    const policyAfterFirst = read(policyPath);
    // Simulate the crash: config.yaml goes back to what it was, policy.yaml stays.
    fs.writeFileSync(configPath, read(first.backupPath), 'utf8');
    // The intermediate state is the one the loader refuses, by name.
    expect(() => loadConfig(path.dirname(configPath), { policyPath })).toThrow(/in both/);

    const second = runPolicyMigration(configPath, { policyPath, now: NOW });
    expect(second.policyWritten).toBe(false);
    expect(second.alreadyInPolicy).toEqual(
      expect.arrayContaining(['permissions', 'llama_server', 'jobs']),
    );
    expect(read(policyPath)).toBe(policyAfterFirst);
    expect(read(configPath)).not.toContain('permissions:');
    expect(() => loadConfig(path.dirname(configPath), { policyPath })).not.toThrow();
  });

  it('writes model_hosts with the non-loopback hosts the models already talk to', () => {
    const { configPath, policyPath } = writeFixture();
    const result = runPolicyMigration(configPath, { policyPath, now: NOW });
    expect(result.model_hosts).toEqual(['100.64.0.10']);
    const config = loadConfig(path.dirname(configPath), { policyPath });
    expect(config.model_hosts).toEqual(['100.64.0.10']);
  });

  it('refuses a policy block that uses an anchor staying in config.yaml', () => {
    const dir = mkDir();
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `x_shared:
  &perm_fs { write: true }
permissions:
  fs: *perm_fs
models: []
`,
      'utf8',
    );
    const policyPath = policyIn(mkDir());
    expect(() => runPolicyMigration(configPath, { policyPath, now: NOW })).toThrow(
      /anchor \*perm_fs/,
    );
    expect(fs.existsSync(policyPath)).toBe(false);
  });

  it('leaves an engine a model already names on the engine it names, on a re-run', () => {
    const { configPath, policyPath } = writeFixture();
    runPolicyMigration(configPath, { policyPath, now: NOW });
    // A crash that lost only the model-side edits: the engine names must not churn.
    const policy = read(policyPath);
    fs.writeFileSync(configPath, OWNER_CONFIG, 'utf8');
    const again = runPolicyMigration(configPath, { policyPath, now: NOW });
    expect(again.policyWritten).toBe(false);
    expect(read(policyPath)).toBe(policy);
  });
});
