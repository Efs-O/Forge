import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts', 'nemotron-bench.mjs');
const baseArgs = ['--base-url', 'http://127.0.0.1:1', '--model', 'test-model'];

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

async function fakeRun(noSystem = false) {
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
    if (noSystem) args.push('--greek-no-system');
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

  it('rejects missing connection inputs before creating benchmark artifacts', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--base-url must be an HTTP(S) URL.');
  });

  it('requires an explicit Greek evaluation file before network access', () => {
    const result = run([...baseArgs, '--quant', 'test']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--greek-eval PATH is required.');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('rejects a nonexistent Greek evaluation file before network access', () => {
    const result = run([...baseArgs, '--quant', 'test', '--greek-eval', 'missing-greek-eval.jsonl']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Greek evaluation file not found:');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('requires quant before network access', () => {
    const result = run([...baseArgs, '--greek-eval', 'missing-greek-eval.jsonl']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--quant NAME is required.');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('refuses rows output in the repository before network access', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'forge-nemotron-options-test-'));
    const evalFile = resolve(temp, 'eval.jsonl');
    writeFileSync(evalFile, JSON.stringify({ q: 'q', a: 'a', system: 's' }));
    try {
      const result = run([...baseArgs, '--quant', 'test', '--greek-eval', evalFile, '--rows-out', resolve(process.cwd(), 'unsafe.jsonl')]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--rows-out must be outside the Forge repository root.');
      expect(result.stderr).not.toContain('ECONNREFUSED');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects invalid Greek token and determinism values', () => {
    const evalFile = resolve(tmpdir(), 'nonexistent-eval.jsonl');
    for (const [flag, value, expected] of [['--greek-max-tokens', '0', 'positive integer'], ['--determinism', '-1', 'greater than or equal to 0']]) {
      const result = run([...baseArgs, '--quant', 'test', '--greek-eval', evalFile, flag, value]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain('ECONNREFUSED');
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

  it('omits the Greek system message with --greek-no-system', async () => {
    const { result, bodies } = await fakeRun(true);
    expect(result.status).toBe(0);
    const greek = bodies.filter((body) => Array.isArray(body.messages) && (body.messages as Array<{ content: string }>).some((message) => message.content === 'q1' || message.content === 'q2'));
    expect(greek.length).toBe(8);
    expect(greek.every((body) => (body.messages as Array<{ role: string }>).every((message) => message.role !== 'system'))).toBe(true);
  }, 120_000);
});
