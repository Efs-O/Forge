/**
 * The lifecycle seam the media tools drive (BL-031).
 *
 * A render frees the cards it asked for by walking `loadedModels()` and asking
 * `isBusy` before it unloads anything, so these two answers decide whether a
 * managed external server (Strata) on those cards is unloaded or invisible. The
 * pool's slot list never names one, so without the managed externals beside it a
 * render refuses on the VRAM gate and names an alternative the owner cannot use.
 *
 * A turn hold is read here as well as a residency answer, and it is read BY
 * CARD: a server another window is streaming on may be one this window believes
 * is unloaded, and a second entry on the same cards is still on those cards.
 * That is the same rule `SharedRuntimeRegistry` uses when it refuses a hold.
 */
import { describe, expect, it } from 'vitest';
import { mediaLifecycleFor, type MediaExternals } from '../../src/vscode/mediaLifecycle';
import type { ExternalModelServers } from '../../src/backend/ExternalModelServers';
import type { IBackendPool } from '../../src/backend/poolTypes';
import type { ExternalTurnHold } from '../../src/backend/SharedRuntimeRegistry';
import type { ForgeConfig } from '../../src/config/types';

const config = {
  models: [
    { name: 'worker', gpus: [1] },
    { name: 'strata', gpus: [0] },
  ],
} as unknown as ForgeConfig;

function hold(
  model: string,
  over: Partial<Pick<ExternalTurnHold, 'pid' | 'conversationId'>> = {},
): ExternalTurnHold {
  return {
    id: 'hold-1',
    model,
    pid: 4242,
    conversationId: 'chat-7',
    title: 'a chat',
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...over,
  };
}

function lifecycle(options: {
  loaded?: readonly string[];
  busy?: readonly string[];
  externals?: MediaExternals;
}) {
  const pool = {
    loadedModelNames: () => [...(options.loaded ?? [])],
    isBusy: (name: string) => (options.busy ?? []).includes(name),
  } as unknown as IBackendPool;
  const externals = options.externals;
  return mediaLifecycleFor(
    pool,
    () => undefined,
    () => config,
    externals ? () => externals : undefined,
  );
}

function servers(
  loaded: readonly string[],
  gpus: Readonly<Record<string, readonly number[] | undefined>>,
) {
  return {
    loadedNames: () => [...loaded],
    gpusOf: (name: string) => gpus[name],
  } as unknown as ExternalModelServers;
}

describe('mediaLifecycleFor: what a media render may free', () => {
  it('lists a loaded managed external beside the slots, with the cards its entry named (BL-031)', () => {
    const models = lifecycle({
      loaded: ['worker'],
      externals: { servers: servers(['strata'], { strata: [0] }), holds: [] },
    }).loadedModels();
    expect(models).toEqual([
      { name: 'worker', gpus: [1] },
      { name: 'strata', gpus: [0] },
    ]);
  });

  it('lists a managed external that named no cards with no gpus, so it is treated as wanting all of them', () => {
    const models = lifecycle({
      loaded: ['worker'],
      externals: { servers: servers(['strata'], { strata: undefined }), holds: [] },
    }).loadedModels();
    expect(models[1]).toEqual({ name: 'strata' });
  });

  it('lists a model another window is holding even when this window saw it unloaded', () => {
    const models = lifecycle({
      loaded: [],
      externals: {
        servers: servers([], { 'strata-x': [0, 1] }),
        holds: [hold('strata-x')],
      },
    }).loadedModels();
    expect(models).toEqual([{ name: 'strata-x', gpus: [0, 1] }]);
  });

  it('never lists the same entry twice', () => {
    const models = lifecycle({
      loaded: ['strata'],
      externals: { servers: servers(['strata'], { strata: [0] }), holds: [hold('strata')] },
    }).loadedModels();
    expect(models.map((model) => model.name)).toEqual(['strata']);
  });

  it('stays the slot list when the window configured no managed externals', () => {
    expect(lifecycle({ loaded: ['worker'] }).loadedModels()).toEqual([
      { name: 'worker', gpus: [1] },
    ]);
    const absent = lifecycle({
      loaded: ['worker'],
      externals: { servers: undefined, holds: [] },
    }).loadedModels();
    expect(absent).toEqual([{ name: 'worker', gpus: [1] }]);
  });

  it('reads a hold on the same model as busy, and an alias of the held base too', () => {
    const busy = lifecycle({
      externals: { servers: servers(['strata'], { strata: [0] }), holds: [hold('strata')] },
    });
    expect(busy.isBusy('strata')).toBe(true);
    expect(busy.isBusy('strata@fast')).toBe(true);
    expect(busy.isBusy('worker')).toBe(false);
  });

  it('reads a hold on ANOTHER server as busy when the two share a card', () => {
    // This window last saw `strata-x` unloaded, so only `strata-y` is listed;
    // unloading it would still land on the card `strata-x` is streaming on.
    const busy = lifecycle({
      loaded: [],
      externals: {
        servers: servers(['strata-y'], { 'strata-y': [0, 1], 'strata-x': [0, 1] }),
        holds: [hold('strata-x')],
      },
    });
    expect(busy.isBusy('strata-y')).toBe(true);
    expect(busy.loadedModels().map((model) => model.name)).toContain('strata-x');
  });

  it('treats a held server that named no cards as overlapping every card', () => {
    const busy = lifecycle({
      externals: {
        servers: servers(['strata-y'], { 'strata-y': [2], 'strata-x': undefined }),
        holds: [hold('strata-x')],
      },
    });
    expect(busy.isBusy('strata-y')).toBe(true);
  });

  it('does not read a hold on a server on other cards as busy', () => {
    const idle = lifecycle({
      externals: {
        servers: servers(['strata-y'], { 'strata-y': [0, 1], coder: [2] }),
        holds: [hold('coder')],
      },
    });
    expect(idle.isBusy('strata-y')).toBe(false);
    expect(idle.isBusy('coder')).toBe(true);
  });

  it('is not busy for a managed external no window is holding', () => {
    const idle = lifecycle({ externals: { servers: servers(['strata'], { strata: [0] }), holds: [] } });
    expect(idle.isBusy('strata')).toBe(false);
  });

  it('does not read the calling chat’s own turn hold as somebody else being busy', () => {
    // A chat on `strata-x` holds that server for its whole turn and then asks
    // for a render on the same cards. Counting its own hold would wait out the
    // idle budget and refuse the render it was asked for.
    const cards = { 'strata-y': [0, 1], 'strata-x': [0, 1] };
    const own = hold('strata-x', { pid: process.pid, conversationId: 'chat-me' });
    const busy = lifecycle({
      externals: { servers: servers(['strata-y'], cards), holds: [own] },
    });
    expect(busy.isBusy('strata-y', 'chat-me')).toBe(false);
    expect(busy.isBusy('strata-y', 'chat-other')).toBe(true);
    expect(busy.isBusy('strata-y')).toBe(true);
    const elsewhere = lifecycle({
      externals: {
        servers: servers(['strata-y'], cards),
        holds: [hold('strata-x', { pid: 9999, conversationId: 'chat-me' })],
      },
    });
    expect(elsewhere.isBusy('strata-y', 'chat-me')).toBe(true);
  });

  it('keeps answering from the pool pins first', () => {
    const pinned = lifecycle({ loaded: ['worker'], busy: ['worker'] });
    expect(pinned.isBusy('worker')).toBe(true);
    expect(pinned.isBusy('strata')).toBe(false);
  });
});
