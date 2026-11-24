import * as net from 'net';
import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLlamaPrometheus, parseLlamaSlots, readLlamaStats } from '../../src/monitor/llamaServerStats';
import { readNutStats } from '../../src/monitor/nutClient';
import { readStrataMetrics } from '../../src/monitor/strataStats';
import { ForgeConfigSchema } from '../../src/config/schema';
import { ModelConfigSchema } from '../../src/config/modelSchema';
import { noStatsReaderMessage } from '../../src/monitor/monitorTypes';

/** The vendored Strata page, as it sits in the repository (not the built copy). */
const VENDOR = 'webview-ui/vendor/strata-monitor';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the operation to reject');
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('Monitor readers', () => {
  it('reads both llama.cpp slot JSON shapes and only unlabelled named gauges', () => {
    expect(
      parseLlamaSlots([
        { id: 0, n_ctx: 8192, is_processing: true, n_prompt_tokens: 128 },
        { id: 1, n_ctx: 8192, is_processing: false },
      ]),
    ).toEqual({
      active: 1,
      total: 2,
      slots: [
        { used: 128, size: 8192 },
        { used: null, size: 8192 },
      ],
    });
    expect(parseLlamaSlots([{ state: 1, n_past: 17, n_ctx: 2048 }])?.slots[0]).toEqual({
      used: 17,
      size: 2048,
    });
    expect(
      parseLlamaPrometheus(
        '# HELP llamacpp:prompt_tokens_seconds rate\n# TYPE x gauge\nllamacpp:prompt_tokens_seconds 4.5\nllamacpp:predicted_tokens_seconds 7\nllamacpp:requests_processing{slot="0"} 1\nunknown 99',
      ),
    ).toEqual({
      'llamacpp:prompt_tokens_seconds': 4.5,
      'llamacpp:predicted_tokens_seconds': 7,
    });
  });

  it('passes the whole Strata /metrics document through, asking for every kept request', async () => {
    const document = {
      engine: { model: 'm', max_context: 8192 },
      live: { state: 'idle', tok_s: null },
      requests: [{ time: 1, finish: 'stop' }, { time: 2, finish: 'stop' }],
      requests_kept: 2,
      hardware: { gpu_util: 12 },
      history: { tok_s: [1, 2] },
      ups: { 'ups.status': 'OL' },
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(document), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      readStrataMetrics('http://127.0.0.1:8091/v1', 'secret', new AbortController().signal, fetchImpl),
    ).resolves.toEqual(document);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8091/metrics?requests=all', {
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
    });
  });

  it('returns the exact HTTP failure text for Strata', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 }),
    ) as unknown as typeof fetch;
    const result = await readStrataMetrics(
      'http://127.0.0.1:8080/v1',
      undefined,
      new AbortController().signal,
      fetchImpl,
    );
    expect(result.error).toBe('/metrics answered HTTP 401');
  });

  it('uses the exact speed and missing-stats card text', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 404 }),
    ) as unknown as typeof fetch;
    const result = await readLlamaStats(
      'http://127.0.0.1:8080',
      new AbortController().signal,
      fetchImpl,
    );
    expect(result.error).toBe("Speed needs llama-server's --metrics flag.");
    expect(noStatsReaderMessage('Strata demo')).toBe(
      'No stats reader set for "Strata demo": add stats: llama or stats: strata to its engine in ~/.forge/policy.yaml.',
    );
  });

  it('credits Strata in the exact footer line the panel shows', () => {
    const html = readFileSync('webview-ui/monitor.html', 'utf8');
    expect(html).toContain(
      '<p class="monitor-credit">Monitor page from Strata (github.com/Niko1221/Strata), MIT License.</p>',
    );
  });

  it('ships Strata MIT and OFL next to the vendored page', () => {
    expect(readFileSync(`${VENDOR}/LICENSE`, 'utf8').startsWith('MIT License')).toBe(true);
    const fonts = readFileSync(`${VENDOR}/fonts/OFL.txt`, 'utf8');
    expect(fonts).toContain('SIL Open Font License, Version 1.1');
  });

  it('rejects a non-loopback UPS with the documented wording', () => {
    const result = ForgeConfigSchema.safeParse({
      models: [],
      active_model: null,
      llama_server: {},
      monitor: { ups: 'ups@192.168.1.5' },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].message).toBe(
        'monitor.ups must point at this machine (127.0.0.1, ::1 or localhost); Forge does not reach other hosts for UPS readings.',
      );
  });

  it('refuses stats on a model entry with the documented wording', () => {
    const result = ModelConfigSchema.safeParse({ name: 'demo', stats: 'strata' });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.find((issue) => issue.path[0] === 'stats')?.message).toBe(
        'stats belongs on the engine in ~/.forge/policy.yaml, not on a model entry',
      );
  });
});
