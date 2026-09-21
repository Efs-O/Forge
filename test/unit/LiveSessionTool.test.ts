import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, ensureBus, type BusPaths } from '../../src/agentBus/agentBus';
import type { ClaudeSession } from '../../src/agentBus/claudePeer';
import { setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import type { MeshAdapter } from '../../src/agentMesh/meshAdapter';
import type { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import { makeLiveSessionTool } from '../../src/tools/liveSessionTool';
import type { ForgeConfig } from '../../src/config/types';

let home: string;
let paths: BusPaths;
let enabled: boolean;
let codexThread: string | undefined;
let claudeSession: string | undefined;
let sessions: ClaudeSession[];
let sent: { session: string; message: string }[];
let sendFails: boolean;
let queued: { cli: string; thread: string; message: string }[];
let queueFails: boolean;

const ROOT = path.resolve('/work/forge');

function session(name: string, cwd = ROOT, extra: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 100,
    name,
    cwd,
    status: 'idle',
    sdk: false,
    pipe: 'pipe',
    peerProtocol: 1,
    startedAt: 1,
    ...extra,
  };
}

const tool = (): ReturnType<typeof makeLiveSessionTool> =>
  makeLiveSessionTool({
    getConfig: () =>
      ({
        agent_bus: {
          enabled,
          codex_thread: codexThread,
          codex_cli: 'codex',
          claude_session: claudeSession,
          claude_transport: 'pipe',
          claude_cli: 'claude',
          relay_model: 'haiku',
        },
      }) as unknown as ForgeConfig,
    workspaceRoots: () => [ROOT],
    paths: () => paths,
    claudeSessions: () => sessions,
    sendClaude: (s, message) => {
      if (sendFails) return Promise.reject(new Error('pipe is gone'));
      sent.push({ session: s.name, message });
      return Promise.resolve();
    },
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
  claudeSession = undefined;
  sessions = [session('forge-dd')];
  sent = [];
  sendFails = false;
  queued = [];
  queueFails = false;
  setMeshOrchestrator(undefined);
  ensureBus(paths);
});

afterEach(async () => {
  setMeshOrchestrator(undefined);
  await fs.promises.rm(home, { recursive: true, force: true });
});

/** Answer the first question that appears, the way forge.sh's fallback would. */
function answerNextQuestion(text: string): void {
  const timer = setInterval(() => {
    const q = fs.readdirSync(paths.inbox).find((n) => n.endsWith('-forge.pending'));
    if (!q) return;
    clearInterval(timer);
    const file = path.join(paths.outbox, q.replace(/-forge\.pending$/, '-reply.md'));
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  }, 20);
}

const ask = { subject: 'Does X hold?', question: 'Check X.', wait_minutes: 1 };

/** A fake orchestrator whose `ask` runs the adapter, as the alias FIFO does. */
let asked: string[] = [];
function installMeshAdapter(adapter: MeshAdapter, alias = 'codex'): void {
  setMeshOrchestrator({
    resolveAdapter: async (a: string) => {
      if (a !== alias) throw new Error(`unexpected alias: ${a}`);
      return adapter;
    },
    ask: async (to: string, message: string) => {
      asked.push(to);
      return adapter.send(message);
    },
  } as unknown as MeshOrchestrator);
}

describe('ask_live_session', () => {
  it('is not advertised, and refuses, while agent_bus is disabled', async () => {
    enabled = false;
    const t = tool();
    expect(t.advertise?.()).toBe(false);
    await expect(t.handler(ask)).rejects.toThrow(/disabled/);
  });

  it('with no live session, answers at once and sends nothing', async () => {
    sessions = [];
    const started = Date.now();
    const result = await tool().handler(ask);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toContain('nothing was sent');
    expect(result).toContain('ask_local_agent');
    expect(sent).toEqual([]);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('sends into the one session in this workspace and returns the exchange', async () => {
    sessions = [session('forge-dd'), session('elsewhere', path.resolve('/other'))];
    answerNextQuestion('Yes, X holds.');
    const result = await tool().handler(ask);
    expect(sent).toHaveLength(1);
    expect(sent[0].session).toBe('forge-dd');
    expect(sent[0].message).toContain('Check X.');
    expect(sent[0].message).toMatch(/forge\.sh" reply fg\d+-[0-9a-f]{8} <</);
    expect(result).toContain('**Asked Claude (forge-dd):** Does X hold?');
    expect(result).toContain('**Claude (forge-dd) says:**');
    expect(result).toContain('Yes, X holds.');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });

  it('never guesses between several sessions in this workspace', async () => {
    sessions = [session('forge-dd'), session('forge-ef')];
    const result = await tool().handler(ask);
    expect(result).toContain('Several');
    expect(result).toContain('`forge-dd`');
    expect(result).toContain('`forge-ef`');
    expect(result).toContain('claude_session');
    expect(sent).toEqual([]);
  });

  it('picks by name from the argument, then from config, in any folder', async () => {
    sessions = [session('forge-dd'), session('review', path.resolve('/other'))];
    answerNextQuestion('a');
    await tool().handler({ ...ask, session: 'REVIEW' });
    expect(sent[0].session).toBe('review');

    claudeSession = 'forge-dd';
    answerNextQuestion('b');
    await tool().handler(ask);
    expect(sent[1].session).toBe('forge-dd');
  });

  it('skips SDK-launched sessions unless named', async () => {
    sessions = [session('forge-dd'), session('bot', ROOT, { sdk: true })];
    answerNextQuestion('a');
    await tool().handler(ask);
    expect(sent[0].session).toBe('forge-dd');
  });

  it('reports a named session that is not running', async () => {
    const result = await tool().handler({ ...ask, session: 'ghost' });
    expect(result).toContain('No live Claude Code session is named `ghost`');
    expect(result).toContain('`forge-dd`');
    expect(sent).toEqual([]);
  });

  it('a failed send withdraws the question and reports the reason', async () => {
    sendFails = true;
    const result = await tool().handler(ask);
    expect(result).toContain('NOT sent');
    expect(result).toContain('pipe is gone');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('on /stop, returns promptly and withdraws the question', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await tool().handler(ask, { abortSignal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toContain('Stopped');
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });

  it('shows an answer that arrived after a stop at the start of the next call, once', async () => {
    const controller = new AbortController();
    controller.abort();
    await tool().handler(ask, { abortSignal: controller.signal });
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
    fs.writeFileSync(path.join(paths.outbox, 'fg1-zz-reply.md'), 'late answer');

    sessions = [];
    const next = await tool().handler(ask);
    expect(next).toContain('**Late answer**');
    expect(next).toContain('late answer');
    const again = await tool().handler(ask);
    expect(again).not.toContain('late answer');
  });

  it('rejects a multi-line subject, an out-of-range wait and an empty session', async () => {
    await expect(tool().handler({ ...ask, subject: 'a\nb' })).rejects.toThrow(/one line/);
    await expect(tool().handler({ ...ask, wait_minutes: 21 })).rejects.toThrow(/wait_minutes/);
    await expect(tool().handler({ ...ask, session: ' ' })).rejects.toThrow(/session/);
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

    it('queues into the thread, never touches Claude, and labels the answer', async () => {
      codexThread = 'thread-1';
      installMeshAdapter({
        kind: 'codex',
        observesTurns: false,
        send: async () => ({ status: 'completed' }),
      });
      answerNextQuestion('Yes from Codex.');
      const result = await tool().handler(askCodex);
      expect(sent).toEqual([]);
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
      installMeshAdapter({
        kind: 'codex',
        observesTurns: false,
        send: async () => ({ status: 'completed' }),
      });
      const result = await tool().handler(askCodex);
      expect(result).toContain('NOT sent');
      expect(result).toContain('thread not found');
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
    });

    it('uses an owned mesh session and returns its answer without a reply file', async () => {
      const messages: string[] = [];
      installMeshAdapter({
        kind: 'codex',
        observesTurns: true,
        send: async (message) => {
          messages.push(message);
          return { status: 'completed', finalText: 'Owned Codex answer.' };
        },
      });
      const result = await tool().handler(askCodex);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^\[Forge agent bus, question .+\] Does X hold\?\n\nCheck X\.$/);
      expect(messages[0]).not.toContain('reply.md');
      expect(result).toContain('**Asked Codex:** Does X hold?');
      expect(result).toContain('**Codex says:**\n\nOwned Codex answer.');
      expect(queued).toEqual([]);
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
      expect(fs.readdirSync(paths.outbox)).toEqual([]);
    });

    it('reports an owned-session failure without waiting for an outbox reply', async () => {
      installMeshAdapter({
        kind: 'codex',
        observesTurns: true,
        send: async () => ({ status: 'failed' }),
      });
      const result = await tool().handler(askCodex);
      expect(result).toContain('Codex could not answer: its session failed');
      expect(queued).toEqual([]);
      expect(fs.readdirSync(paths.inbox)).toEqual([]);
      expect(fs.readdirSync(paths.outbox)).toEqual([]);
    });

    it('asks an owned session through the orchestrator FIFO, never a direct send', async () => {
      asked = [];
      installMeshAdapter({
        kind: 'codex',
        observesTurns: true,
        send: async () => ({ status: 'completed', finalText: 'via fifo' }),
      });
      const result = await tool().handler(askCodex);
      expect(asked).toEqual(['codex']);
      expect(result).toContain('via fifo');
    });

    it('rejects an unknown target', async () => {
      await expect(tool().handler({ ...ask, target: 'gpt' })).rejects.toThrow(/target/);
    });
  });
});
