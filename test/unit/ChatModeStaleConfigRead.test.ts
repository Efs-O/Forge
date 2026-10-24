import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';

/**
 * BL-007: `/chatMode` decided which model entry to edit from an **index** into
 * the config it read before the config lock, while `updateConfigFile` reads the
 * file again inside that lock. A second window that added or removed a model in
 * between shifts every index after it, so the mode lands on the wrong model —
 * and the Strata path has no verifier to catch it.
 *
 * Both reads happen inside one synchronous call, so nothing else in this window
 * can change the file between them: the only honest way to make the two reads
 * differ is to mock the loader so the first read is the stale snapshot while the
 * file on disk stays the truth. `verify()` and the reply's context line then read
 * the real file, exactly as they do in a real window.
 */
const reads = vi.hoisted(() => ({ first: true }));

vi.mock('../../src/config/ConfigLoader', async (importOriginal) => {
  const actual = await (importOriginal() as Promise<
    typeof import('../../src/config/ConfigLoader')
  >);
  return {
    ...actual,
    loadConfig: (storagePath: string): ForgeConfig => {
      const config = actual.loadConfig(storagePath);
      if (reads.first) {
        reads.first = false;
        // The snapshot a window would hold if another window had reordered
        // `models:` after it was taken.
        return { ...config, models: [...config.models].reverse() };
      }
      return config;
    },
  };
});

import { runChatModeCommand } from '../../src/config/ChatMode';

const TWO_LLAMA_MODELS = `active_model: llama
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
models:
  - name: llama
    provider: llama.cpp
    gguf_path: /models/llama.gguf
    n_parallel: 1
  - name: other
    provider: llama.cpp
    gguf_path: /models/other.gguf
    n_parallel: 3
`;

// The Strata path is the one with no `verify()`, so a wrong-entry edit there is
// silent: the file just ends up with another model's launcher argument changed.
const TWO_STRATA_MODELS = `active_model: strata
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
models:
  - name: strata
    model: strata
    provider: openai-compatible
    endpoint: http://localhost:3333/v1
    unload_path: /unload
    start_command: [python, start_strata.py, --mode, solo, --port, "8000"]
  - name: strata-b
    model: strata-b
    provider: openai-compatible
    endpoint: http://localhost:3334/v1
    unload_path: /unload
    start_command: [python, start_strata_b.py, --mode, solo, --port, "8001"]
`;

const tempDirs: string[] = [];

function configFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chat-mode-stale-'));
  tempDirs.push(directory);
  const file = path.join(directory, 'config.yaml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function modelsOf(file: string): Array<{ name?: string; n_parallel?: number }> {
  const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
    models: Array<{ name?: string; n_parallel?: number }>;
  };
  return parsed.models;
}

afterEach(() => {
  reads.first = true;
  for (const directory of tempDirs.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('/chatMode when the config changed after the first read', () => {
  it('edits the model it names, not the entry sitting at the stale index', () => {
    // `llama` is first in the file, so the reversed snapshot puts it at index 1.
    const file = configFile(TWO_LLAMA_MODELS);

    const result = runChatModeCommand(file, undefined, 'multi', () => true, 0);

    expect(result.modelName).toBe('llama');
    expect(result.changed).toBe(true);
    const models = modelsOf(file);
    expect(models.find((model) => model.name === 'llama')?.n_parallel).toBe(2);
    // The other entry is the one a stale index would have hit; its own slot
    // count must survive untouched.
    expect(models.find((model) => model.name === 'other')?.n_parallel).toBe(3);
  });

  it('changes only the named Strata launcher entry, where no verifier would notice', () => {
    // `strata` is first in the file, so the reversed snapshot puts it at index 1
    // and the old code would have rewritten `strata-b`'s launcher instead.
    const file = configFile(TWO_STRATA_MODELS);

    const result = runChatModeCommand(file, undefined, 'multi', () => true, 0);

    expect(result.modelName).toBe('strata');
    expect(result.changed).toBe(true);
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      models: Array<{ name?: string; start_command?: string[] }>;
    };
    expect(
      parsed.models.find((model) => model.name === 'strata')?.start_command?.[3],
    ).toBe('multi');
    expect(
      parsed.models.find((model) => model.name === 'strata-b')?.start_command?.[3],
    ).toBe('solo');
  });
});
