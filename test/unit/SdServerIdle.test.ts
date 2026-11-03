import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSdServerIdleStopPolicy,
  startSdServerOrphanMonitor,
  type SdServerIdleFacts,
} from '../../src/backend/sdServerIdle';
import { sdServerBaseUrl, sdServerSignature } from '../../src/backend/sdServerArgs';
import {
  sdServerRecordPath,
  writeSdServerRecord,
  type SdProcessIdentity,
  type SdServerOwnerRecord,
} from '../../src/backend/sdServerOwnerRecord';
import { logger } from '../../src/util/logger';
import type { SdcppImageBackendConfig } from '../../src/config/types';
import { sdcppBackendConfig } from '../support/sdServerFixtures';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

/**
 * The idle-stop policy that used to live in `SdServerBackend.ts` and
 * `sdServerReconciliation.ts`: the owner's local deadline, the shared-deadline
 * re-arm, the identity refusal, and the sweep for a record whose starter died.
 * Fake timers, fake callbacks, no process. `test/unit/SdServerBackend.test.ts`
 * still covers the same policy end to end through the real backend; these
 * cases pin the states those tests cannot reach without a child process, and
 * they assert `vi.getTimerCount()` so "what cancelled the stop" is answered by
 * the timer itself rather than by the absence of a call that had not run yet.
 *
 * Deadlines are read from `Date.now()`, which fake timers mock and
 * `advanceTimersByTimeAsync` moves, so the clock the policy sees and the clock
 * the timers run on stay the same clock.
 */

let root: string;
let recordPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sd-idle-'));
  recordPath = sdServerRecordPath(path.join(root, 'records'), 'qwen-local');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeOwnedRecord(config: SdcppImageBackendConfig): SdServerOwnerRecord {
  return {
    pid: 200,
    pidCreatedAt: 2000,
    port: config.port,
    binary: config.binary,
    diffusionModel: config.diffusion_model,
    signature: sdServerSignature(config),
    ownerPid: 100,
    ownerCreatedAt: 1000,
    startedAt: 10_000,
    lastUsedAt: 10_000,
  };
}

interface IdleRig {
  policy: ReturnType<typeof createSdServerIdleStopPolicy>;
  config: SdcppImageBackendConfig;
  facts: SdServerIdleFacts;
  stop: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  /** Replace the record the deadline will read; no argument means no record at all. */
  setRecord: (changes?: Partial<SdServerOwnerRecord>) => void;
  advance: (ms: number) => Promise<void>;
}

function idleRig(start: number): IdleRig {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const config = sdcppBackendConfig(root);
  const facts: SdServerIdleFacts = { ownsProcess: true, ready: true, disposed: false };
  const stop = vi.fn(async () => {});
  const log = vi.fn();
  let current: SdServerOwnerRecord | undefined = makeOwnedRecord(config);
  return {
    config,
    facts,
    stop,
    log,
    setRecord: (changes) => {
      current = changes === undefined ? undefined : { ...makeOwnedRecord(config), ...changes };
    },
    policy: createSdServerIdleStopPolicy({
      idleTimeoutMs: config.idle_timeout_ms,
      recordPath,
      now: () => Date.now(),
      facts: () => ({ ...facts }),
      readCurrentRecord: async () => current,
      ownedRecord: () => makeOwnedRecord(config),
      stopOwnedProcess: stop,
      log,
    }),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('SdServerIdle owner timer', () => {
  it('stops the owned server at the local deadline and not before', async () => {
    const rig = idleRig(10_000);
    // The shared record is as quiet as this window's last use, so the local
    // deadline is also the shared one and nothing has to be re-armed.
    rig.setRecord({ lastUsedAt: 10_000 });
    rig.policy.useFinished();
    expect(vi.getTimerCount()).toBe(1);

    await rig.advance(rig.config.idle_timeout_ms - 1);
    expect(rig.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await rig.advance(1);
    expect(rig.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms on the shared deadline in the owner record instead of cutting across another window', async () => {
    const rig = idleRig(10_000);
    // Another window used this server 30s after this window's last use, so the
    // shared deadline sits 30s past the local one: this window re-arms by that
    // much, and no further than that.
    rig.setRecord({ lastUsedAt: 10_000 + 30_000 });
    rig.policy.useFinished();

    await rig.advance(rig.config.idle_timeout_ms);
    expect(rig.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await rig.advance(30_000 - 1);
    expect(rig.stop).not.toHaveBeenCalled();
    await rig.advance(1);
    expect(rig.stop).toHaveBeenCalledTimes(1);
  });

  it('a use in flight cancels an armed stop and re-arms from its own last use', async () => {
    const rig = idleRig(10_000);
    rig.setRecord({ lastUsedAt: 10_000 });
    rig.policy.useFinished();
    expect(vi.getTimerCount()).toBe(1);
    rig.policy.useStarted();
    expect(vi.getTimerCount()).toBe(0);

    await rig.advance(rig.config.idle_timeout_ms * 2);
    expect(rig.stop).not.toHaveBeenCalled();

    rig.policy.useFinished();
    await rig.advance(rig.config.idle_timeout_ms);
    expect(rig.stop).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels a pending stop', async () => {
    const rig = idleRig(10_000);
    rig.setRecord({ lastUsedAt: 10_000 });
    rig.policy.useFinished();
    expect(vi.getTimerCount()).toBe(1);
    rig.policy.clear();
    expect(vi.getTimerCount()).toBe(0);

    await rig.advance(rig.config.idle_timeout_ms * 2);
    expect(rig.stop).not.toHaveBeenCalled();
  });

  it('refuses to stop when the owner record changed process identity, and leaves the server', async () => {
    const rig = idleRig(10_000);
    // Another window respawned on this port while this one idled: the record
    // now names a different pid, so killing it would kill the wrong process.
    rig.setRecord({ pid: 300, pidCreatedAt: 3000 });
    rig.policy.useFinished();

    await rig.advance(rig.config.idle_timeout_ms);
    expect(rig.stop).not.toHaveBeenCalled();
    expect(rig.log).toHaveBeenCalledTimes(1);
    expect(rig.log).toHaveBeenCalledWith(
      `[Forge] Could not stop idle sd-server: sd-server owner record "${recordPath}" ` +
        'changed process identity while idle; the running server was left untouched.',
    );
  });

  it('arms from the arming time when this window has not used the server yet', async () => {
    const rig = idleRig(10_000);
    rig.setRecord({ lastUsedAt: 10_000 });
    rig.policy.schedule();

    await rig.advance(rig.config.idle_timeout_ms - 1);
    expect(rig.stop).not.toHaveBeenCalled();
    await rig.advance(1);
    expect(rig.stop).toHaveBeenCalledTimes(1);
  });

  it('stops with no owner record to check, which means no other window could have reached it', async () => {
    const rig = idleRig(10_000);
    rig.setRecord();
    rig.policy.useFinished();

    await rig.advance(rig.config.idle_timeout_ms);
    expect(rig.stop).toHaveBeenCalledTimes(1);
    expect(rig.log).not.toHaveBeenCalled();
  });

  it.each([
    ['a window with no owned process', { ownsProcess: false, ready: true, disposed: false }],
    [
      'a server that has not answered readiness',
      { ownsProcess: true, ready: false, disposed: false },
    ],
    ['a window that is disposing', { ownsProcess: true, ready: true, disposed: true }],
  ])('arms nothing when %s', async (_label, variant) => {
    const rig = idleRig(10_000);
    rig.setRecord({ lastUsedAt: 10_000 });
    Object.assign(rig.facts, variant);
    // `useFinished()` runs the same guard, so one of these proves both paths.
    rig.policy.schedule();
    rig.policy.useFinished();
    expect(vi.getTimerCount()).toBe(0);

    await rig.advance(rig.config.idle_timeout_ms * 2);
    expect(rig.stop).not.toHaveBeenCalled();
  });

  it('the deadline guard ignores readiness, so a server that stopped answering is still stopped', async () => {
    const rig = idleRig(10_000);
    rig.setRecord({ lastUsedAt: 10_000 });
    rig.policy.useFinished();
    // Armed while ready; it went unresponsive afterwards. Only the use count
    // and ownership guard the deadline, exactly as before the split.
    rig.facts.ready = false;

    await rig.advance(rig.config.idle_timeout_ms);
    expect(rig.stop).toHaveBeenCalledTimes(1);
  });
});

describe('SdServerIdle orphan sweep', () => {
  interface SweepRig {
    monitor: { dispose: () => void };
    processes: Map<number, SdProcessIdentity>;
    lookup: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    capabilities: ReturnType<typeof vi.fn>;
    advance: (ms: number) => Promise<void>;
  }

  function sweepRig(
    options: { terminate?: (pid: number) => Promise<void>; start?: number } = {},
  ): SweepRig {
    vi.useFakeTimers();
    vi.setSystemTime(options.start ?? 100_000);
    const config = sdcppBackendConfig(root);
    const processes = new Map<number, SdProcessIdentity>([
      [200, { executablePath: config.binary, createdAt: 2000 }],
    ]);
    const lookup = vi.fn(async (pid: number) => processes.get(pid));
    const terminate = vi.fn(async (pid: number) => {
      if (options.terminate) await options.terminate(pid);
      else processes.delete(pid);
    });
    const capabilities = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ model: { path: config.diffusion_model } })),
    );
    return {
      processes,
      lookup,
      terminate,
      capabilities,
      monitor: startSdServerOrphanMonitor({
        config,
        recordPath,
        fetchImpl: capabilities as unknown as typeof fetch,
        lookupProcess: lookup,
        terminateProcess: terminate,
        now: () => Date.now(),
      }),
      advance: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
    };
  }

  it('waits out the shared deadline, then reaps the verified orphan', async () => {
    const config = sdcppBackendConfig(root);
    const rig = sweepRig();
    // The starter died and the last use is 15s short of the deadline, so the
    // first sweep waits 46s more rather than killing a possibly-rendering server.
    await writeSdServerRecord(recordPath, { ...makeOwnedRecord(config), lastUsedAt: 115_000 });

    await rig.advance(30_000);
    await vi.waitFor(() => expect(rig.lookup).toHaveBeenCalledWith(100));
    expect(rig.terminate).not.toHaveBeenCalled();
    // A reap never probes the dead owner's server, so the shared base URL is
    // only ever handed to `reconcileSdServerRecord` for the adoption path.
    expect(rig.capabilities).not.toHaveBeenCalled();
    expect(fs.existsSync(recordPath)).toBe(true);

    await rig.advance(46_000);
    await vi.waitFor(() => expect(rig.terminate).toHaveBeenCalledWith(200));
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('logs a failed reap, keeps the record, and retries at the next interval', async () => {
    const config = sdcppBackendConfig(root);
    let attempts = 0;
    const rig = sweepRig({
      terminate: async (pid) => {
        attempts++;
        if (attempts === 1) throw new Error('simulated taskkill failure');
        rig.processes.delete(pid);
      },
    });
    await writeSdServerRecord(recordPath, {
      ...makeOwnedRecord(config),
      lastUsedAt: 100_000 - config.idle_timeout_ms - 1,
    });
    const error = vi.spyOn(logger, 'error');

    await rig.advance(30_000);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`Idle owner sweep failed for ${config.name}.`),
        expect.any(Error),
      ),
    );
    expect(rig.terminate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(recordPath)).toBe(true);

    await rig.advance(30_000);
    await vi.waitFor(() => expect(rig.terminate).toHaveBeenCalledTimes(2));
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it('dispose cancels the pending sweep, so no live window keeps re-checking it', async () => {
    const config = sdcppBackendConfig(root);
    const rig = sweepRig();
    await writeSdServerRecord(recordPath, {
      ...makeOwnedRecord(config),
      lastUsedAt: 100_000 - config.idle_timeout_ms - 1,
    });
    expect(vi.getTimerCount()).toBe(1);
    rig.monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
    rig.lookup.mockClear();

    await rig.advance(60_000);

    expect(rig.lookup).not.toHaveBeenCalled();
    expect(rig.terminate).not.toHaveBeenCalled();
    expect(fs.existsSync(recordPath)).toBe(true);
  });
});

describe('sdServerBaseUrl', () => {
  it('is the one place the loopback address is written', () => {
    const config = sdcppBackendConfig(root);
    expect(sdServerBaseUrl(config)).toBe(`http://127.0.0.1:${config.port}`);
    expect(sdServerBaseUrl({ ...config, port: 8111 })).toBe('http://127.0.0.1:8111');
  });
});
