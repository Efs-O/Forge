import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths } from '../../src/agentBus/agentBus';
import { appendEvent, compact, readEvents, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
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
});
