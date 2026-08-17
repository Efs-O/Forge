# Post-Refactor Audit — 2026-08-17

Branch: `audit/post-refactor-cleanup` (off `fix/thinking-pane-autoscroll`)
Baseline: 721 tests passing. **Now: 745 passing, CI green.**

Scope: audit the codebase after the four-commit file-size refactor, implement
what's worth implementing. Test files over 350 LOC were declared out of scope.

---

## Summary

The refactor landed clean. Everything below is either a latent bug the refactor
made visible, or an invariant the refactor broke on its way past. Nothing here
is a regression introduced by the split itself.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | Capability cache memoized degraded probes for the session | Medium | **Fixed** |
| F2 | `isPathInside` duplicated, canonical copy over-rejects | Medium | **Fixed** |
| F3 | `docs/OWNERS.md` missing 23 modules | Medium | **Fixed** |
| F4 | Debounced `last_used` writes dropped on window close | Low | **Fixed** |
| F5 | Dead `resolveToolPath` re-export | Low | **Fixed** |
| F6 | No bundle-load check in CI | Low | **Fixed** |
| F7 | `SendPipeline` at 0% coverage | Low | **Fixed** |
| F8 | Coverage thresholds configured but never enforced | Medium | **Reported — your call** |
| F9 | Four docs over the 350-LOC rule | Low | **Reported — your call** |

### What came back clean

Worth recording, because it is the larger part of the audit:

- **Error discipline.** 216 `catch` sites, zero empty blocks, zero
  ignore-and-continue bodies. No violations of the "no silent error swallowing"
  rule.
- **Type safety.** 5 `any` uses across `src/` and `webview-ui/src/`.
- **Disposal.** `SidebarProvider.dispose()` *is* correctly registered in
  `context.subscriptions`; the CLI session registry, budget publisher, and
  checkpoint stack all tear down through it. No leaked child processes.
- **Path safety.** `resolveRealWorkspacePath` is symlink-aware — it realpaths
  both sides and walks up to the nearest existing parent for not-yet-created
  files. The traversal handling is correct.
- **No shim debris.** The refactor left no pure re-export barrel files.
- **Commands.** All 42 declared in `package.json` are still registered.

---

## F1 — Capability cache memoized degraded probes *(fixed)*

`AgentLoop.getRuntimeCapabilities` memoized the `/props` probe by model name,
permanently. But `inspectRuntimeModelCapabilities` catches its own failures and
silently degrades to name heuristics:

```ts
try { const props = await fetchProps(baseUrl); ... }
catch { return heuristic; }
```

That is exactly what happens when the first turn of a session races the backend
coming up. The degraded answer — `likelySupportsThinking: null`,
`hasChatTemplate: null` — was then cached for the rest of the session.

Consequences, all silent and all session-long:

- `canUseThinkingKwargs` reads false, so a thinking-capable model runs its
  entire session without thinking kwargs.
- The user gets a spurious *"model does not appear to support thinking template
  toggles"* warning about a model that does.
- No recovery short of a config change (`clearCapabilityCache` is only called
  from `applyForgeConfig`).

This is the "no hidden behavior that masks invalid config" rule inverted: a
transient condition got frozen into a permanent verdict.

**Fix:** extracted to `src/sidebar/CapabilityCache.ts`. Only `runtime`-sourced
answers are retained; a degraded one is evicted so the next turn re-probes and
self-heals. The pending *promise* is still what's cached, so concurrent turns
share one probe rather than stampeding `/props`. The eviction is guarded against
clobbering a newer entry that replaced it mid-flight. 6 tests.

## F2 — `isPathInside` duplicated, canonical copy over-rejects *(fixed)*

Two implementations, different semantics:

| | `util/WorkspacePaths.ts` | `checkpoint/CheckpointFileIO.ts` |
|---|---|---|
| resolves inputs | yes | no |
| prefix test | `relative.startsWith('..')` | `'..'` exact or `..${sep}` |

The canonical copy — the one behind `resolveRealWorkspacePath` and
`WorkerAccessPolicy` — has the weaker test. `startsWith('..')` also matches a
first segment that merely *begins* with two dots:

```
root = C:/ws                     WorkspacePaths   CheckpointFileIO
C:/ws/..config                   false  ← wrong   true
C:/ws/..cache/x                  false  ← wrong   true
C:/ws/../evil                    false             false
```

So a workspace containing `..config` or `..cache` would have tools refuse to
read or write it with "Path is outside the workspace". Both agree on real
traversal, so this is a false-rejection bug, not a hole — but it is the
canonical containment check being wrong while the duplicate is right, which is
the Single Point of Truth rule earning its keep.

**Fix:** one owner, `src/util/pathContainment.ts`, with the correct
segment-aware test and the safer resolve-first behaviour. Deliberately free of
any `vscode` import so the checkpoint layer stays loadable outside the extension
host. `WorkspacePaths` re-exports it for its existing callers. 5 tests.

## F3 — `docs/OWNERS.md` missing 23 modules *(fixed)*

CLAUDE.md mandates a row per module and says to add one when you add a module.
The refactor created 23 files without rows — the whole nine-module checkpoint
split, the four control-server modules, the four CLI-agent modules, and others.

**Fix:** every `src/` module now has an owner row; added a **Checkpoints**
section for the nine-module split. Verified programmatically: zero unlisted
files. Doc is 294 LOC.

## F4 — Debounced `last_used` writes dropped on shutdown *(fixed)*

`usageTracker` debounces writes 2s. Nothing flushed them, so closing the window
within 2s of a turn lost that turn — precisely the "used it last thing before
quitting" case the Model Manager's zoo-hygiene view exists to show.

**Fix:** `flushPendingModelUsage()`, hooked into `deactivate()`. Also replaced
the `key.lastIndexOf('::')` parse-back with the target carried alongside the
timer — model names are user-supplied and may contain the separator.

## F5 — Dead re-export *(fixed)*

`SidebarProvider.ts:344` re-exported `resolveWorkspacePath as resolveToolPath`.
Nothing imported it. Deleted.

## F6 — No bundle-load check in CI *(fixed)*

The refactor session ran an ad-hoc bundle load under a stubbed `vscode` and
called it "the check that catches what a type-check can't". It was right, and it
was thrown away afterwards. Circular-import TDZ errors and module-scope failures
type-check perfectly clean and only appear on evaluation — and module reshuffling
is exactly what creates them.

**Fix:** `scripts/bundle-load-check.js`, wired into `npm run ci` as
`check:bundle`. Two non-obvious details are commented in the file: esbuild's
`__toESM` copies *own keys*, so a bare `get` trap is invisible to it; and the
stub must be a plain object, since a function target has non-configurable
`arguments`/`caller` that an `ownKeys` trap is not permitted to hide.

## F7 — `SendPipeline` at 0% coverage *(fixed)*

`SendPipeline` owns every guard between "user pressed send" and "a turn is
running" — including the overlap refusals whose comment says they exist because
a second turn on a streaming conversation corrupts its transcript. It had no
tests. 13 added, covering both entry points, both streaming refusals, the
cancellation-pending path, model resolution failures, the `finally`-block
refresh surviving a thrown turn, and the F6 rule that a conversation pins the
full `@profile` selection rather than the base name.

---

## F8 — Coverage thresholds are configured but never enforced *(your call)*

`vitest.config.ts` declares thresholds — lines 80, functions 80, branches 75 —
but `npm test` is `vitest run`, not `vitest run --coverage`, so `npm run ci`
never evaluates them. They have presumably never held. Current state:

| Metric | Threshold | Actual |
|---|---|---|
| Lines | 80% | **71.62%** |
| Functions | 80% | **79.66%** |
| Branches | 75% | 75.08% ✅ |

Branches now passes (it did not before F7). Functions is a rounding error away.
Lines is 8 points short.

I did not change this, because both available moves are yours to pick:

1. **Enforce and ratchet** — wire `--coverage` into CI, set thresholds to just
   under current, raise them as tests land. Honest, prevents regression, but
   lowers a declared standard.
2. **Enforce and close the gap** — leave 80/80/75 and write the tests. Largest
   remaining zero-coverage modules: `IndexManager.ts`, `SetupMode.ts`,
   `sidebarWiring.ts`, `configReload.ts`, `editorContext.ts`, `codeActions.ts`,
   `panelHtml.ts`, `SessionLogger.ts`.

Leaving a permanently-failing threshold config is the one option I would argue
against — it reads as a standard the project holds, and it does not.

## F9 — Four docs over the 350-LOC rule *(your call)*

CLAUDE.md applies the limit to `.md` as well. Of the ones actually tracked:

| File | LOC | Tracked |
|---|---|---|
| `CLI_CHECKPOINT_ARCHITECTURE_PLAN.md` | 507 | yes |
| `README.md` | 471 | yes |
| `docs/SAFE_WORKER_TOOL_UPGRADE_PLAN.md` | 426 | yes |
| `COMBINED_UNFINISHED_IMPLEMENTATION_PLAN.md` | 387 | yes |

`README.md` is the one I would actually split — it is the user-facing document
and the only one a stranger reads. The three plan docs are working documents
whose value is being one continuous narrative; splitting them costs more than it
returns. Left alone pending your call.

---

## Validation

Run after every change, not just at the end:

- `npm run ci` — type-check, lint, 745 tests, production build, **and now the
  bundle-load check**. Green.
- Bundle load under stubbed `vscode`: module scope evaluates, `activate` and
  `deactivate` both exported, `deactivate()` runs clean (it now calls
  `flushPendingModelUsage`).
- Command cross-check: 42/42 declared commands still registered in source.
- `docs/OWNERS.md` completeness verified programmatically against `src/`.

Two files crossed 350 LOC while taking the fixes and were split rather than
crammed: `AgentLoop.ts` (364 → 326, via `CapabilityCache.ts`) and
`extension.ts` (353 → 316, via `vscode/sidebarCommands.ts`).

## Commits

- `a3c3603` — fix: stop caching degraded capability probes; unify path containment
- `8cfef13` — test: cover SendPipeline, the send-path guard set
