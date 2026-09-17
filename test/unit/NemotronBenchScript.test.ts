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
});
