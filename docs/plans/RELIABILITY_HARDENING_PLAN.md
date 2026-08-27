# Reliability hardening (impl plan)

**Source:** `docs/reviews/forge_reliability_hardening_review.pdf` (baseline
`d199ca8`, v0.12.57), plus a second review pass on this plan (2026-08-22) that
corrected three defects in the proposed *implementation*. Findings verified
against the tree at `f9a2e0c` — line references are confirmed, not quoted.

**Goal:** close the shared-runtime lifecycle bugs. The sixth change in this
cycle — deleting the coordinator/worker role hierarchy rather than patching
HIGH-3 — is a product decision, so it lives in `WORKER_REMOVAL_PLAN.md`.

**Scope here:** HIGH-1, HIGH-2, MED-1, MED-2, MED-3. Not in scope: MED-4 (legacy permissions migration), MED-5
(denylist → structured policy), LOW-2 (doc archive), the Phase D fault suite.

**Kept, untouched:** `ask_local_agent` and all of `src/delegation/` — it
imports nothing from `src/workers/`.

**Scope discipline.** No new abstractions beyond one `detach()` method and one
identity type. Deliberately not doing: the review's fuller `RuntimeHandle`
ownership interface; a per-target worker semaphore for HIGH-3 (the worker
removal deletes that finding); dynamic pool reconfiguration for MED-2.

---

## Phase 1 — HIGH-1: borrowed release must not kill the owner

### The bug

`BackendPool.releaseKey()` (`src/backend/BackendPool.ts:172-177`) handles a
borrowed slot as:

```ts
} else if (this.sharedSlots.has(key)) {
  const shared = this.sharedSlots.get(key)!;
  await shared.backend.stop();   // no .catch, unlike both sibling branches
  this.sharedRegistry.releaseLease(shared.key, shared.leaseId);
  this.sharedSlots.delete(key);
}
```

`stop()` reaches `stopLlamaServer()` (`src/backend/DirectBackend.ts:350-357`),
which throws unconditionally for an adopted server with no owned `proc`, so
`releaseLease` and `sharedSlots.delete` never run. `stop()` is also not
atomic: `DirectBackend.ts:85-92` has already cleared `ready`, aborted
`startAbort` and stopped the adopted monitor before the throw, leaving the
slot half-torn-down but still in `sharedSlots` — so `isLoaded()` keeps
reporting it resident.

### Change — ordering is load-bearing

**The naive refactor introduces a silent VRAM leak.** Defining `stop()` as
`detach()` + `releaseActiveOllamaModel()` + `stopLlamaServer()` breaks the
Ollama release path: `releaseActiveOllamaModel` guards on
`this.activeModel?.provider !== 'ollama'` and returns early
(`DirectBackend.ts:339`), so a `detach()` that already nulled `activeModel`
makes it a silent no-op. `stopLlamaServer` reads `adoptedServer` (`L352`) —
same hazard.

**Invariant:** *do not erase ownership or resource metadata until every path
that needs it has finished releasing the resource.* So state reset is a
private helper, and `stop()` does **not** call `detach()`:

```ts
/** Erase attachment state. Callers must have released resources first. */
private resetAttachmentState(): void {
  this.ready = false;
  this.startAbort?.abort();
  this.startAbort = null;
  this.stopAdoptedMonitor();
  this.adoptedServer = false;
  this.activeModel = null;
  this.currentBaseUrl = `http://${this.host}:${this.port}`;
}

/** Release this client's attachment to a server another window owns. Never
 *  terminates a process. Safe on a server that already vanished. */
async detach(): Promise<void> {
  this.resetAttachmentState();
  log.info('[DirectBackend] detached from adopted server');
}

async stop(): Promise<void> {
  this.ready = false;                     // halt new work first
  this.startAbort?.abort();
  this.startAbort = null;
  this.stopAdoptedMonitor();
  await this.releaseActiveOllamaModel();  // needs activeModel
  await this.stopLlamaServer();           // needs adoptedServer, proc
  this.resetAttachmentState();            // only now
}
```

In `releaseKey`, the shared branch becomes:

```ts
} else if (this.sharedSlots.has(key)) {
  const shared = this.sharedSlots.get(key)!;
  try {
    await shared.backend.detach();
  } finally {
    this.sharedRegistry.releaseLease(shared.key, shared.leaseId);
    this.sharedSlots.delete(key);
  }
}
```

The `finally` is load-bearing: lease and slot-table cleanup must survive any
failure in detach, including a server that vanished mid-release.

### Tests

- Release a borrowed slot ⇒ owner process not killed, lease removed,
  `sharedSlots` entry gone. Same when its endpoint is already dead.
- Detach throws ⇒ lease and slot entry still cleaned up.
- Owned slot release still kills its process (no regression).
- **`stop()` on a resident Ollama model still issues the release call** — the
  regression test for the sequencing bug above.

---

## Phase 2 — HIGH-2: stale lease reclamation

### The bug

`SharedRuntimeRegistry.hasBorrowers()` (`SharedRuntimeRegistry.ts:54-60`) is a
bare directory listing — any `*.json` counts as a live borrower. The PID
written at line 45 is never read back. A borrower that crashes (or hits Phase
1's bug) leaves a lease that blocks the owner's unload at `BackendPool.ts:180`
permanently. Phase 1 is a reliable *generator* of the leases Phase 2 reclaims:
ship them together.

### Change

New `src/util/processLiveness.ts` (~25 LOC), single owner for the check:

```ts
/** kill(pid, 0) throws ESRCH when the process is gone and EPERM when it
 *  exists but is not ours — EPERM is a liveness signal, not an error. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

`hasBorrowers()` becomes a garbage collector, not just a predicate — so it
must be **race-tolerant**. A lease can vanish between `readdir` and
`readFile`, or another window may reclaim it mid-scan. Every step (readdir,
read, parse, liveness, unlink) is individually best-effort; nothing in the
scan may throw. Log each reclamation at debug (`reclaimed stale runtime lease
pid=…`) — six months on, that line is how multi-window behaviour gets
diagnosed. The lease payload gains `createdAt` for diagnostics; `pid` stays
authoritative.

**Testability:** inject the liveness function so tests never depend on real
PIDs — `constructor(root = …, private readonly isAlive = isProcessAlive)`.
Test `isProcessAlive()` separately against `process.pid` and a known-dead PID.

**PID reuse** is the known limit: a recycled PID reads as alive and the lease
survives an extra cycle. Accepted — it fails toward current behaviour, not
toward killing someone's server.

### Tests

- Live PID ⇒ counted, file kept. Dead PID ⇒ not counted, file deleted.
- Malformed JSON ⇒ not counted, deleted, no throw. Absent dir ⇒ false.
- Lease deleted between readdir and read ⇒ no throw.
- Mixed live + dead ⇒ true, only the dead file removed.

---

## Phase 3 — MED-1: readiness semantics

`isAnyReady()` (`BackendPool.ts:238-243`) tests `slots` and `ollamaSlots` but
not `sharedSlots`, while `isLoaded()` and `loadedModelNames()` (`L245-252`) do.
A window whose only backend is borrowed reports `loaded = true, ready = false`.

The one-line fix is the `sharedSlots` clause. The work is the call-site audit:
classify every caller as asking either *is any endpoint healthy*
(`isAnyReady`, now including borrowed) or *is a model resident in a
port-consuming slot* (`isLoaded`). Anything meaning something else gets its own
named method. Record both meanings as doc comments.

---

## Phase 4 — MED-3: canonical runtime identity

`sharedRuntimeKey()` (`SharedRuntimeRegistry.ts:70-77`) hashes
`JSON.stringify(model)`. Two problems: **key-order dependence** (insertion
order changes the hash, so two builds silently stop sharing — fails safe, but
invisibly), and **wrong fields** (sampling/prompt fork identity when they
should not; GPU/tensor-split fields must and are not named).

### Change — derive from argv, do not maintain a parallel list

A hand-written field list will drift from `composeLlamaServerArgs()`. It
already omits `--threads` / `--threads-batch` (`LlamaServerArgs.ts:67-70`).
The invariant instead:

> If a value can alter the llama-server argv or the model artefacts loaded, it
> must alter `RuntimeIdentity` unless explicitly designated runtime-irrelevant.

```ts
export interface RuntimeIdentity {
  ggufPath: string;              // canonical, platform-aware
  mmprojPath?: string;           // same rule
  argv: readonly string[];       // composeLlamaServerArgs minus instance args
}
```

Build `argv` from `composeLlamaServerArgs()` itself, stripping only the
instance-identifying pairs (`--host`, `--port`) — everything else is
server-affecting by construction. Future flags (`--split-mode`,
`--tensor-split`) become share-visible automatically.

**Preserve argv order — never sort.** Order is semantically significant:
`--foo 1 --bar 2` sorted as strings is structurally meaningless, and llama.cpp
honours later-option precedence, so duplicate `--ctx-size` values are not
order-independent. `extra_llama_server_args` is spread verbatim
(`LlamaServerArgs.ts:77-79`) and must stay verbatim. Fixed field order in the
hash already solves the property-order problem; the array needs no reordering.

**Path canonicalization must be platform-aware.** Lowercasing is correct on
Windows and *wrong* on Linux, where `/models/Qwen.gguf` and
`/models/qwen.gguf` are different files that would collide into one identity:

```ts
function canonicalRuntimePath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
```

Prefer `realpathSync` when the file exists, so `C:\models\..\models\x.gguf`
and `C:\models\x.gguf` share an identity; fall back to the above when it does
not. Apply the identical rule to `mmprojPath`.

**Compat:** the key changes shape, so owner records and lease dirs already on
disk stop matching. Correct and self-healing — a stale record fails `find()`
and the window starts its own server. No migration; note in `CHANGES.md`.

### Tests

- Identical key for: property-order permutations; differing sampling / system
  prompt; `..` segments and separator differences on the same GGUF.
- Different key for: differing `--n-gpu-layers`, `--ctx-size`,
  `--cache-type-k`, `--threads`, or any `extra_llama_server_args`.
- **Reordered `extra_llama_server_args` ⇒ different key** (order is meaning).
- **On non-Windows, case-differing GGUF paths ⇒ different keys.**
- Differing `--port` / `--host` only ⇒ identical key.

---

## Phase 5 — MED-2: structural config cannot diverge from runtime

`freePorts` is built once in the constructor (`BackendPool.ts:67`) from
`max_simultaneous_models` + `llama_server.port`. `applyForgeConfig()`
(`L221-224`) swaps `this.config` without rebuilding port inventory.

**A warning alone does not fix this.** If `applyForgeConfig` still does
`this.config = next`, then `freePorts` reflects the old value while
`DelegationGate.maxSlots()` reads the new one — the divergence survives, now
with a warning attached to it.

**Invariant:** *effective structural config equals physical runtime state, at
all times.* So the structural values are **pinned**, not merely warned about:

```ts
this.config = {
  ...next,
  max_simultaneous_models: this.structural.maxSimultaneousModels,
  llama_server: { ...next.llama_server, port: this.structural.port },
  shared_runtime: { ...next.shared_runtime, enabled: this.structural.shared },
};
```

Every runtime reader keeps seeing the currently active value. Surface a VS
Code warning naming the setting and stating the change applies after Reload
Window — per the no-silent-fallback rule this must reach the user, not the log
only. Store `structural` explicitly at construction rather than re-deriving:
the whole bug is derived state drifting.

### Second category: spawn-affecting settings

`num_ctx`, `n_parallel`, `n_batch`, cache types, `flash_attn`,
`n_gpu_layers`, `threads`, `threads_batch`, `extra_llama_server_args`,
`mmproj` do not change an already-running llama-server, yet other code reads
the new values immediately (`parallelCapacity()` computing from a config the
resident server does not implement).

Not solving hot-restart here. Adding the explicit rule instead:

> Spawn-affecting changes apply on next model load, never retroactively to a
> resident runtime.

Surface that distinction to the user when such a key changes while a runtime
is resident.

### Tests

- Non-structural hot reload ⇒ no warning, config applied.
- `max_simultaneous_models` or `llama_server.port` change ⇒ warning raised,
  `freePorts` unchanged, **and `this.config` still reports the old value**.
- Spawn-affecting change with a resident runtime ⇒ notice raised; the resident
  backend's effective args unchanged.

---

## Ordering

1. **Phase 1 + Phase 2** in one PR — they compound; either alone leaves the
   other's failure mode reachable.
2. **Phase 3** — small, easier to audit before the removal churns call sites.
3. **Worker removal** (`WORKER_REMOVAL_PLAN.md`) — one commit, so a revert
   stays clean if the decision is reversed.
4. **Phase 4**, then **Phase 5**.
5. Full multi-window acceptance pass (below).
6. **Only then** consider splitting `BackendPool.ts`.

On that last point: the file is 386 LOC, over the 350 limit, and Phases 1, 3
and 5 all add to it while the worker removal takes little out of it. It still must be split — but
**not inside this cycle's commits**. Ownership, ports, leases, release,
delegation pins, identity and config reload are exactly the logic where a
structural refactor mixed into behavioural fixes turns a reviewable diff into
an unreviewable one. Split last, as a separate no-behaviour-change commit with
the characterization tests from Phases 1-5 already green.

## Acceptance

- `npm run ci` and `npm run package` green.
- Two windows: A owns, B borrows, B releases ⇒ A alive, lease gone, A can
  unload. Then B crashes ⇒ A unloads, stale lease reclaimed.
- **Owner dies while borrower is live** ⇒ borrower's adopted monitor
  transitions to dead cleanly; no zombie `ready` state.
- **Borrower releases after the owner already died** ⇒ release succeeds,
  lease removed, nothing attempts termination.
- **Two borrowers, one dies** ⇒ owner stays protected by the surviving lease;
  only the dead lease is reclaimed.
- **Structural config reload while a runtime is resident** ⇒ warning shown,
  effective pool state and `this.config` identical until reload.
- Existing `config.yaml` with `cloud_workers: true` boots, logs once.
