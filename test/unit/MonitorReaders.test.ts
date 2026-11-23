import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLlamaPrometheus, parseLlamaSlots } from '../../src/monitor/llamaServerStats';
import { readNutStats } from '../../src/monitor/nutClient';
import { parseStrataMetrics, readStrataStats } from '../../src/monitor/strataStats';
import { ForgeConfigSchema } from '../../src/config/schema';
import { ModelConfigSchema } from '../../src/config/modelSchema';
import { readLlamaStats } from '../../src/monitor/llamaServerStats';
import { readFileSync } from 'fs';
import { MONITOR_CREDIT } from '../../webview-ui/src/monitor/App';
import { noStatsReaderMessage } from '../../src/monitor/monitorTypes';

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

  it('maps Strata live keys and omits missing and null values', () => {
    expect(
      parseStrataMetrics(
        {
          live: {
            state: 'generating',
            tok_s: 9,
            tok_s_mean: null,
            prompt_tokens: 100,
            generated: 20,
            queued: 2,
            waiting: 1,
            parallel: 4,
            unknown: 42,
          },
        },
        8192,
      ),
    ).toEqual({
      state: 'generating',
      decodeTokS: 9,
      running: 1,
      slots: 4,
      waiting: 3,
      contextUsed: 120,
      contextSize: 8192,
    });
  });

  it('returns the exact HTTP failure text for Strata', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 }),
    ) as unknown as typeof fetch;
    const result = await readStrataStats(
      'http://127.0.0.1:8080/v1',
      undefined,
      new AbortController().signal,
      fetchImpl,
    );
    expect(result.error).toBe('/metrics answered HTTP 401');
  });

  it('uses the exact speed and missing-stats card text, and the exact credit footer', async () => {
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
    expect(MONITOR_CREDIT).toBe(
      "Card layout inspired by Strata's Monitor page (github.com/Niko1221/Strata, MIT).",
    );
    expect(
      readFileSync('README.md', 'utf8')
        .split(/\r?\n/)
        .find((line) => line.startsWith('Card layout inspired')),
    ).toBe(MONITOR_CREDIT);
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

  it('reads NUT variables, unescapes bytes and sends only LIST and LOGOUT', async () => {
    const commands: string[] = [];
    const server = new net.Server((socket) => {
      sockets.push(socket);
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        while (input.includes('\n')) {
          const end = input.indexOf('\n');
          commands.push(input.slice(0, end + 1));
          const line = input.slice(0, end).trim();
          input = input.slice(end + 1);
          if (line === 'LIST VAR ups')
            socket.write(
              'BEGIN LIST VAR ups\nVAR ups ups.status "OL\\x4f"\nVAR ups ups.load "31"\nEND LIST VAR ups\n',
            );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing NUT test port');
    await expect(readNutStats(`ups@127.0.0.1:${address.port}`)).resolves.toEqual({
      values: { 'ups.status': 'OL\x4f', 'ups.load': '31' },
    });
    await vi.waitFor(() => expect(commands).toEqual(['LIST VAR ups\n', 'LOGOUT\n']));
  });

  it('passes through a NUT refusal line', async () => {
    const server = new net.Server((socket) => {
      sockets.push(socket);
      socket.once('data', () => socket.write('ERR UNKNOWN-UPS\n'));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing NUT test port');
    expect(await rejectionMessage(readNutStats(`ups@127.0.0.1:${address.port}`))).toBe(
      `NUT server at 127.0.0.1:${address.port} said: ERR UNKNOWN-UPS`,
    );
  });

  it('rejects overlong NUT lines and enforces a single round-trip deadline', async () => {
    const lineServer = new net.Server((socket) => {
      sockets.push(socket);
      socket.once('data', () => socket.write(`BEGIN LIST VAR ups\n${'x'.repeat(4097)}\n`));
    });
    servers.push(lineServer);
    await new Promise<void>((resolve) => lineServer.listen(0, '127.0.0.1', resolve));
    const lineAddress = lineServer.address();
    if (!lineAddress || typeof lineAddress === 'string') throw new Error('missing NUT test port');
    expect(await rejectionMessage(readNutStats(`ups@127.0.0.1:${lineAddress.port}`))).toBe(
      'NUT line exceeded 4096 bytes',
    );

    const silent = new net.Server((socket) => sockets.push(socket));
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentAddress = silent.address();
    if (!silentAddress || typeof silentAddress === 'string')
      throw new Error('missing NUT test port');
    expect(await rejectionMessage(readNutStats(`ups@127.0.0.1:${silentAddress.port}`))).toBe(
      `NUT server at 127.0.0.1:${silentAddress.port} timed out after 1000 ms`,
    );
  }, 3000);

  it('rejects an oversized NUT reply and a reply without ups.status', async () => {
    const large = new net.Server((socket) => {
      sockets.push(socket);
      socket.once('data', () =>
        socket.write(
          `BEGIN LIST VAR ups\n${'VAR ups ignored "1234567890123456789012345678901234567890"\n'.repeat(1400)}`,
        ),
      );
    });
    servers.push(large);
    await new Promise<void>((resolve) => large.listen(0, '127.0.0.1', resolve));
    const largeAddress = large.address();
    if (!largeAddress || typeof largeAddress === 'string') throw new Error('missing NUT test port');
    expect(await rejectionMessage(readNutStats(`ups@127.0.0.1:${largeAddress.port}`))).toBe(
      'NUT reply exceeded 65536 bytes',
    );

    const missing = new net.Server((socket) => {
      sockets.push(socket);
      socket.once('data', () => socket.write('BEGIN LIST VAR ups\nEND LIST VAR ups\n'));
    });
    servers.push(missing);
    await new Promise<void>((resolve) => missing.listen(0, '127.0.0.1', resolve));
    const missingAddress = missing.address();
    if (!missingAddress || typeof missingAddress === 'string')
      throw new Error('missing NUT test port');
    expect(await rejectionMessage(readNutStats(`ups@127.0.0.1:${missingAddress.port}`))).toBe(
      'NUT reply had no ups.status',
    );
  });
});
