/**
 * BackendPool's VRAM-release paths: freeing one model's backend, freeing every
 * local model, and the request path that makes room for a managed external
 * server (Strata).
 *
 * Split out of `BackendPool`, which keeps slot allocation, acquisition, pin
 * bookkeeping and residency reporting. Nothing here consumes or competes for a
 * port: `prepareExternalForRequest` stops everything else that wants the same
 * GPUs so the managed server can have them to itself, `stopOwnedSlots` is that
 * "everything else", and `releaseModelBackend` is the single-model teardown both
 * the sidebar and the control server reach. They share one context because they
 * read the same maps — and because a release must see the same `isBusy` answer
 * that `freeVramForExternal` does, or the two would disagree about what is free.
 */

import type { DirectBackend } from './DirectBackend';
import type { ExternalModelServers } from './ExternalModelServers';
import {
  externalHoldConflict,
  type ExternalTurnHold,
  type SharedRuntimeRegistry,
} from './SharedRuntimeRegistry';
import {
  freeVramForExternal,
  gpusOverlap,
  stopAllSlots,
  type SharedSlotRecord,
} from './poolAcquisition';
import type { PoolSlot } from './poolSlots';
import { notifyModelServerReady } from './modelServerReady';
import { getLogger } from '../util/logger';

const log = getLogger();

/** What BackendPool hands these operations: its maps, and the decisions only
 *  BackendPool can make. Rebuilt per call, because `config` — and therefore
 *  `shared_runtime.enabled` — is replaced wholesale by a hot reload. Every
 *  `key` is already a pool key: these functions never re-resolve a name. */
export interface ExternalCoordinationContext {
  /** Managed externals (Strata); absent when the config names no `unload_path`. */
  external: ExternalModelServers | undefined;
  slots: Map<string, PoolSlot>;
  ollamaSlots: Map<string, DirectBackend>;
  sharedSlots: Map<string, SharedSlotRecord>;
  registry: SharedRuntimeRegistry;
  sharedRuntimeEnabled: boolean;
  runtimeKey(modelName: string): string | undefined;
  /** Drops the slot AND returns its port to the free list — see `stopAllSlots`. */
  freeSlot(modelName: string, slot: PoolSlot): void;
  /** A sidebar turn, a delegation hold or a remote lease is using this model. */
  isBusy(modelName: string): boolean;
  /** A delegation hold pins this key: releasing it would stop work in flight. */
  isDelegationPinned(modelKey: string): boolean;
  /** Group-resolved: this model is served by the Ollama daemon, not a slot. */
  isOllamaModel(modelKey: string): boolean;
}

/** Whether another managed server wants one of `key`'s cards (an engine with no
 *  `gpus` shares every card). The one overlap rule for loads and turn holds. */
export function sharesGpusWith(
  external: ExternalModelServers,
  key: string,
): (other: string) => boolean {
  return (other) => gpusOverlap(external.gpusOf(key), external.gpusOf(other));
}

/**
 * Before a request to a managed external server: free every local model and
 * every other managed server WHOSE GPUs overlap this one (two Strata entries share
 * GPUs; an engine that names no `gpus` overlaps everything, which is today's
 * behaviour for every config that has not added the field), never under a
 * running turn or a live remote lease. Then start the server if it is down and
 * mark it in use, so this window's residency view matches what just happened.
 */
export async function prepareExternalForRequest(
  key: string,
  ctx: ExternalCoordinationContext,
): Promise<void> {
  const external = ctx.external;
  if (!external?.isManaged(key)) return;
  // A turn in ANOTHER window blocks this load only when the two servers want the
  // same card: a production turn on GPU 0/1 must not refuse a coder load on GPU 2,
  // which is the same thrash one layer up from unloading every server. `gpusOf`
  // answers from the engine; an engine that names no GPUs blocks everything, as it
  // did before the field existed.
  const shares = sharesGpusWith(external, key);
  // The residency re-read goes BEFORE the machine-wide lock. It is a network wait —
  // `probeExternalResidencyEndpoints` runs a 2 s read of `/v1/models` per endpoint and
  // a second 2 s read of `/v1/status` when the list comes back empty, so up to ~4 s —
  // and this lock is the only thing another window's first managed turn waits on, with
  // a 5 s deadline: 4 s spent inside it left that waiter one second and made it fail
  // outright (BL-032, the same reason the START runs outside). What the lock still owns
  // is the cross-window hold check, every free and the claim, so a server that appeared
  // while this probe was in flight is still caught — by the check BL-020 moved in for a load
  // that has not published its residency yet, and by the token below for one that finished and
  // released its hold while we were looking.
  const freeNames = external.managedNames().filter((name) => name !== key && shares(name));
  // The token is read BEFORE the probe and compared INSIDE the lock, after the holder scan.
  // Every window that loads a managed server, unloads one, or releases a turn hold publishes a
  // new token, and a publisher that cannot write removes the file so readers see `''` — unknown.
  // The comparison below is therefore this window's only proof about its own map, and `''` is
  // never proof: a fresh board, or a failed publication, takes the conservative path.
  const generation = ctx.registry.externalResidencyGeneration();
  await external.reconcileForFree(freeNames);
  const claim = await ctx.registry.withExternalTurnHoldLock(async () => {
    const crossWindowHold = ctx.registry
      .externalTurnHolders()
      .find((hold) => hold.model !== key && shares(hold.model));
    if (crossWindowHold) throw externalHoldConflict(crossWindowHold, key);
    // Read AFTER the holder scan, so a turn that ended during the scan is caught by the scan
    // (its hold was live when the scan ran) and one that ended before the scan is caught here
    // (its release published a newer token). When the map cannot be proved current, the frees
    // do not trust it: every OVERLAPPING managed server is offered, not only the ones the map
    // believes are loaded. Over-unloading a server that holds nothing costs one fast POST;
    // missing one costs the cards this load is about to take.
    const mapIsCurrent =
      external.residencyPublicationTrusted() &&
      generation !== '' &&
      ctx.registry.externalResidencyGeneration() === generation;
    await freeVramForExternal(key, {
      local: [...ctx.slots.keys(), ...ctx.sharedSlots.keys(), ...ctx.ollamaSlots.keys()],
      // Only the OVERLAPPING servers are offered to the free path: unloading a
      // server on other cards would cut off another window's work for no VRAM
      // gain. `gpusOf` is reached only for a name that is not this one, so a
      // window with a single managed server loaded never asks about GPUs at all.
      otherExternal: mapIsCurrent
        ? external.loadedNames().filter((name) => name !== key && shares(name))
        : freeNames,
      busy: (model) => ctx.isBusy(model),
      stopLocal: () => stopOwnedSlots(ctx),
      unloadExternal: (name) => external.unload(name),
    });
    // The claim is taken inside the same critical section as the GPU frees, so
    // no other window can slip between them, and the START that follows runs
    // with the lock free: it can run for `START_TIMEOUT_MS` — two minutes of
    // polling — and this lock is the only thing another window's first managed
    // turn waits on, so held across the start it made that turn fail after its
    // 5 s wait with a message naming nothing (BL-020).
    return ctx.registry.claimExternalTurnHold(key, 'model-load', 'a model load in another window');
  });
  try {
    await external.ensureStarted(key);
    external.markInUse(key);
    notifyModelServerReady(key);
  } finally {
    claim.release();
  }
}

/**
 * Any live turn hold. Every record in the holds folder belongs to a managed
 * external — `BackendPool.acquireExternalTurnHold` hands a key-based cloud
 * turn a no-op lease, so there is no other kind of holder to filter out — and
 * a local model load frees EVERY managed server, so one holder is enough to
 * stop it. This also covers the claim `prepareExternalForRequest` writes while
 * its server is still coming up, whose model is not in `loadedNames()` yet.
 */
function anyTurnHold(registry: SharedRuntimeRegistry): ExternalTurnHold | undefined {
  return registry.externalTurnHolders()[0];
}

/**
 * Free every managed external before a local model takes the GPUs, and refuse
 * while any chat in any window holds one of them for a turn. `acquireByKey`
 * used to POST these unloads with no reference to the holds, so loading a GGUF
 * model in one window cut off another window's turn on Strata between requests
 * — the failure `ProviderTurn` names as "another window loading a different
 * model". Same-window holds count here too: a chat streaming on Strata holds no
 * pool turn pin (the cloud path never pins), so this is the only check that can
 * see it.
 */
export async function unloadManagedForLocalLoad(
  localKey: string,
  ctx: ExternalCoordinationContext,
): Promise<void> {
  const external = ctx.external;
  if (!external) return;
  // The check happens inside the lock, never before it (BL-020, Codex's second
  // reject): a window that is holding the lock while it frees GPUs has not
  // published its claim yet, so an unlocked "nothing is loaded and nobody is
  // holding one" test would let this load walk over that server and start a
  // local model beside it. Residency is not the gate either — a claim for a
  // model still starting is not in `loadedNames()` yet.
  // BL-032: the residency re-read is a network wait (up to ~4 s of two 2 s reads per
  // endpoint), and the lock below is the one another window's first managed turn waits
  // 5 s on — so it runs before the lock, and only the check stays inside it. The token
  // makes that safe the same way `prepareExternalForRequest` does, including the case
  // Codex named: another window that loads a server, finishes its turn and releases its
  // hold while this probe is in flight leaves no hold to find, so an unprovable map means
  // every managed server is freed rather than the map's subset.
  const reconcileNames = external.managedNames();
  const generation = ctx.registry.externalResidencyGeneration();
  await external.reconcileForFree(reconcileNames);
  await ctx.registry.withExternalTurnHoldLock(async () => {
    const blocker = anyTurnHold(ctx.registry);
    if (blocker) throw externalHoldConflict(blocker, localKey, 'local-load');
    // Read after the scan, for the reason given at the other site: a release either
    // landed before the scan (then its token is newer here) or after it (then the hold
    // was live and the scan refused). `loadedNames()` is only trusted when it can be.
    const mapIsCurrent =
      external.residencyPublicationTrusted() &&
      generation !== '' &&
      ctx.registry.externalResidencyGeneration() === generation;
    if (mapIsCurrent && !external.loadedNames().length) return;
    // `unloadAll` frees the names it is given, so an unprovable map has to be
    // replaced by the list itself: asking it to free "everything loaded" with a map
    // that says nothing is loaded would free nothing at all.
    await external.unloadAll(true, mapIsCurrent ? external.loadedNames() : reconcileNames);
  });
}

/**
 * Refuse to free a managed model ANOTHER window's chat is holding for a turn.
 * Only another process blocks here: this window's own release is its owner's
 * call, and a tab close or model switch already ends that chat's turn — and so
 * releases its hold — before it asks for the release.
 */
export function refuseCrossWindowManagedRelease(
  ctx: ExternalCoordinationContext,
  key: string,
): void {
  const blocker = ctx.registry
    .externalTurnHolders()
    // Only another PROCESS blocks here: `TabModelRelease.streamingHolder` and
    // `unloadCandidate` already refuse a same-window release while a chat is
    // streaming on the model or another tab still has it selected, so a hold
    // still present at this point belongs to the chat doing the releasing.
    // Do not "fix" this by dropping the pid check — that would make a chat
    // refuse its own release.
    .find((hold) => hold.model === key && hold.pid !== process.pid);
  if (blocker) throw externalHoldConflict(blocker, key, 'release');
}

/**
 * The owner's explicit unload — window exit, `/unloadAll`, a job's pre-run —
 * may still cut a held managed model off, because refusing would leave it
 * loaded with no window left that could ever free it. It must not do so
 * silently, so the chat it is cutting off is named here (BL-023).
 */
export function noteExternalsHeldElsewhere(ctx: ExternalCoordinationContext): void {
  const models = ctx.external?.loadedNames() ?? [];
  if (!models.length) return;
  for (const hold of ctx.registry.externalTurnHolders()) {
    if (!models.includes(hold.model)) continue;
    log.warn(
      `[BackendPool] unloading "${hold.model}" while chat '${hold.title}' is holding it for a turn`,
    );
  }
}

/**
 * Stop every llama-server this window owns, plus its Ollama clients. */
export async function stopOwnedSlots(ctx: ExternalCoordinationContext): Promise<void> {
  await stopAllSlots({
    slots: ctx.slots,
    ollamaSlots: ctx.ollamaSlots,
    sharedSlots: ctx.sharedSlots,
    registry: ctx.registry,
    sharedRuntimeEnabled: ctx.sharedRuntimeEnabled,
    runtimeKey: (model) => ctx.runtimeKey(model),
    freeSlot: (model, slot) => ctx.freeSlot(model, slot),
  });
}

/**
 * Free one model's backend, whichever kind it is: a managed external is
 * unloaded (`stopExternal` also runs its stop_command), an Ollama client is
 * dropped, a runtime borrowed from another window is detached — never
 * stopped, since the process is not ours — and an owned slot is stopped and
 * its port returned. `stopExternal` is the explicit `/unloadModel` path: it
 * stops the server as well as freeing the model.
 */
export async function releaseModelBackend(
  key: string,
  ctx: ExternalCoordinationContext,
  stopExternal = false,
): Promise<void> {
  if (ctx.isDelegationPinned(key)) {
    throw new Error(`Cannot release "${key}": an active delegation hold is using it.`);
  }
  const external = ctx.external;
  if (external?.isManaged(key)) {
    refuseCrossWindowManagedRelease(ctx, key);
    return stopExternal ? external.unloadAndStop(key) : external.unload(key);
  }
  if (ctx.isOllamaModel(key)) {
    const backend = ctx.ollamaSlots.get(key);
    if (backend) {
      await backend.stop();
      ctx.ollamaSlots.delete(key);
    }
  } else if (ctx.sharedSlots.has(key)) {
    const shared = ctx.sharedSlots.get(key)!;
    // Borrowed: detach this client only — the process belongs to another
    // window. The finally is load-bearing: the lease and the slot entry must
    // be cleaned up even if detach fails, or the owner can never unload.
    try {
      await shared.backend.detach();
    } finally {
      ctx.registry.releaseLease(shared.key, shared.leaseId);
      ctx.sharedSlots.delete(key);
    }
  } else {
    const slot = ctx.slots.get(key);
    if (slot) {
      const runtimeKey = ctx.runtimeKey(key);
      // A model whose server is not a llama-server has no shared runtime to drain,
      // count borrowers for, or unown (see BackendPool.runtimeKey).
      const shared = ctx.sharedRuntimeEnabled && runtimeKey !== undefined;
      const draining = shared && runtimeKey ? ctx.registry.beginDraining(runtimeKey) : false;
      if (shared && runtimeKey && ctx.registry.hasBorrowers(runtimeKey)) {
        if (draining && runtimeKey) ctx.registry.resumeBorrowing(runtimeKey);
        throw new Error(
          `Cannot unload "${key}": another Forge workspace is using this shared runtime.`,
        );
      }
      try {
        if (slot.starting) await slot.starting.catch(() => {});
        await slot.backend.stop();
        ctx.freeSlot(key, slot);
        if (shared && runtimeKey) ctx.registry.removeOwner(runtimeKey);
      } catch (error) {
        if (draining && runtimeKey) ctx.registry.resumeBorrowing(runtimeKey);
        throw error;
      }
    }
  }
  log.info(`[BackendPool] released: ${key}`);
}
