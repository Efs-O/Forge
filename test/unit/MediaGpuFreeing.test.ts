/**
 * Phase 3 acceptance: "unload only overlapping entries through `unloadModel`,
 * idle-first" (docs/plans/MEDIA_SHIPPED_PLAN.md, Acceptance criteria).
 *
 * Nothing here spawns a process or touches a port: the loaded entries, the busy
 * answer and the unload are the injected lifecycle seam, and the wait is an
 * injected timer. What the tests pin is the ORDERING the plan is about — a
 * busy model is waited out BEFORE it is unloaded, a non-overlapping model is
 * never unloaded, and an entry that never named its cards is unloaded
 * conservatively with the reason logged.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  freeGpusForEngine,
  type MediaLoadedModel,
  type MediaModelLifecycle,
} from '../../src/tools/media/mediaGpuFreeing';

interface LifecycleCall {
  kind: 'busy' | 'unload';
  model: string;
}

function lifecycle(
  models: readonly MediaLoadedModel[],
  busyFor: (model: string, call: number) => boolean,
  calls: LifecycleCall[],
  unloadError?: (model: string) => string | undefined,
): MediaModelLifecycle {
  let busyCalls = 0;
  return {
    loadedModels: () => models,
    isBusy: (model) => {
      busyCalls += 1;
      calls.push({ kind: 'busy', model });
      return busyFor(model, busyCalls);
    },
    unloadModel: async (model) => {
      calls.push({ kind: 'unload', model });
      const error = unloadError?.(model);
      return error ? { unloaded: false, error } : { unloaded: true };
    },
  };
}

const neverWaits = async (): Promise<void> => undefined;

describe('freeGpusForEngine: overlap selection', () => {
  it('unloads only the entries whose GPUs overlap the engine, and says why not for the rest', async () => {
    const calls: LifecycleCall[] = [];
    const result = await freeGpusForEngine(
      [2],
      {
        lifecycle: lifecycle(
          [
            { name: 'strata', gpus: [0, 1] },
            { name: 'coder', gpus: [2] },
          ],
          () => false,
          calls,
        ),
        wait: neverWaits,
        log: () => {},
      },
    );
    expect(result.unloaded).toEqual(['coder']);
    expect(result.untouched).toEqual([
      { name: 'strata', reason: 'its GPUs do not overlap this engine' },
    ]);
    expect(calls.filter((call) => call.kind === 'unload')).toEqual([
      { kind: 'unload', model: 'coder' },
    ]);
  });

  it('treats an entry that names no GPUs as wanting every card, and logs that reason', async () => {
    const logs: string[] = [];
    const result = await freeGpusForEngine(
      [2],
      {
        lifecycle: lifecycle([{ name: 'primary' }], () => false, []),
        wait: neverWaits,
        log: (line) => logs.push(line),
      },
    );
    expect(result.unloaded).toEqual(['primary']);
    expect(logs.join(' ')).toContain('names no gpus');
  });

  it('waits out a busy model before unloading it, then unloads it', async () => {
    const calls: LifecycleCall[] = [];
    const waits: number[] = [];
    const result = await freeGpusForEngine(
      [2],
      {
        lifecycle: lifecycle(
          [{ name: 'worker', gpus: [2] }],
          // Busy for the first two polls, idle on the third.
          (model, call) => call < 3,
          calls,
        ),
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        idlePollMs: 250,
        log: () => {},
      },
    );
    expect(waits.length).toBeGreaterThanOrEqual(2);
    const firstUnload = calls.findIndex((call) => call.kind === 'unload');
    expect(firstUnload).toBeGreaterThan(0);
    expect(calls.slice(0, firstUnload).every((call) => call.kind === 'busy')).toBe(true);
    expect(result.unloaded).toEqual(['worker']);
  });

  it('refuses the render when a model is still busy after the wait, naming the models already unloaded', async () => {
    const calls: LifecycleCall[] = [];
    await expect(
      freeGpusForEngine(
        [2],
        {
          lifecycle: lifecycle(
            [
              { name: 'idle-one', gpus: [2] },
              { name: 'busy-one', gpus: [2] },
            ],
            // idle-one is free; busy-one never clears.
            (model) => model === 'busy-one',
            calls,
          ),
          wait: async () => undefined,
          idleWaitMs: 50,
          idlePollMs: 10,
          log: () => {},
        },
      ),
    ).rejects.toThrow(/"busy-one" is still generating after .*Already unloaded: idle-one/);
  });

  it('aborts the render when the unload itself fails, and never unloads a non-overlapping entry', async () => {
    const calls: LifecycleCall[] = [];
    await expect(
      freeGpusForEngine(
        [2],
        {
          lifecycle: lifecycle(
            [
              { name: 'strata', gpus: [0, 1] },
              { name: 'coder', gpus: [2] },
            ],
            () => false,
            calls,
            (model) => (model === 'coder' ? 'has active holds - POST /release them first' : undefined),
          ),
          wait: neverWaits,
          log: () => {},
        },
      ),
    ).rejects.toThrow(/Could not unload "coder".*No model was unloaded/);
    expect(calls.filter((call) => call.kind === 'unload')).toEqual([
      { kind: 'unload', model: 'coder' },
    ]);
  });

  it('does not wait on the calling conversation\u2019s own model, and still unloads it', async () => {
    const calls: LifecycleCall[] = [];
    const result = await freeGpusForEngine(
      [0],
      {
        lifecycle: lifecycle([{ name: 'chat-model', gpus: [0] }], () => true, calls),
        ownModelName: 'chat-model',
        wait: () => {
          throw new Error('the calling turn must not be waited out');
        },
        log: () => {},
      },
    );
    expect(result.unloaded).toEqual(['chat-model']);
  });

  it('stops waiting when the turn is aborted and reports an abort rather than a timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      freeGpusForEngine(
        [2],
        {
          lifecycle: lifecycle([{ name: 'worker', gpus: [2] }], () => true, []),
          wait: (ms, signal) => {
            if (signal?.aborted) throw new Error('aborted');
            void ms;
            return Promise.resolve();
          },
          log: () => {},
        },
        controller.signal,
      ),
    ).rejects.toThrow(/media GPU free aborted/);
  });
});
