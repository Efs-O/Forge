import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts', 'nemotron-bench.mjs');

describe('nemotron benchmark script', () => {
  it('documents that it is endpoint-only', () => {
    const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--base-url');
    expect(result.stdout).toContain('--greek-eval');
    expect(result.stdout).toContain('never starts, stops, unloads');
  });

  it('rejects missing connection inputs before creating benchmark artifacts', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--base-url must be an HTTP(S) URL.');
  });

  it('requires an explicit Greek evaluation file before network access', () => {
    const result = spawnSync(process.execPath, [script, '--base-url', 'http://127.0.0.1:1', '--model', 'test-model'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--greek-eval PATH is required.');
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('rejects a nonexistent Greek evaluation file before network access', () => {
    const result = spawnSync(process.execPath, [script, '--base-url', 'http://127.0.0.1:1', '--model', 'test-model', '--greek-eval', 'missing-greek-eval.jsonl'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Greek evaluation file not found:');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });
});
