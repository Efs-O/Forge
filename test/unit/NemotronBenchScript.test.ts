import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { greekMessages, greekSystemInfo, options } from '../../scripts/nemotron-bench.mjs';

const script = resolve(process.cwd(), 'scripts', 'nemotron-bench.mjs');
const baseArgs = ['--base-url', 'http://127.0.0.1:1', '--model', 'test-model'];
const parseOptions = (args: string[]) => options(args, process.cwd(), existsSync);

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CUDA_VISIBLE_DEVICES: '' } });
}

function runAsync(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, CUDA_VISIBLE_DEVICES: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function fakeRun() {
  const temp = mkdtempSync(resolve(tmpdir(), 'forge-nemotron-bench-test-'));
  const evalFile = resolve(temp, 'eval.jsonl');
  const output = resolve(temp, 'out');
  const rowsOut = resolve(temp, 'rows.jsonl');
  writeFileSync(evalFile, [
    JSON.stringify({ id: 'r1', q: 'q1', a: 'a1', system: 'Fixed system' }),
    JSON.stringify({ id: 'r2', q: 'q2', a: 'a2', system: 'Fixed system' }),
  ].join('\n') + '\n');
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/props') return json(res, { build_info: { build: 'fake' }, n_ctx: 4096 });
    if (req.url === '/v1/models') return json(res, { data: [{ id: 'test-model' }] });
    if (req.url === '/v1/chat/completions') {
      let data = '';
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data) as Record<string, unknown>;
      bodies.push(body);
      return json(res, { choices: [{ message: { content: 'answer', reasoning_content: 'reasoning' }, finish_reason: 'stop' }] });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake server did not bind');
  try {
    const args = ['--base-url', `http://127.0.0.1:${address.port}`, '--model', 'test-model', '--quant', 'test-quant', '--greek-eval', evalFile, '--out', output, '--determinism', '2', '--rows-out', rowsOut];
    const result = await runAsync(args);
    return { result, bodies, rows: readFileSync(rowsOut, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(temp, { recursive: true, force: true });
  }
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

describe('nemotron benchmark script', () => {
  it('documents endpoint-only use and flags', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--greek-eval');
    expect(result.stdout).toContain('--quant NAME');
    expect(result.stdout).toContain('--rows-out PATH');
    expect(result.stdout).toContain('never starts, stops, unloads');
  });

  it('reports missing connection inputs through the CLI before creating artifacts', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--base-url must be an HTTP(S) URL.');
  });

  it('requires an explicit Greek evaluation file before network access', () => {
    expect(() => parseOptions([...baseArgs, '--quant', 'test'])).toThrow(
      '--greek-eval PATH is required.',
    );
  });

  it('rejects a nonexistent Greek evaluation file before network access', () => {
    expect(() =>
      parseOptions([...baseArgs, '--quant', 'test', '--greek-eval', 'missing-greek-eval.jsonl']),
    ).toThrow('Greek evaluation file not found:');
  });

  it('requires quant before network access', () => {
    expect(() =>
      parseOptions([...baseArgs, '--greek-eval', 'missing-greek-eval.jsonl']),
    ).toThrow('--quant NAME is required.');
  });

  it('refuses rows output in the repository before network access', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'forge-nemotron-options-test-'));
    const evalFile = resolve(temp, 'eval.jsonl');
    writeFileSync(evalFile, JSON.stringify({ q: 'q', a: 'a', system: 's' }));
    try {
      expect(() =>
        parseOptions([
          ...baseArgs,
          '--quant',
          'test',
          '--greek-eval',
          evalFile,
          '--rows-out',
          resolve(process.cwd(), 'unsafe.jsonl'),
        ]),
      ).toThrow('--rows-out must be outside the Forge repository root.');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects invalid Greek token and determinism values', () => {
    const evalFile = resolve(tmpdir(), 'nonexistent-eval.jsonl');
    for (const [flag, value, expected] of [['--greek-max-tokens', '0', 'positive integer'], ['--determinism', '-1', 'greater than or equal to 0']]) {
      expect(() =>
        parseOptions([...baseArgs, '--quant', 'test', '--greek-eval', evalFile, flag, value]),
      ).toThrow(expected);
    }
  });

  it('parses the no-system mode and builds its request without a system message', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'forge-nemotron-options-test-'));
    const evalFile = resolve(temp, 'eval.jsonl');
    writeFileSync(evalFile, JSON.stringify({ q: 'q', a: 'a', system: 'Fixed system' }));
    try {
      const input = parseOptions([
        ...baseArgs,
        '--quant',
        'test',
        '--greek-eval',
        evalFile,
        '--greek-no-system',
      ]);
      expect(input.greekNoSystem).toBe(true);

      const rows = [{ system: 'Fixed system' }];
      const disabledSystem = greekSystemInfo(rows, input.greekNoSystem ?? false);
      expect(disabledSystem).toMatchObject({ mode: 'none', prompt: undefined, sha256: null });
      expect(greekMessages('q', disabledSystem.prompt)).toEqual([
        { role: 'user', content: 'q' },
      ]);
      const enabledSystem = greekSystemInfo(rows, false);
      expect(enabledSystem.prompt).toBe('Fixed system');
      expect(greekMessages('q', enabledSystem.prompt)).toEqual([
        { role: 'system', content: 'Fixed system' },
        { role: 'user', content: 'q' },
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('sends parity and deterministic settings and writes per-row audit JSONL', async () => {
    const { result, bodies, rows } = await fakeRun();
    expect(result.status).toBe(0);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((body) => body.cache_prompt === false)).toBe(true);
    const greek = bodies.filter((body) => Array.isArray(body.messages) && (body.messages as Array<{ content: string }>).some((message) => message.content === 'q1' || message.content === 'q2'));
    expect(greek.length).toBe(8);
    expect(greek.every((body) => (body.messages as Array<{ role: string; content: string }>)[0].role === 'system')).toBe(true);
    expect(greek.every((body) => body.temperature === 0 && body.top_k === 1 && body.seed === 3407)).toBe(true);
    expect(rows).toHaveLength(5);
    expect(rows[0].type).toBe('header');
    expect(rows.slice(1).every((row) => row.type === 'row')).toBe(true);
  }, 120_000);

});
