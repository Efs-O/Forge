import { describe, expect, it } from 'vitest';
import {
  createHoldManager,
  shouldSleepIfIdle,
  SLEEP_IF_IDLE_WINDOW_MS,
  WAKE_LEAD_MS,
  type HoldChild,
} from '../../src/system/PowerControl';

interface FakeChild extends HoldChild {
  endCalled: boolean;
}

function makeFakeSpawner() {
  const children: FakeChild[] = [];
  const spawner = (script: string): HoldChild => {
    const child: FakeChild = {
      endCalled: false,
      stdin: {
        end: () => {
          child.endCalled = true;
        },
      },
      kill: () => undefined,
    };
    children.push(child);
    return child;
  };
  return { spawner, children };
}

describe('createHoldManager', () => {
  it('spawns one child for the first hold', () => {
    const { spawner, children } = makeFakeSpawner();
    const manager = createHoldManager(spawner);
    const handle = manager.hold();
    expect(children).toHaveLength(1);
    handle.dispose();
  });

  it('shares one child across two concurrent holds', () => {
    const { spawner, children } = makeFakeSpawner();
    const manager = createHoldManager(spawner);
    const a = manager.hold();
    const b = manager.hold();
    expect(children).toHaveLength(1);
    a.dispose();
    // Still one holder: the child must not have been released.
    expect(children[0]!.endCalled).toBe(false);
    b.dispose();
    // Last holder: the child's stdin is closed so it exits.
    expect(children[0]!.endCalled).toBe(true);
  });

  it('releases the child on the last dispose, and a later hold spawns a new one', () => {
    const { spawner, children } = makeFakeSpawner();
    const manager = createHoldManager(spawner);
    const a = manager.hold();
    a.dispose();
    expect(children).toHaveLength(1);
    expect(children[0]!.endCalled).toBe(true);

    const b = manager.hold();
    expect(children).toHaveLength(2);
    b.dispose();
    expect(children[1]!.endCalled).toBe(true);
  });

  it('ignores a double dispose of the same handle', () => {
    const { spawner, children } = makeFakeSpawner();
    const manager = createHoldManager(spawner);
    const a = manager.hold();
    const b = manager.hold();
    a.dispose();
    a.dispose(); // idempotent: must not drop the shared child
    expect(children[0]!.endCalled).toBe(false);
    b.dispose();
    expect(children[0]!.endCalled).toBe(true);
  });
});

describe('shouldSleepIfIdle', () => {
  const idle = { msSinceResume: 30_000, msSinceInput: 60_000, busy: undefined };

  it('sleeps when idle, no input since resume, within the window', () => {
    expect(shouldSleepIfIdle(idle)).toBe(true);
  });

  it('stays awake when busy', () => {
    expect(shouldSleepIfIdle({ ...idle, busy: 'a turn is still running' })).toBe(false);
  });

  it('stays awake when input occurred since resume', () => {
    // msSinceInput (10s) < msSinceResume (30s): input happened 10s ago, which is after the resume 30s ago.
    expect(shouldSleepIfIdle({ ...idle, msSinceInput: 10_000 })).toBe(false);
  });

  it('stays awake when the resume was outside the window', () => {
    expect(
      shouldSleepIfIdle({ ...idle, msSinceResume: SLEEP_IF_IDLE_WINDOW_MS + 1, msSinceInput: SLEEP_IF_IDLE_WINDOW_MS + 1 }),
    ).toBe(false);
  });

  it('sleeps at exactly the window boundary', () => {
    expect(
      shouldSleepIfIdle({ msSinceResume: SLEEP_IF_IDLE_WINDOW_MS, msSinceInput: SLEEP_IF_IDLE_WINDOW_MS, busy: undefined }),
    ).toBe(true);
  });

  it('WAKE_LEAD_MS is 120 s and the window is lead + 5 min', () => {
    expect(WAKE_LEAD_MS).toBe(120_000);
    expect(SLEEP_IF_IDLE_WINDOW_MS).toBe(120_000 + 300_000);
  });
});
