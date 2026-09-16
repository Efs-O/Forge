import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FRESH_MS,
  STALE_MS,
  TTL_MS,
  busPaths,
  clearExchange,
  ensureBus,
  listenerState,
  newBusId,
  sweepStale,
  takeOrphans,
  waitForReply,
  withdrawQuestion,
  writeQuestion,
  type BusPaths,
} from '../../src/agentBus/agentBus';
import { BUS_README, WATCH_SCRIPT, armPrompt } from '../../src/agentBus/busContent';
import { codexMessage } from '../../src/agentBus/codexDelivery';

let home: string;
let paths: BusPaths;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-bus-'));
  paths = busPaths(home);
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

function writeReply(id: string, text: string): void {
  const file = path.join(paths.outbox, `${id}-reply.md`);
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function setAge(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

describe('ensureBus', () => {
  it('creates the folders and the shipped files in an empty home', () => {
    ensureBus(paths);
    expect(fs.existsSync(paths.inbox)).toBe(true);
    expect(fs.existsSync(paths.outbox)).toBe(true);
    expect(fs.readFileSync(path.join(paths.root, 'README.md'), 'utf8')).toBe(BUS_README);
    expect(fs.readFileSync(path.join(paths.root, 'watch.sh'), 'utf8')).toBe(WATCH_SCRIPT);
  });

  it('rewrites a stale watcher so the disk never drifts from the code', () => {
    ensureBus(paths);
    fs.writeFileSync(path.join(paths.root, 'watch.sh'), 'old hand-written watcher');
    ensureBus(paths);
    expect(fs.readFileSync(path.join(paths.root, 'watch.sh'), 'utf8')).toBe(WATCH_SCRIPT);
  });

  it('ships a watcher that touches the heartbeat', () => {
    expect(WATCH_SCRIPT).toContain('touch "$ROOT/listening"');
  });
});

describe('listenerState', () => {
  beforeEach(() => ensureBus(paths));

  it('is absent with no heartbeat file', () => {
    expect(listenerState(paths).state).toBe('absent');
  });

  it('is fresh, stale, then absent as the heartbeat ages', () => {
    fs.writeFileSync(paths.heartbeat, '');
    expect(listenerState(paths).state).toBe('fresh');
    setAge(paths.heartbeat, FRESH_MS + 5_000);
    expect(listenerState(paths).state).toBe('stale');
    setAge(paths.heartbeat, STALE_MS + 5_000);
    expect(listenerState(paths).state).toBe('absent');
  });
});

describe('ids', () => {
  it('two calls in the same millisecond get distinct ids', () => {
    const now = 1_700_000_000_000;
    expect(newBusId(now)).not.toBe(newBusId(now));
  });

  it('are prefixed so orphan detection only claims its own', () => {
    expect(newBusId()).toMatch(/^fg\d+-[0-9a-f]{8}$/);
  });
});

describe('exchange', () => {
  beforeEach(() => ensureBus(paths));

  it('writes the question atomically, with no .tmp left behind', () => {
    writeQuestion(paths, 'fg1-a', 'subj', 'body');
    expect(fs.readdirSync(paths.inbox)).toEqual(['fg1-a-forge.md']);
    const text = fs.readFileSync(path.join(paths.inbox, 'fg1-a-forge.md'), 'utf8');
    expect(text.startsWith('Subject: subj\n')).toBe(true);
    expect(text).toContain('outbox/fg1-a-reply.md');
  });

  it('returns a reply that lands during the wait', async () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    setTimeout(() => writeReply('fg1-a', 'the answer'), 50);
    await expect(waitForReply(paths, 'fg1-a', 5_000, undefined, 10)).resolves.toBe('the answer');
  });

  it('never returns a reply that exists only as .tmp', async () => {
    fs.writeFileSync(path.join(paths.outbox, 'fg1-a-reply.md.tmp'), 'half an ans');
    await expect(waitForReply(paths, 'fg1-a', 60, undefined, 10)).resolves.toBeUndefined();
  });

  it('returns promptly when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(
      waitForReply(paths, 'fg1-a', 60_000, controller.signal, 10_000),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a finished exchange leaves nothing behind in either folder', async () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    fs.writeFileSync(path.join(paths.inbox, 'fg1-a-forge.md.notified'), '');
    writeReply('fg1-a', 'answer');
    await waitForReply(paths, 'fg1-a', 1_000, undefined, 10);
    clearExchange(paths, 'fg1-a');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });
});

describe('late replies', () => {
  beforeEach(() => ensureBus(paths));

  it('are announced once, then deleted, and never repeated', () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    withdrawQuestion(paths, 'fg1-a');
    writeReply('fg1-a', 'late');
    expect(takeOrphans(paths, 3)).toEqual({ shown: [{ id: 'fg1-a', text: 'late' }], more: 0 });
    expect(takeOrphans(paths, 3)).toEqual({ shown: [], more: 0 });
  });

  it('are not claimed while the question is still pending', () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    writeReply('fg1-a', 'on time');
    expect(takeOrphans(paths, 3).shown).toEqual([]);
  });

  it("never claims another asker's reply", () => {
    writeReply('sh123-99', 'a codex answer');
    expect(takeOrphans(paths, 3).shown).toEqual([]);
    expect(fs.existsSync(path.join(paths.outbox, 'sh123-99-reply.md'))).toBe(true);
  });

  it('caps the list and counts the rest', () => {
    for (const id of ['fg1-a', 'fg2-b', 'fg3-c', 'fg4-d']) writeReply(id, id);
    const orphans = takeOrphans(paths, 3);
    expect(orphans.shown).toHaveLength(3);
    expect(orphans.more).toBe(1);
  });
});

describe('sweepStale', () => {
  it('removes files older than the TTL from any asker and keeps newer ones', () => {
    ensureBus(paths);
    const old = path.join(paths.inbox, 'sh1-x-ask.md');
    const fresh = path.join(paths.outbox, 'fg2-y-reply.md');
    fs.writeFileSync(old, '');
    fs.writeFileSync(fresh, '');
    setAge(old, TTL_MS + 60_000);
    sweepStale(paths);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('armPrompt', () => {
  it('is self-contained: watcher, reply path, visibility rule, README', () => {
    const prompt = armPrompt('C:\\Users\\someone\\.forge\\agent-bus');
    expect(prompt).toContain('bash "C:/Users/someone/.forge/agent-bus/watch.sh"');
    expect(prompt).toContain('outbox/<same id>-reply.md');
    expect(prompt).toContain('**Forge asks:**');
    expect(prompt).toContain('README.md');
  });
});

describe('codexMessage', () => {
  it('carries the reply contract with a forward-slash path', () => {
    const msg = codexMessage('C:\\bus\\outbox\\fg1-a-reply.md', 'fg1-a', 'subj', 'body');
    expect(msg).toContain('C:/bus/outbox/fg1-a-reply.md.tmp');
    expect(msg).toContain('body');
    expect(msg).toContain('Codex says:');
    expect(msg).not.toContain('\\');
  });
});
