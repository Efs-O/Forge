# Model Readiness Dot — Implementation Plan

A per-model state indicator in the composer's model picker, answering a question
the UI cannot answer today: **is my next send instant, or does it pay a cold
load?**

---

## Why this is not cosmetic

`switchModel` only *pins* a model to the tab
([SidebarProvider.ts:190](src/sidebar/SidebarProvider.ts#L190)) — it loads
nothing. The llama-server spawn happens on the first send. On a single-slot
16 GB card, picking a non-resident model means the next turn evicts what is
resident and spends tens of seconds reading weights, and nothing in the UI says
so beforehand.

Second, smaller win: during that cold load the transcript says
**"Burning tokens…"** ([App.tsx:369](webview-ui/src/App.tsx#L369)). Nothing is
burning. Same class of dishonesty as the 0.13.5 background-execution reporting
fix. Out of scope here, but the readiness signal is what a later fix would use.

---

## States

| Dot | Meaning | Predicate |
|---|---|---|
| Solid | resident **and** ready — send is instant | `isLoaded && isReady` |
| Hollow, pulsing | resident, still spawning | `isLoaded && !isReady` |
| Dim | cold — first send pays the load | `!isLoaded` |
| **No dot** | residency is meaningless for this model | remote route |

### The "no dot" case is the one that matters

Residency has no meaning for a model Forge does not host. Rendering such a model
as "dim / cold" would imply a load cost that does not exist — the indicator
would be actively lying, which is worse than having none.

`isLocalModel()` is **not** the right test here. Ollama *cloud* models route
through the local daemon at `localhost:11434`, so their endpoint is localhost and
`isLocalModel()` returns true — they would wrongly get a dot.

Use `classifyModelRoute()`
([ModelPickerGroups.ts](src/sidebar/ModelPickerGroups.ts)), which already
separates the cases. Dot only for:

- `local-llama`
- `local-ollama`

No dot for `ollama-cloud`, `direct-cloud`, `cli-agent`.

---

## Freshness — the actual engineering problem

The rendering is ~40 lines. Keeping it *true* is the work.

`postModels()` fires only on config change and conversation switch
([SidebarProvider.ts:237](src/sidebar/SidebarProvider.ts#L237)). Residency
changes on load, unload, release and LRU eviction. A naively wired dot goes
stale immediately.

**Eviction is the dangerous case**: it happens to a model the user never
touched, so a stale dot sits there showing green for something no longer in
VRAM.

### Rejected: emit at each mutation site

Slots mutate in **9 places across 5 files** (`BackendPool.ts`,
`poolAcquisition.ts`, `poolSlots.ts`, `poolStart.ts`). Threading an emit through
all of them is precisely the "miss one call site" shape, and the one most likely
to be missed (`poolSlots.ts:61`, the LRU evict) is the one whose staleness is
invisible.

### Chosen: cheap signature, polled on a slow tick

- `BackendPool.residencySignature(): string` — sorted `name:ready` pairs over
  the three slot maps. Pure reads, no I/O; `isReady()` is a plain flag
  ([DirectBackend.ts:73](src/backend/DirectBackend.ts#L73)).
- `SidebarProvider` compares the signature on a 1500 ms tick and calls
  `postModels()` **only when it changes**.
- Tick runs only while the webview is visible (`view.visible` +
  `onDidChangeVisibility`), and is cleared in `dispose()`.

Trade-off, stated plainly: this is polling, and the dot can lag reality by up to
1.5 s. Accepted because it **cannot rot** — correctness does not depend on any
future contributor remembering to announce a mutation, and a display-only
indicator that self-corrects is worth more than an event graph that is exactly
right until someone adds a tenth mutation site.

---

## Changes

**Host**

1. `poolTypes.ts` — add `isReady(modelName: string): boolean` and
   `residencySignature(): string` to `IBackendPool`.
2. `BackendPool.ts` — implement both. `isReady` mirrors `isLoaded`'s key
   resolution, returning the slot's `backend.isReady()` (Ollama slots: resident
   implies ready, the daemon owns loading).
3. `messageBridge.ts` — `ModelEntry` gains `residency?: 'ready' | 'loading' | 'cold'`.
   Absent means "not applicable" — the no-dot case, so remote models simply omit
   it rather than carrying a fourth enum value.
4. `sidebarPayloads.ts` — `buildModelsMessage(config, pool?)` computes
   `residency` per model, gated on `classifyModelRoute`.
5. `SidebarProvider.ts` — pass the pool; add the visibility-gated tick; clear it
   in `dispose()`.

**Webview**

6. `ModelSelector.tsx` — dot in the trigger and in each panel row.
7. `model-selector.css` — three dot styles + reduced-motion-safe pulse.

**Tests**

8. `sidebarPayloads.test.ts` — ready/loading/cold mapping; **no** `residency`
   for `ollama-cloud` and `direct-cloud`.
9. `BackendPool` — signature changes when readiness flips, stable when nothing
   moved.
10. `ModelSelector.dom.test.ts` — renders the right dot per state; renders none
    when `residency` is absent.

---

## Out of scope

- Fixing "Burning tokens…" during a cold load. Needs its own decision about what
  the transcript should say instead.
- Any change to routing, eviction policy, or when a model actually loads.
