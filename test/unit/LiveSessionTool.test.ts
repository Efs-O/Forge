import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, ensureBus, type BusPaths } from '../../src/agentBus/agentBus';
import { makeLiveSessionTool } from '../../src/tools/liveSessionTool';
import type { ForgeConfig } from '../../src/config/types';

let home: string;
let paths: BusPaths;
let enabled: boolean;
let codexThread: string | undefined;
let queued: { cli: string; thread: string; message: string }[];
let queueFails: boolean;

const tool = (): ReturnType<typeof makeLiveSessionTool> =>
  makeLiveSessionTool({
    getConfig: () =>
      ({
        agent_bus: { enabled, codex_thread: codexThread, codex_cli: 'codex' },
      }) as unknown as ForgeConfig,
    paths: () => paths,
    queueCodex: (cli, thread, message) => {
      if (queueFails) return Promise.reject(new Error('thread not found'));
      queued.push({ cli, thread, message });
      return Promise.resolve();
    },
  });

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-live-session-'));
  paths = busPaths(home);
  enabled = true;
  codexThread = undefined;
  queued = [];
  queueFails = false;
  ensureBus(paths);
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

function beat(): void {
  fs.writeFileSync(paths.heartbeat, '');
}

/** Answer the first question that appears, the way a listener would. */
function answerNextQuestion(text: string): void {
  const timer = setInterval(() => {
    const q = fs.readdirSync(paths.inbox).find((n) => n.endsWith('-forge.md'));
    if (!q) return;
    clearInterval(timer);
    const file = path.join(paths.outbox, q.replace(/-forge\.md$/, '-reply.md'));
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  }, 20);
}

const ask = { subject: 'Does X hold?', question: 'Check X.', wait_minutes: 1 };

describe('ask_live_session', () => {
  it('is not advertised, and refuses, while agent_bus is disabled', async () => {
    enabled = false;
    const t = tool();
    expect(t.advertise?.()).toBe(false);
    await expect(t.handler(ask)).rejects.toThrow(/disabled/);
  });

  it('with no listener, answers at once, sends nothing, and shows the arm prompt', async () => {
    const started = Date.now();
    const result = await tool().handler(ask);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toContain('NOT sent');
    expect(result).toContain('watch.sh');
    expect(result).toContain('ask_local_agent');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('returns the exchange formatted for the chat, and leaves nothing behind', async () => {
    beat();
    answerNextQuestion('Subject: RE\n\nYes, X holds.');
    const result = await tool().handler(ask);
    expect(result).toContain('**Asked Claude:** Does X hold?');
    expect(result).toContain('**Claude says:**');
    expect(result).toContain('Yes, X holds.');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });

  it('on /stop, returns promptly and withdraws the question', async () => {
    beat();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await tool().handler(ask, { abortSignal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toContain('Stopped');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('shows an answer that arrived after a stop at the start of the next call, once', async () => {
    beat();
    const controller = new AbortController();
    controller.abort();
    await tool().handler(ask, { abortSignal: controller.signal });
    // The listener answers the withdrawn question anyway.
    const orphan = fs.readdirSync(paths.outbox).length;
    expect(orphan).toBe(0);
    fs.writeFileSync(path.join(paths.outbox, 'fg1-zz-reply.md'), 'late answer');

    fs.rmSync(paths.heartbeat);
    const next = await tool().handler(ask);
    expect(next).toContain('**Late answer**');
    expect(next).toContain('late answer');
    const again = await tool().handler(ask);
    expect(again).not.toContain('late answer');
  });

  it('rejects a multi-line subject and an out-of-range wait', async () => {
    await expect(tool().handler({ ...ask, subject: 'a\nb' })).rejects.toThrow(/one line/);
    await expect(tool().handler({ ...ask, wait_minutes: 21 })).rejects.toThrow(/wait_minutes/);
  });

  describe('target codex', () => {
    const askCodex = { ...ask, target: 'codex' };

    it('without a configured thread, sends nothing and says how to set one', async () => {
      const result = await tool().handler(askCodex);
      expect(result).toContain('NOT sent');
      expect(result).toContain('codex_thread');
      expect(queued).toEqual([]);
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
    });

    it('queues into the thread with no heartbeat, hides it from the Claude watcher, and labels the answer', async () => {
      codexThread = 'thread-1';
      answerNextQuestion('Yes from Codex.');
      const pending = tool().handler(askCodex);
      await new Promise((r) => setTimeout(r, 10));
      // The watcher's marker exists before the question does.
      const names = fs.readdirSync(paths.inbox);
      expect(names.some((n) => n.endsWith('-forge.md.notified'))).toBe(true);
      const result = await pending;
      expect(queued).toHaveLength(1);
      expect(queued[0].thread).toBe('thread-1');
      expect(queued[0].message).toContain('-reply.md.tmp');
      expect(queued[0].message).toContain('Check X.');
      expect(result).toContain('**Asked Codex:** Does X hold?');
      expect(result).toContain('**Codex says:**');
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
      expect(fs.readdirSync(paths.outbox)).toEqual([]);
    });

    it('a failed queue call withdraws the question and reports the reason', async () => {
      codexThread = 'thread-1';
      queueFails = true;
      const result = await tool().handler(askCodex);
      expect(result).toContain('NOT sent');
      expect(result).toContain('thread not found');
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
    });

    it('rejects an unknown target', async () => {
      await expect(tool().handler({ ...ask, target: 'gpt' })).rejects.toThrow(/target/);
    });
  });
});
