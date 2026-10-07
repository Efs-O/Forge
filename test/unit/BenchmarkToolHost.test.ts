import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBenchmarkToolHost } from '../../src/benchmark/toolHost';
import { MAX_SINGLE_WRITE_CHARS } from '../../src/tools/writeChunking';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-benchmark-tools-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('benchmark file write limits', () => {
  it('uses the shared single-write limit in schema and dispatch', async () => {
    const host = createBenchmarkToolHost(root);
    const write = host
      .definitions()
      .find((definition) => definition.function.name === 'write_file');
    expect(write?.function.parameters.properties?.content).toMatchObject({
      maxLength: MAX_SINGLE_WRITE_CHARS,
    });

    const result = await host.dispatch(
      {
        id: 'write-too-large',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'large.txt',
            content: 'x'.repeat(MAX_SINGLE_WRITE_CHARS + 1),
          }),
        },
      },
      new AbortController().signal,
    );
    expect(result).toContain(`content is limited to ${MAX_SINGLE_WRITE_CHARS} characters`);
  });
});
