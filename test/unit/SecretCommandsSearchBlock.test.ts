import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as YAML from 'yaml';
import { loadConfig } from '../../src/config/ConfigLoader';
import { addSearchBlock } from '../../src/vscode/secretCommands';

/**
 * `Forge: Set Search API Key` writes the `search:` block that the key it is
 * about to store belongs to. `search` is a POLICY key (`policySchema.ts`), so
 * the block has to land in whichever file owns that key today: once the owner
 * has run the migration, `~/.forge/policy.yaml` exists and the loader refuses a
 * `config.yaml` that holds a policy key at all (`assertConfigFileKeys`). The
 * command used to append the block to `config.yaml` with `fs.appendFileSync`,
 * which broke the config on exactly those installs.
 *
 * Every case passes `policyPath` into the temp folder, so nothing here reads or
 * writes the owner's real `~/.forge`.
 */

const CONFIG = `active_model: test
models:
  - name: test
    provider: ollama
    endpoint: http://127.0.0.1:11434
`;

const POLICY = `permissions:
  approval_timeout_minutes: 15
`;

const BLOCK = { provider: 'tavily', secret_key_name: 'tavily', max_results: 5 };

const parse = (filePath: string): Record<string, unknown> =>
  YAML.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;

describe('addSearchBlock', () => {
  let directory: string;
  let configPath: string;
  let policyPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-secret-commands-'));
    configPath = path.join(directory, 'config.yaml');
    policyPath = path.join(directory, 'policy.yaml');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('adds the block to config.yaml while no policy file exists', () => {
    fs.writeFileSync(configPath, CONFIG);

    addSearchBlock(configPath, 'tavily', 'tavily', { policyPath });

    const written = parse(configPath);
    expect(written.search).toEqual(BLOCK);
    // Everything the file already said stays as it was.
    const untouched = { ...written };
    delete untouched.search;
    expect(untouched).toEqual({
      active_model: 'test',
      models: [{ name: 'test', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    });
    expect(fs.existsSync(policyPath)).toBe(false);
    expect(loadConfig(directory, { policyPath }).search).toEqual(BLOCK);
  });

  it('adds the block to policy.yaml once the owner has that file, leaving config.yaml alone', () => {
    fs.writeFileSync(configPath, CONFIG);
    fs.writeFileSync(policyPath, POLICY);
    const configBefore = fs.readFileSync(configPath, 'utf8');

    addSearchBlock(configPath, 'tavily', 'forge.tavily.apiKey', { policyPath });

    // The byte-exact check is the point: a `search:` key left in config.yaml is
    // the state the loader refuses, and a policy key in both files is a load
    // error too.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('search');
    const policy = parse(policyPath);
    expect(policy.search).toEqual({
      provider: 'tavily',
      secret_key_name: 'forge.tavily.apiKey',
      max_results: 5,
    });
    const policyUntouched = { ...policy };
    delete policyUntouched.search;
    expect(policyUntouched).toEqual({ permissions: { approval_timeout_minutes: 15 } });
    const loaded = loadConfig(directory, { policyPath });
    expect(loaded.search?.provider).toBe('tavily');
    expect(loaded.permissions?.approval_timeout_minutes).toBe(15);
  });

  it('changes neither file when the target already has a search block', () => {
    fs.writeFileSync(configPath, CONFIG);
    fs.writeFileSync(
      policyPath,
      `${POLICY}search:
  provider: tavily
  secret_key_name: mine
  max_results: 3
`,
    );
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const policyBefore = fs.readFileSync(policyPath, 'utf8');

    addSearchBlock(configPath, 'tavily', 'forge.tavily.apiKey', { policyPath });

    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(policyPath, 'utf8')).toBe(policyBefore);
    expect(parse(policyPath).search).toEqual({
      provider: 'tavily',
      secret_key_name: 'mine',
      max_results: 3,
    });
  });
});
