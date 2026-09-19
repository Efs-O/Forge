import { describe, expect, it } from 'vitest';
import {
  getHostIdentity,
  isHostAlive,
  START_TIME_TOLERANCE_MS,
  type HostId,
  type HostLivenessDeps,
} from '../../src/agentMesh/hostIdentity';

/** A deps object that models a pid→start-time table and a liveness set. */
function deps(opts: {
  alivePids?: Set<number>;
  startTimes?: Record<number, number>;
  selfPid?: number;
}): HostLivenessDeps {
  const alivePids = opts.alivePids ?? new Set<number>();
  return {
    selfPid: opts.selfPid ?? 999_999,
    isAlive: (pid) => alivePids.has(pid),
    processStartMs: (pid) => opts.startTimes?.[pid],
  };
}

describe('host identity (M1/M2 staleness primitive)', () => {
  it('a dead pid is not alive', () => {
    const d = deps({ alivePids: new Set([2]) });
    expect(isHostAlive({ pid: 1, startedAt: 1000 }, d)).toBe(false);
  });

  it('this host is always alive', () => {
    const d = deps({ alivePids: new Set([5]), selfPid: 5 });
    expect(isHostAlive({ pid: 5, startedAt: 12345 }, d)).toBe(true);
  });

  it('a live pid with a matching start time is alive', () => {
    const d = deps({ alivePids: new Set([7]), startTimes: { 7: 5000 } });
    expect(isHostAlive({ pid: 7, startedAt: 5000 }, d)).toBe(true);
  });

  it('a live pid within the start-time tolerance is alive (OS jitter)', () => {
    const d = deps({ alivePids: new Set([7]), startTimes: { 7: 5000 + 1000 } });
    expect(START_TIME_TOLERANCE_MS).toBeGreaterThanOrEqual(1000);
    expect(isHostAlive({ pid: 7, startedAt: 5000 }, d)).toBe(true);
  });

  it('a live pid whose start time no longer matches is DEAD (pid recycled)', () => {
    // Same pid, but the OS reports a start time hours later: the original host
    // is gone and the pid was reused. This is the PID-reuse guard.
    const d = deps({ alivePids: new Set([7]), startTimes: { 7: 5000 + 3_600_000 } });
    expect(isHostAlive({ pid: 7, startedAt: 5000 }, d)).toBe(false);
  });

  it('a live pid with an unknown start time is treated as alive (unprovable death)', () => {
    const d = deps({ alivePids: new Set([7]) }); // no startTimes
    expect(isHostAlive({ pid: 7, startedAt: 5000 }, d)).toBe(true);
  });

  it('getHostIdentity reports the calling host', () => {
    const d = deps({ alivePids: new Set([42]), startTimes: { 42: 777 }, selfPid: 42 });
    const id: HostId = getHostIdentity(d);
    expect(id.pid).toBe(42);
    expect(id.startedAt).toBe(777);
  });
});
