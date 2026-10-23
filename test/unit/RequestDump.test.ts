import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteRequestDumps,
  pruneRequestDumps,
  RequestDumpWriter,
} from '../../src/sessions/requestDump';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-request-dumps-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
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
    await flushWrites();

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

  it('skips an oversized dump and warns once per conversation', async () => {
    const warn = vi.fn();
    const writer = new RequestDumpWriter(root, warn);
    writer.enqueue(dumpInput(), { maxBytes: 1, keepHours: 1 });
    writer.enqueue(dumpInput(), { maxBytes: 1, keepHours: 1 });
    await flushWrites();

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
    await flushWrites();

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
