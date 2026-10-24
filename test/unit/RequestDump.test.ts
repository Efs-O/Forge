import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteRequestDumps,
  pruneRequestDumps,
  RequestDumpWriter,
} from '../../src/sessions/requestDump';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-request-dumps-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

async function waitForDump(conversationId: string, timeoutMs = 5_000): Promise<void> {
  const directory = path.join(root, conversationId);
  await vi.waitFor(
    () => {
      expect(fs.existsSync(directory)).toBe(true);
      expect(fs.readdirSync(directory).some((name) => name.endsWith('.json'))).toBe(true);
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

function dumpInput(conversationId = 'c1', request = '{"messages":[]}') {
  const sentAtMs = Date.now();
  return {
    conversationId,
    request,
    url: '/v1/chat/completions',
    model: 'model-a',
    sentAtMs,
    stats: {
      type: 'request_stats' as const,
      outcome: 'ok' as const,
      client: { total_ms: 1, chunks: 1 },
      timestamp_ms: sentAtMs + 1,
      model: 'model-a',
    },
  };
}

describe('request dump writer', () => {
  it('writes the parsed request body atomically without any header field', async () => {
    const warn = vi.fn();
    const request = JSON.stringify({ messages: [{ role: 'user', content: 'body' }] });
    const writer = new RequestDumpWriter(root, warn);
    const input = dumpInput('c1', request);
    writer.enqueue(input, { maxBytes: 10_000, keepHours: 24 });
    await waitForDump('c1');

    const files = fs.readdirSync(path.join(root, 'c1'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d+-\d+\.json$/u);
    expect(Number(files[0]?.split('-')[0])).toBe(input.sentAtMs + 24 * 60 * 60_000);
    const serialized = fs.readFileSync(path.join(root, 'c1', files[0]!), 'utf8');
    const dump = JSON.parse(serialized) as Record<string, unknown>;
    expect(dump).toMatchObject({
      request: JSON.parse(request),
      url: '/v1/chat/completions',
      model: 'model-a',
      conversationId: 'c1',
      sent_at_ms: input.sentAtMs,
    });
    expect(dump).not.toHaveProperty('headers');
    expect(serialized).not.toContain('Authorization');
    expect(warn).not.toHaveBeenCalled();
  });

  // Room for the flush: `npm run ci` runs the whole suite in the same two
  // workers, and a real fsync of the dump under that load can pass 5 s, which
  // is the default per-test timeout. The assertion itself is not timing-based.
  it('flushes the dump through its own handle before renaming it into place', { timeout: 20_000 }, async () => {
    // The defect BL-002 is about: this writer had its own temp file plus rename
    // with no flush, so 0.17.42's power-loss fix reached none of it. Order
    // matters: a rename that is not preceded by a sync can land a file whose
    // size is right and whose body is NUL after a power loss.
    const order: string[] = [];
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        order.push('sync');
        return sync();
      };
      return handle;
    });

    const writer = new RequestDumpWriter(root, vi.fn());
    writer.enqueue(dumpInput(), { maxBytes: 10_000, keepHours: 24 });
    await waitForDump('c1', 15_000);

    // The shared writer opens its temp file with `wx` and syncs through that
    // same handle before renaming (src/util/atomicWrite.ts writeAndSyncAsync);
    // this writer's own temp-plus-rename opened nothing observable, so on the
    // old code `order` stays empty. Rename-after-sync is pinned by
    // test/unit/AtomicWrite.test.ts, so only the flush is asserted here.
    expect(order).toEqual(['sync']);
  });

  it('skips an oversized dump and warns once per conversation', async () => {
    const warn = vi.fn();
    const writer = new RequestDumpWriter(root, warn);
    writer.enqueue(dumpInput(), { maxBytes: 1, keepHours: 1 });
    writer.enqueue(dumpInput(), { maxBytes: 1, keepHours: 1 });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 10 });

    expect(fs.existsSync(path.join(root, 'c1'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('oversized');
  });

  it('warns once and disables a conversation after a write failure', async () => {
    const blockedRoot = path.join(root, 'root-is-a-file');
    fs.writeFileSync(blockedRoot, 'occupied');
    const warn = vi.fn();
    const writer = new RequestDumpWriter(blockedRoot, warn);
    writer.enqueue(dumpInput(), { maxBytes: 10_000, keepHours: 24 });
    writer.enqueue(dumpInput(), { maxBytes: 10_000, keepHours: 24 });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 10 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('disabled request dumps');
  });
});

describe('request dump pruning', () => {
  it('deletes expired and stale temporary files without config and removes empty folders', async () => {
    const now = Date.now();
    const expiredName = `${now - 1}-1-1.json`;
    const liveName = `${now + 100_000}-1-2.json`;
    const expired = path.join(root, 'expired');
    const live = path.join(root, 'live');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(expired, { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(expired, expiredName), '{}');
    fs.writeFileSync(path.join(live, liveName), '{}');
    const staleTmp = path.join(expired, 'crash.json.tmp');
    fs.writeFileSync(staleTmp, '{');
    const staleDate = new Date(now - 11 * 60_000);
    fs.utimesSync(staleTmp, staleDate, staleDate);
    const freshTmp = path.join(live, 'recent.json.tmp');
    fs.writeFileSync(freshTmp, '{');

    await pruneRequestDumps(root, { now });

    expect(fs.existsSync(path.join(expired, expiredName))).toBe(false);
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(path.join(live, liveName))).toBe(true);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(empty)).toBe(false);
  });

  it('enforces maxBytes by deleting the oldest sent_at_ms first', async () => {
    const conversation = path.join(root, 'c1');
    fs.mkdirSync(conversation, { recursive: true });
    const oldest = JSON.stringify({ sent_at_ms: 1, payload: 'same-size' });
    const newest = JSON.stringify({ sent_at_ms: 2, payload: 'same-size' });
    const oldestPath = path.join(conversation, '900000-1-1.json');
    const newestPath = path.join(conversation, '800000-1-2.json');
    fs.writeFileSync(oldestPath, oldest);
    fs.writeFileSync(newestPath, newest);

    await pruneRequestDumps(root, { maxBytes: Buffer.byteLength(newest), now: 100 });

    expect(fs.existsSync(oldestPath)).toBe(false);
    expect(fs.existsSync(newestPath)).toBe(true);
  });

  it('treats a missing root as success and removes a conversation folder on delete', async () => {
    await expect(pruneRequestDumps(path.join(root, 'missing'))).resolves.toBeUndefined();
    const conversation = path.join(root, 'delete-me');
    fs.mkdirSync(conversation, { recursive: true });
    fs.writeFileSync(path.join(conversation, '900000-1-1.json'), '{}');

    await deleteRequestDumps('delete-me', root);

    expect(fs.existsSync(conversation)).toBe(false);
  });
});
