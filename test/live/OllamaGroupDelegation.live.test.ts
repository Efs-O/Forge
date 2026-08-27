import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendPool } from '../../src/backend/BackendPool';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { ForgeConfig } from '../../src/config/types';

/**
 * Live: delegation to an Ollama model whose `provider: ollama` is inherited
 * from a group, with `shared_runtime` on — the shape every model in the user's
 * config.yaml has. Needs a running Ollama daemon with llama3.1:8b pulled.
 *
 *   FORGE_LIVE_OLLAMA=1 npx vitest run test/live/OllamaGroupDelegation.live.test.ts
 *
 * The bug under test: BackendPool classifies models by the RAW config entry,
 * pre group-merge, so a group-inherited Ollama model is taken for llama.cpp and
 * dragged through the shared-runtime key derivation, which demands a gguf_path.
 */

const LIVE = process.env['FORGE_LIVE_OLLAMA'] === '1';
const ENDPOINT = process.env['FORGE_LIVE_OLLAMA_ENDPOINT'] ?? 'http://127.0.0.1:11434';
const MODEL = process.env['FORGE_LIVE_OLLAMA_MODEL'] ?? 'llama3.1:8b';

let registryRoot: string;

function makeConfig(): ForgeConfig {
  return {
    models: [
      // The shape under test: provider comes from the group, not the entry.
      { name: MODEL, num_ctx: 8192, group: 'ollama-local' },
      // A resident llama.cpp model, so the pool has a slot table to reason about.
      { name: 'primary-llamacpp', gguf_path: 'N:/nonexistent/primary.gguf', num_ctx: 4096 },
    ],
    groups: { 'ollama-local': { provider: 'ollama', endpoint: ENDPOINT } },
    active_model: 'primary-llamacpp',
    llama_server: { binary: 'llama-server', port: 8080, n_parallel: 1 },
    shared_runtime: { enabled: true },
    max_simultaneous_models: 4,
  } as ForgeConfig;
}

beforeAll(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-shared-'));
});

afterAll(() => {
  fs.rmSync(registryRoot, { recursive: true, force: true });
});

describe.skipIf(!LIVE)('live: group-inherited Ollama delegation', () => {
  it('auto-starts the daemon itself when nothing is running', async () => {
    // Deliberately run with the Ollama tray app closed and no server up: the
    // question is whether Forge brings the daemon up on its own, or whether a
    // local model is unreachable without the tray app running first.
    const reachable = await fetch(`${ENDPOINT}/api/tags`).then(
      (r) => r.ok,
      () => false,
    );
    if (reachable) {
      console.log('[live] daemon already up — auto-start not exercised');
    }

    const config = makeConfig();
    const pool = new BackendPool(config, new SharedRuntimeRegistry(registryRoot));
    const hold = await pool.acquireForDelegation('primary-llamacpp', MODEL);
    hold.release();

    const after = await fetch(`${ENDPOINT}/api/tags`);
    expect(after.ok).toBe(true);
    const body = (await after.json()) as { models: Array<{ name: string }> };
    expect(body.models.map((m) => m.name)).toContain(MODEL);
    await pool.stopAll();
  }, 120_000);

  it('acquires the target as an Ollama slot, not a llama.cpp one', async () => {
    const config = makeConfig();
    const pool = new BackendPool(config, new SharedRuntimeRegistry(registryRoot));

    const check = pool.canDelegate('primary-llamacpp', MODEL);
    // Daemon targets own their own VRAM: capacity must not gate them, and the
    // caller must be told the hold is best-effort.
    expect(check.safe).toBe(true);
    expect(check.bestEffort).toBe(true);

    const hold = await pool.acquireForDelegation('primary-llamacpp', MODEL);
    try {
      expect(hold.bestEffort).toBe(true);
      // The daemon endpoint, never a llama-server port.
      expect(hold.backend.baseUrl()).toContain('11434');
      expect(hold.backend.baseUrl()).not.toContain('8080');
    } finally {
      hold.release();
    }
    await pool.stopAll();
  }, 60_000);

  it('completes a real delegation through ask_local_agent’s service', async () => {
    const config = makeConfig();
    const pool = new BackendPool(config, new SharedRuntimeRegistry(registryRoot));
    const service = new LocalDelegationService({
      getConfig: () => config,
      backendPool: pool,
      workspaceRoot: process.cwd(),
    });

    const result = await service.ask({
      primaryModel: 'primary-llamacpp',
      targetModel: MODEL,
      task: 'Reply with exactly the word: PONG',
      maxOutputTokens: 32,
    });

    expect(result.targetModel).toBe(MODEL);
    expect(result.bestEffort).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    console.log(`[live] ${MODEL} answered: ${JSON.stringify(result.text.slice(0, 200))}`);
    await pool.stopAll();
  }, 180_000);
});
