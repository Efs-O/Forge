import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomicWrite from '../../src/util/atomicWrite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

import { retiredToolResult } from '../../src/sidebar/retiredTools';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { makeWriteFileTool } from '../../src/tools/builtinTools';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-append-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tool = () => makeWriteFileTool();
const call = async (args: Record<string, unknown>) =>
  tool().handler(args, { signal: new AbortController().signal } as never);

// These are the cases `append_file` carried, ported to `write_file` with
// `mode: "append"` (TOOL_TRIM_PLAN.md B2). The tool had 0 calls in 53 audited
// sessions while costing a schema on every round; the behaviour it existed for
// - rebuilding a file too large for one call - is the mode's job now.
describe('write_file mode: "append"', () => {
  it('passes the turn AbortSignal and long retry budget to overwrite and append saves', async () => {
    const target = path.join(dir, 'signal.txt');
    fs.writeFileSync(target, 'prefix');
    const controller = new AbortController();
    const write = vi.spyOn(atomicWrite, 'writeFileAtomic').mockResolvedValue();
    try {
      await tool().handler(
        { path: target, content: 'replacement' },
        { beforeMutate: () => undefined, abortSignal: controller.signal },
      );
      await tool().handler(
        { path: target, content: 'suffix', mode: 'append' },
        { beforeMutate: () => undefined, abortSignal: controller.signal },
      );

      const options = {
        signal: controller.signal,
        retryBudgetMs: atomicWrite.ASYNC_RENAME_BUDGET_MS,
      };
      const [writtenTarget, writtenContent] = write.mock.calls[0]!;
      expect(path.basename(writtenTarget)).toBe('signal.txt');
      expect(writtenContent).toBe('replacement');
      expect(write.mock.calls[0]?.[2]).toMatchObject(options);
      expect(write.mock.calls[0]?.[2]?.onDelayedSuccess).toEqual(expect.any(Function));
      expect(write.mock.calls[1]?.[1]).toEqual(Buffer.from('prefixsuffix'));
      expect(write.mock.calls[1]?.[2]).toMatchObject(options);
      expect(write.mock.calls[1]?.[2]).toHaveProperty('expected');
    } finally {
      write.mockRestore();
    }
  });

  // The point of the mode: a file too large for one call is built across
  // several, so no single tool call has to fit in the remaining context.
  it('reconstructs a file byte-exactly across a write and two appends', async () => {
    const target = path.join(dir, 'nested', 'ui.js');
    const chunks = ['"use strict";\n', 'const a = 1;\n', 'export default a;\n'];

    await call({ path: target, content: chunks[0] });
    await call({ path: target, content: chunks[1], mode: 'append' });
    await call({ path: target, content: chunks[2], mode: 'append' });

    expect(fs.readFileSync(target, 'utf8')).toBe(chunks.join(''));
  });

  it('creates the file when it does not exist yet', async () => {
    const target = path.join(dir, 'fresh.txt');
    await call({ path: target, content: 'first', mode: 'append' });
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
  });

  it('preserves invalid UTF-8 bytes when appending', async () => {
    const target = path.join(dir, 'latin1.txt');
    const original = Buffer.from([0xe9, 0x0a]);
    fs.writeFileSync(target, original);

    await call({ path: target, content: 'tail', mode: 'append' });

    expect(fs.readFileSync(target)).toEqual(Buffer.concat([original, Buffer.from('tail', 'utf8')]));
  });

  it('inserts no separator of its own', async () => {
    const target = path.join(dir, 'joined.txt');
    await call({ path: target, content: 'a', mode: 'append' });
    await call({ path: target, content: 'b', mode: 'append' });
    expect(fs.readFileSync(target, 'utf8')).toBe('ab');
  });

  it('still reports the whole file, not the chunk', async () => {
    const target = path.join(dir, 'total.txt');
    await call({ path: target, content: 'aaa' });
    const result = String(await call({ path: target, content: 'bb', mode: 'append' }));
    expect(result).toContain('Appended 2 chars');
    expect(result).toContain('5 bytes total');
  });

  it('is declared as a write-permission mutation so checkpoints capture it', () => {
    expect(tool().permission).toBe('write');
    expect(tool().mutation?.paths({ path: '/tmp/x' })).toEqual(['/tmp/x']);
  });

  it('refuses a mode outside the enum instead of picking one silently', async () => {
    await expect(
      call({ path: path.join(dir, 'mode.txt'), content: 'x', mode: 'Append' }),
    ).rejects.toThrow(/mode must be "overwrite" or "append"/u);
  });

  it('overwrites by default, so an omitted mode is not an append', async () => {
    const target = path.join(dir, 'default.txt');
    await call({ path: target, content: 'one\n' });
    await call({ path: target, content: 'two\n' });
    expect(fs.readFileSync(target, 'utf8')).toBe('two\n');
  });
});

// The ledger row TOOL_TRIM_PLAN.md names as CI-enforced: a persisted chat or a
// session log from before B2 still replays `append_file`, and the answer must
// tell the model where to go instead of crashing on an unknown tool.
// `test/unit/ToolDispatchUnknownHint.test.ts` walks the same table through real
// dispatch; this asserts the wording the model reads.
describe('the retired append_file name', () => {
  it('comes back with a message naming write_file and mode "append"', () => {
    const message = retiredToolResult('append_file', 200, {
      registry: new ToolRegistry(),
      allowed: new Set<ToolPermission>(),
      budget: undefined,
      convId: undefined,
      unavailableTools: undefined,
    });

    expect(message).toContain('unknown tool "append_file"');
    expect(message).toContain('was replaced by "write_file"');
    expect(message).toContain('mode: "append"');
    expect(message?.length).toBeLessThanOrEqual(200);
  });
});
