import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TTL_MS,
  busPaths,
  clearExchange,
  ensureBus,
  newBusId,
  sweepStale,
  takeOrphans,
  waitForReply,
  withdrawQuestion,
  writeQuestion,
  writeReply,
  type BusPaths,
} from '../../src/agentBus/agentBus';
import {
  BUS_README,
  CLIENT_SCRIPT,
  claudeQuestion,
  forgeInboundPrompt,
} from '../../src/agentBus/busContent';
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

function setAge(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

/**
 * The lines `usage()` prints: the leading comment block of the client (after the
 * shebang, up to the first non-# line). Mirrors the awk in `usage()` so a change
 * to either is caught here, not only by a bash-gated client run.
 */
function usageLines(script: string): string[] {
  const lines = script.split('\n');
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('#')) out.push(lines[i]);
    else break;
  }
  return out;
}

describe('CLIENT_SCRIPT usage block', () => {
  it('covers every verb and the text-source note (a new verb cannot truncate it)', () => {
    const usage = usageLines(CLIENT_SCRIPT).join('\n');
    // Every verb the client accepts must be documented in the usage block.
    for (const verb of ['reply', 'say', 'send', 'steer', 'cancel', 'join', 'who']) {
      expect(usage).toContain(`forge.sh ${verb}`);
    }
    // The note that was silently cut off when `who` pushed it past the old
    // `sed -n '2,7p'` range: a fixed range is exactly the bug this guards.
    expect(usage).toContain('The text comes from the file, or from stdin');
    // Implementation comments below the block are for maintainers, not users.
    expect(usage).not.toContain('usage prints');
  });
});

describe('ensureBus', () => {
  it('creates the folders and the shipped files in an empty home', () => {
    ensureBus(paths);
    expect(fs.existsSync(paths.inbox)).toBe(true);
    expect(fs.existsSync(paths.outbox)).toBe(true);
    expect(fs.readFileSync(path.join(paths.root, 'README.md'), 'utf8')).toBe(BUS_README);
    expect(fs.readFileSync(paths.script, 'utf8')).toBe(CLIENT_SCRIPT);
  });

  it('rewrites a stale client so the disk never drifts from the code', () => {
    ensureBus(paths);
    fs.writeFileSync(paths.script, 'old hand-written client');
    ensureBus(paths);
    expect(fs.readFileSync(paths.script, 'utf8')).toBe(CLIENT_SCRIPT);
  });

  it('deletes what the watcher design left behind', () => {
    ensureBus(paths);
    fs.writeFileSync(path.join(paths.root, 'watch.sh'), '');
    fs.writeFileSync(path.join(paths.root, 'listening'), '');
    fs.writeFileSync(path.join(paths.inbox, 'fg1-a-forge.md.notified'), '');
    ensureBus(paths);
    expect(fs.readdirSync(paths.root).sort()).toEqual(['README.md', 'forge.sh', 'inbox', 'outbox']);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('ships the real forge.sh verbatim, LF-only, as valid bash', (ctx) => {
    // The script is a file bundled as text (MESH_RUN_1_FINDINGS F1), so bash
    // syntax such as `${1:-}` survives and a CRLF checkout cannot break it.
    expect(CLIENT_SCRIPT.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(CLIENT_SCRIPT).toContain('"Authorization: Bearer $TOKEN" \\\n');
    expect(CLIENT_SCRIPT).toContain('VERB="${1:-}"');
    expect(CLIENT_SCRIPT).not.toContain('\r');
    // On a Windows PATH without Git's bash, `bash` is the WSL launcher: with no
    // usable distro it exits 1 and prints a UTF-16 error to stdout, which read
    // as a syntax failure of forge.sh. Only a bash that runs can judge syntax.
    const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
    if (probe.error || probe.stdout.trim() !== 'ok') ctx.skip();
    // Script on stdin: no Windows path for a bash to translate.
    const check = spawnSync('bash', ['-n'], { input: CLIENT_SCRIPT, encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });

  it('ships a README with the size limit filled in', () => {
    expect(BUS_README).toContain('at most\n8000 characters');
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
    // Never `.md`: a leftover 0.16.4 watcher globs inbox/*.md.
    expect(fs.readdirSync(paths.inbox)).toEqual(['fg1-a-forge.pending']);
    const text = fs.readFileSync(path.join(paths.inbox, 'fg1-a-forge.pending'), 'utf8');
    expect(text.startsWith('Subject: subj\n')).toBe(true);
    expect(text).toContain('outbox/fg1-a-reply.md');
  });

  it('returns a reply that lands during the wait', async () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    setTimeout(() => writeReply(paths, 'fg1-a', 'the answer'), 50);
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
    writeReply(paths, 'fg1-a', 'answer');
    await waitForReply(paths, 'fg1-a', 1_000, undefined, 10);
    clearExchange(paths, 'fg1-a');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });
});

describe('writeReply', () => {
  it('lands atomically where waitForReply looks', async () => {
    writeReply(paths, 'fg1-a', 'routed answer');
    expect(fs.readdirSync(paths.outbox)).toEqual(['fg1-a-reply.md']);
    await expect(waitForReply(paths, 'fg1-a', 100, undefined, 10)).resolves.toBe('routed answer');
  });

  it('refuses an id that could name another file', () => {
    expect(() => writeReply(paths, '../evil', 'x')).toThrow(/not a bus id/);
    expect(() => writeReply(paths, '', 'x')).toThrow(/not a bus id/);
  });
});

describe('late replies', () => {
  beforeEach(() => ensureBus(paths));

  it('are announced once, then deleted, and never repeated', () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    withdrawQuestion(paths, 'fg1-a');
    writeReply(paths, 'fg1-a', 'late');
    expect(takeOrphans(paths, 3)).toEqual({ shown: [{ id: 'fg1-a', text: 'late' }], more: 0 });
    expect(takeOrphans(paths, 3)).toEqual({ shown: [], more: 0 });
  });

  it('are not claimed while the question is still pending', () => {
    writeQuestion(paths, 'fg1-a', 's', 'q');
    writeReply(paths, 'fg1-a', 'on time');
    expect(takeOrphans(paths, 3).shown).toEqual([]);
  });

  it("never claims another asker's reply", () => {
    writeReply(paths, 'sh123-99', 'a codex answer');
    expect(takeOrphans(paths, 3).shown).toEqual([]);
    expect(fs.existsSync(path.join(paths.outbox, 'sh123-99-reply.md'))).toBe(true);
  });

  it('caps the list and counts the rest', () => {
    for (const id of ['fg1-a', 'fg2-b', 'fg3-c', 'fg4-d']) writeReply(paths, id, id);
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

describe('messages', () => {
  it('a Claude question carries the id and a runnable reply command', () => {
    const msg = claudeQuestion(
      'C:\\Users\\me\\.forge\\agent-bus\\forge.sh',
      'fg1-a',
      'subj',
      'body',
    );
    expect(msg).toContain('[Forge asks, question fg1-a] subj');
    expect(msg).toContain(
      `bash "C:/Users/me/.forge/agent-bus/forge.sh" reply fg1-a <<'FORGE_REPLY'`,
    );
    expect(msg).toContain('body');
  });

  it('an inbound message names its sender and how to answer', () => {
    const prompt = forgeInboundPrompt('forge-dd', '  hi  ');
    expect(prompt.startsWith('**forge-dd says:**\n\nhi\n')).toBe(true);
    expect(prompt).toContain('session: "forge-dd"');
  });

  it('a Codex question carries the reply contract with a forward-slash path', () => {
    const msg = codexMessage('C:\\bus\\outbox\\fg1-a-reply.md', 'fg1-a', 'subj', 'body');
    expect(msg).toContain('C:/bus/outbox/fg1-a-reply.md.tmp');
    expect(msg).toContain('body');
    expect(msg).toContain('Codex says:');
    expect(msg).not.toContain('\\');
  });
});
