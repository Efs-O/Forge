import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busPaths } from '../../src/agentBus/agentBus';
import { appendEvent, compact, readEvents, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
import { subscribeLiveAnswerNotices } from '../../src/agentBus/liveAnswerNotices';
import { createSidebarPromptRouter } from '../../src/sidebar/backgroundExitNotice';
import {
  acknowledgeVerdict,
  readVerdictArtifact,
  retainVerdict,
  verdictArtifactPath,
} from '../../src/agentMesh/verdictArtifact';
import { createMeshVerdictPoll } from '../../src/vscode/meshVerdictPoll';

describe('full verdict retention', () => {
  let home: string;
  let paths: ReturnType<typeof busPaths>;
  let exchangePaths: ExchangeLogPaths;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verdict-'));
    paths = busPaths(home);
    exchangePaths = {
      log: path.join(paths.root, 'exchanges.jsonl'),
      lock: path.join(paths.root, 'exchanges.lock'),
    };
    fs.mkdirSync(paths.outbox, { recursive: true });
    await appendEvent(exchangePaths, {
      eventId: 'start-x1', ts: 1, exchangeId: 'x1', workspace: 'work',
      from: 'codex', to: 'forge', type: 'state', state: 'created',
    });
    await appendEvent(exchangePaths, {
      eventId: 'accepted-x1', ts: 2, exchangeId: 'x1', workspace: 'work',
      from: 'forge', to: 'codex', type: 'state', state: 'accepted',
    });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function poll() {
    const instance = createMeshVerdictPoll({
      outboxDir: paths.outbox,
      exchangePaths,
      onEvent: async (event) => {
        await appendEvent(exchangePaths, {
          ...event,
          eventId: event.eventId ?? 'unexpected',
          ts: Date.now(), workspace: 'work',
        });
      },
    });
    return instance;
  }

  async function addVerdict(exchangeId: string, originConversation?: string): Promise<void> {
    await appendEvent(exchangePaths, {
      eventId: `created-${exchangeId}`, ts: 10, exchangeId, workspace: 'work',
      from: 'codex', to: 'claude', type: 'relay', state: 'created',
      ...(originConversation ? { originConversation } : {}),
    });
    await appendEvent(exchangePaths, {
      eventId: `accepted-${exchangeId}`, ts: 11, exchangeId, workspace: 'work',
      from: 'forge', to: 'claude', type: 'relay', state: 'accepted',
    });
    const artifact = verdictArtifactPath(paths.root, exchangeId);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, `verdict for ${exchangeId}`);
    await appendEvent(exchangePaths, {
      eventId: `verdict-${exchangeId}`, ts: 12, exchangeId, workspace: 'work',
      from: 'forge', type: 'verdict', state: 'completed',
    });
  }

  function listen(open: (id: string) => boolean, route: (...args: unknown[]) => void) {
    return subscribeLiveAnswerNotices(open, route as never, () => undefined);
  }

  it('retains a verdict longer than the board detail until separate acknowledgment', async () => {
    const body = 'verdict with 900 characters: ' + 'v'.repeat(900);
    fs.writeFileSync(path.join(paths.outbox, 'x1.verdict.md'), body);
    const first = poll();
    await first.pollOnce();
    first.dispose();

    const verdicts = readEvents(exchangePaths.log).filter((event) => event.type === 'verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.detail?.length).toBeLessThan(500);
    expect(readVerdictArtifact(paths, 'x1', 'codex')).toBe(body);
    expect(readVerdictArtifact(paths, 'x1', 'codex')).toBe(body);
    expect(() => readVerdictArtifact(paths, 'x1', 'claude')).toThrow();
    await compact(exchangePaths, { maxExchanges: 0, ttlMs: 0 });
    expect(readVerdictArtifact(paths, 'x1', 'codex')).toBe(body);
    acknowledgeVerdict(paths, 'x1', 'codex');
    expect(fs.existsSync(verdictArtifactPath(paths.root, 'x1'))).toBe(false);
    await compact(exchangePaths, { maxExchanges: 0, ttlMs: 0 });
    expect(readEvents(exchangePaths.log)).toHaveLength(0);
  });

  it('recovers an artifact moved before its event, with one terminal event across two windows', async () => {
    const source = path.join(paths.outbox, 'x1.verdict.md');
    fs.writeFileSync(source, 'full crash-safe verdict');
    retainVerdict(paths.root, source, 'x1');
    const a = poll();
    const b = poll();
    await Promise.all([a.pollOnce(), b.pollOnce()]);
    a.dispose();
    b.dispose();
    expect(readEvents(exchangePaths.log).filter((event) => event.type === 'verdict')).toHaveLength(1);
    expect(readVerdictArtifact(paths, 'x1', 'codex')).toBe('full crash-safe verdict');
  });

  it('ignores an orphan and tolerates a verdict removed between scan and move', async () => {
    fs.writeFileSync(path.join(paths.outbox, 'orphan.verdict.md'), 'orphan');
    fs.writeFileSync(path.join(paths.outbox, 'x1.verdict.md'), 'moved elsewhere');
    const race = createMeshVerdictPoll({
      outboxDir: paths.outbox,
      exchangePaths,
      onEvent: async () => { throw new Error('must not append'); },
      moveVerdict: (_root, source) => {
        fs.unlinkSync(source);
        throw Object.assign(new Error('removed by another window'), { code: 'ENOENT' });
      },
    });
    await expect(race.pollOnce()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(paths.outbox, 'orphan.verdict.md'))).toBe(false);
    expect(readEvents(exchangePaths.log).filter((event) => event.type === 'verdict')).toHaveLength(0);
  });

  it('7: delivers one wake across two polls and skips exchanges without an origin', async () => {
    await addVerdict('wake7', 'chat-7');
    await addVerdict('no-origin7');
    const route = vi.fn();
    const subscription = listen(() => true, route);
    const instance = poll();
    try {
      await instance.pollOnce();
      await instance.pollOnce();
      expect(route).toHaveBeenCalledOnce();
      const deliveredText = route.mock.calls[0]?.[0] as string;
      expect(deliveredText).toContain('claude answered exchange wake7');
      expect(deliveredText).toContain('forge.sh read-verdict codex wake7');
      expect(route.mock.calls[0]?.slice(1)).toEqual(['chat-7', false, true]);
      expect(readEvents(exchangePaths.log).filter((event) => event.eventId === 'wake-wake7'))
        .toHaveLength(1);
    } finally {
      instance.dispose();
      subscription.dispose();
    }
  });

  it('8: leaves a wake for a window without the chat, then delivers once in the open window', async () => {
    await addVerdict('wake8', 'chat-8');
    const routeA = vi.fn();
    const subscriptionA = listen(() => false, routeA);
    const windowA = poll();
    await windowA.pollOnce();
    expect(readEvents(exchangePaths.log).some((event) => event.eventId === 'wake-wake8')).toBe(false);
    windowA.dispose();
    subscriptionA.dispose();

    const routeB = vi.fn();
    const subscriptionB = listen(() => true, routeB);
    const windowB = poll();
    await windowB.pollOnce();
    await windowA.pollOnce();
    expect(routeA).not.toHaveBeenCalled();
    expect(routeB).toHaveBeenCalledOnce();
    expect(readEvents(exchangePaths.log).filter((event) => event.eventId === 'wake-wake8'))
      .toHaveLength(1);
    windowB.dispose();
    subscriptionB.dispose();
  });

  it('9: skips a wake event already appended before the pass runs', async () => {
    await addVerdict('wake9', 'chat-9');
    const prior = readEvents(exchangePaths.log);
    fs.appendFileSync(exchangePaths.log, `${JSON.stringify({
      seq: Math.max(...prior.map((event) => event.seq)) + 1,
      eventId: 'wake-wake9', ts: 13, exchangeId: 'wake9', workspace: 'work',
      from: 'forge', type: 'wake', state: 'completed',
    })}\n`);
    const route = vi.fn();
    const subscription = listen(() => true, route);
    const instance = poll();
    try {
      await expect(instance.pollOnce()).resolves.toBeUndefined();
      expect(route).not.toHaveBeenCalled();
    } finally {
      instance.dispose();
      subscription.dispose();
    }
  });

  it('10: routes a wake for a busy chat into the real internal prompt queue', async () => {
    await addVerdict('wake10', 'busy-chat');
    const addTell = vi.fn();
    const send = vi.fn();
    const router = createSidebarPromptRouter({
      activeId: () => 'busy-chat',
      isReserved: () => true,
      addTell,
      removeTell: () => true,
      send,
      isOpen: (id) => id === 'busy-chat',
    });
    const instance = poll();
    try {
      await instance.pollOnce();
      expect(addTell).toHaveBeenCalledOnce();
      expect(addTell.mock.calls[0]?.slice(0, 3)).toMatchObject([
        'busy-chat', expect.stringContaining('answered exchange wake10'), true,
      ]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      instance.dispose();
      router.dispose();
    }
  });
});
