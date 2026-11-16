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

describe('benchmark edit_file', () => {
  it('writes $ patterns in new_text as the literal characters they are', async () => {
    // `String.prototype.replace` interprets `$'`, `$&` and `$1` in a string
    // replacement, so a model writing `A$'B` used to get text lifted out of the
    // surrounding file instead of what it asked for.
    fs.writeFileSync(path.join(root, 'dollar.txt'), 'a X b');
    const host = createBenchmarkToolHost(root);
    const result = await host.dispatch(
      {
        id: 'edit-dollar',
        type: 'function',
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'dollar.txt',
            old_text: 'X',
            new_text: "A$'B",
          }),
        },
      },
      new AbortController().signal,
    );
    expect(result).toContain('dollar.txt');
    expect(fs.readFileSync(path.join(root, 'dollar.txt'), 'utf8')).toBe("a A$'B b");
  });
});

describe('benchmark grep_search contract', () => {
  it('supports regex by default, literal searches and invalid-pattern guidance', async () => {
    fs.writeFileSync(path.join(root, 'search.ts'), 'target.heal(value); call foo(value);');
    const host = createBenchmarkToolHost(root);
    const definition = host.definitions().find((item) => item.function.name === 'grep_search');
    expect(definition?.function.parameters.properties?.literal).toMatchObject({
      type: 'boolean',
    });

    const call = (args: Record<string, unknown>) =>
      host.dispatch(
        {
          id: 'search',
          type: 'function',
          function: { name: 'grep_search', arguments: JSON.stringify(args) },
        },
        new AbortController().signal,
      );

    expect(await call({ query: String.raw`\.heal\(` })).toContain('target.heal(value)');
    expect(await call({ query: 'foo(', literal: true })).toContain('target.heal(value)');
    const invalid = await call({ query: '[' });
    expect(invalid).toContain('regex parse error');
    expect(invalid).toContain('literal: true');
    expect(await call({ query: 'nothing-matches' })).toContain('(ripgrep-regex search)');
    expect(await call({ query: 'nothing-matches', literal: true })).toContain(
      '(plain-text search)',
    );
  });
});
