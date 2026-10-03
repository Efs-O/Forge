# Strata lifecycle: stop on VS Code exit, and unload that actually reaches it

Status: implemented 2026-10-02; live close/reload acceptance remains for review.
Follows `EXTERNAL_SERVER_UNLOAD_PLAN.md` (0.16.72).

## Problem

1. **Closing VS Code leaves Strata running.** The server process
   (`strata.exe` + the `serve` Python wrapper, started hidden by
   `N:\Strata\start-strata-hidden.vbs`) keeps its ~1 GB of pinned RAM, and, if it
   was not unloaded, ~30 GB of VRAM across both 5060 Tis plus the vision encoder
   on the 3060. The user wants it gone when the last VS Code window closes.
   `EXTERNAL_SERVER_UNLOAD_PLAN.md` deliberately said "Forge never starts, stops
   or kills the Strata process"; this plan reverses that for one opt-in case:
   **stop on exit, with a command the user configures.**
2. **`/unloadModel` and `/unloadAll` appear not to reach Strata.** The user
   reports it, and the evidence agrees: across a full day of use the extension
   host logs show exactly **one** `[ExternalModelServers] unloaded
"strata-flashnext-iq3s"` line (2026-10-02T10:30:51Z). Both installed builds
   (0.16.71 and 0.16.72) contain the `unload_path` code, and the config entry has
   `unload_path: /unload`. The cause is not yet known; phase 0 finds it.

## What Strata offers

- `POST /unload` (`N:\Strata\serve\server.py` ~line 1938): frees GPU and RAM, and
  the process stays up. Returns 409 while busy.
- **No shutdown endpoint.** The only clean stop is `N:\Strata\stop-strata.bat`,
  which runs `taskkill /FI "WINDOWTITLE eq Strata server*"` (no `/F`, the same as
  closing the window) and then waits 3 s.

## Phase 0 — diagnose the unload gap (before any code)

Reproduce with Strata loaded (a request has just finished), one window open:

1. Command palette → **Forge: Unload Model** on a Strata chat.
2. Slash `/unloadModel` in a Strata chat.
3. Slash `/unloadAll`.
4. `curl -X POST http://127.0.0.1:8799/unload` (control API).

For each step, record: the exthost log line (`[ExternalModelServers]`), the
toast text ("unloaded" or "was not loaded"), and VRAM before and after
(`nvidia-smi --query-gpu=index,memory.used --format=csv`). Strata frees about
14 GB per 5060 Ti.

Suspects, in order. Read these before guessing:

- **`unloadActiveModel` / `unloadConversationModel`** compute `wasLoaded` from
  the pool. If that check looks only at llama.cpp/Ollama slots, it may return
  "was not loaded" and never call `release()` for a managed external model.
  Follow the chain from `SlashCommandHandler.ts:81` and `nativeCommands.ts:184`
  down to `BackendPool.release()`.
- **Residency stuck at `unloaded`.** `markInUse` is only called from
  `BackendPool.prepareExternal()` (via the request hook). Any Strata dispatch
  path that bypasses `resolveCloudRequestTarget`/`beforeExternalRequest` leaves
  residency at `unloaded` after the first unload. `loadedNames()` is then empty,
  and `unloadAll()` silently does nothing. That fits "one unload line all day".
  Check every Strata dispatch path: chat, jobs, `/compact`, delegation, the chat
  proxy, and the status-bar model picker.
- **Hook registered in only one window.** `setExternalRequestHook` is module
  state. Check it is set in every window's activation, not behind a
  first-window-only branch (shared runtime, control-server owner).
- **Deactivate never awaits the pool.** `deactivate()` in `extension.ts:376`
  does not call `pool.stopAll()` itself ("runs via the subscription above"). If
  that subscription's `dispose` is synchronous, the async POST is dropped when
  the extension host exits. This matters for phase 1 too.

Write the finding into this file (a "Phase 0 findings" section) before fixing.
Fix the root cause, not the symptom. Do **not** make unload unconditional
(ignoring residency) unless phase 0 shows residency can't be tracked; if so, say
why here.

### Phase 0 findings

Root cause: `ExternalModelServers.unload()` captured no ordering information.
It set residency to `unloaded` when its POST completed even when a new request
had called `markInUse()` while that slow POST was in flight. That late write
erased the newer `loaded` state. From then on `loadedNames()` was empty,
`BackendPool.stopAll()` had nothing external to unload, and the single-model
paths returned `wasLoaded: false` before calling `release()`. The fix records an
activity generation at unload start and applies the `unloaded` transition only
if no newer request has started. Residency remains conditional; unload was not
made unconditional.

Evidence and suspect audit:

- Both command chains are wired correctly. `SlashCommandHandler.handle()`
  reaches `SidebarProvider.unloadModels()` / `TabModelRelease.unloadModelOf()`;
  the palette reaches the same sidebar methods. Those reach
  `BackendPool.stopAll()` / `release()`, which include managed external servers
  in `isLoaded()`, `loadedNames()`, and the actual unload call.
- The dispatch audit found no Strata bypass. Sidebar chat (`ProviderTurn`),
  `/compact` and other prompt runs (`PromptRun`), delegation
  (`LocalDelegationService`), the control chat proxy (`ControlChatProxy`), and
  cloud image dispatch all call `resolveCloudRequestTarget()`, which calls the
  external request hook. The model picker does not dispatch a request; the
  first prompt after a pick does. Activation installs the hook before any of
  those paths and is not gated on control-server ownership or another
  first-window condition.
- The 2026-10-02 extension-host log shows unload taking seconds
  (`BackendPool` local stop at 10:30:44.509Z, external unload completion at
  10:30:51.268Z), followed by a fresh Strata request at 10:31:03.679Z. That
  confirms both the long race window and that Strata reloads after unload; the
  only external unload line in the logs is consistent with residency later
  being stuck at `unloaded`.
- `deactivate()` did rely on a synchronous disposable that discarded the
  `pool.stopAll()` promise. That was not the interactive-command root cause,
  but it was a separate teardown defect. Deactivation now awaits the pool and
  the stop-on-exit decision explicitly.
- `test/unit/ExternalModelServers.test.ts` reproduces the ordering directly:
  start unload, mark a request in use before the response completes, then
  complete unload. Before the generation guard the model incorrectly reports
  unloaded and the next unload is skipped; after it, the second unload POST is
  sent.

The optional live `curl` probe was not run: the source/log evidence and the
deterministic regression test isolated the defect without unloading the Strata
instance the user was actively using.

## Phase 1 — stop Strata when the last Forge window closes

### Config (model fields, `openai-compatible` with `unload_path` only)

```yaml
- name: strata-flashnext-iq3s
  unload_path: /unload
  stop_on_exit: true # opt-in, default false
  stop_command: ['cmd.exe', '/c', 'N:/Strata/stop-strata.bat'] # argv, no shell string
```

- `stop_command` is an argv array (Zod: a non-empty array of non-empty strings).
  It is never a shell string, and nothing from it is ever hardcoded.
- `stop_on_exit: true` requires `stop_command` and `unload_path`. Anything else
  is a config error with a clear message (`schema.ts`, beside the existing
  `unload_path` provider check).
- Absent fields mean exactly today's behaviour.

### Behaviour on `deactivate()`

1. **Is this the last Forge window?** Reuse the existing cross-window registry.
   Grep `ControlServerRegistry.ts` and `SharedRuntimeRegistry.ts` first; do not
   invent a new heartbeat file. If other live Forge windows remain, do nothing
   (they may still use Strata). "Live" uses the registry's existing staleness
   rule, so a crashed window doesn't block the stop forever.
2. **Is anything using Strata?** If any turn or agent-task job in this window is
   running on it, skip the stop and log why. Strata answering 409 to the unload
   POST counts as busy too.
3. **Unload, then stop.** POST `unload_path` first (fast, frees VRAM even if the
   stop fails), then run `stop_command`.
4. **Survive the extension host's death.** VS Code gives `deactivate` only a few
   seconds and may kill the extension host's child-process tree. Measure, don't
   assume:
   - Option A: spawn `stop_command` with `detached: true`, `windowsHide: true`,
     `stdio: 'ignore'`, then `unref()`, and return.
   - Option B, if A's child dies with the host (memory: children started from
     WMI/`Start-Process` "died silently" when _starting_ Strata): launch through
     `explorer.exe`, as the user already does by hand.
   - Pick whichever stops Strata reliably across 5 VS Code closes. Record the
     result here. Implementation uses option A (detached, hidden, ignored
     stdio, then `unref()`); the five-close live check is intentionally left to
     the reviewer and is not yet verified.
   - `stop-strata.bat`'s `timeout /t 3` must not hold `deactivate` open; never
     await the child.
5. Log every decision (`skipped: other windows`, `skipped: busy`, `stop
launched`) to the Forge log. A stop that couldn't launch is an error in the
   log; there is no UI left to show it.

### Not in scope

- **Starting** Strata from Forge. It stays a manual or startup-script action;
  that's a separate decision.
- Window _reload_. A reload is not the last window closing; the existing
  unload-on-reload behaviour stays as it is. **Review finding (2026-10-02):**
  `deactivate()` cannot tell a reload from a close, so the first implementation
  stopped Strata on every single-window reload. Fixed by deferring the stop:
  `deactivate()` launches a detached watcher (`src/backend/deferredStop.ts`,
  this host's own binary under `ELECTRON_RUN_AS_NODE`) that waits
  `STOP_GRACE_MS` (20 s) and runs `stop_command` only if no live window holds a
  lifecycle lease by then. A reloaded window re-acquires its lease during
  `onStartupFinished` activation. The watcher starts *before* the unload POST,
  so a host killed mid-unload still stops Strata; a 409 kills the watcher.
- Force-killing. `stop_command` is the user's; Forge never `taskkill /F`s
  anything on its own (CLAUDE.md hard stop).

## Files (expected; follow the owners in `docs/OWNERS.md`)

| File                                                 | Change                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/config/modelSchema.ts`, `types.ts`, `schema.ts` | `stop_on_exit`, `stop_command` + cross-field checks                             |
| `src/backend/ExternalModelServers.ts`                | `stopOnExit()`: busy check → unload POST → launch stop command                  |
| `src/backend/BackendPool.ts` / unload command chain  | phase 0 fix                                                                     |
| `src/extension.ts`                                   | `deactivate()` calls the stop path, last-window check via the existing registry |
| `.forge/config.yaml`                                 | set the two fields on `strata-flashnext-iq3s` (comment: what they do)           |
| `CHANGES.md`, `docs/OWNERS.md`                       | entry; owner row if a new module appears                                        |

## State × lifecycle ledger

| Artifact                                                  | Create                                                         | Delete                                                                  | Pause/disable                           | Crash mid-write                                                                                       | Owner-process death                                                                                                                          | TTL/expiry         |
| --------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `stop_on_exit` / `stop_command` in config.yaml            | Hand edit only                                                 | Hand edit; absent = no stop (today's behaviour)                         | `stop_on_exit: false` is the off switch | Existing loader reports an unparseable config and Forge keeps the last good config                    | Read via `getConfig()` at deactivate; nothing cached                                                                                         | None               |
| Strata server process (owned by the user's start script)  | `start-strata-hidden.vbs`, by hand or at login; Forge also starts it before a request when down | Explicit `/unloadModel` or `/unloadAll` runs `stop_command` immediately after unload; last-window exit runs it after the reload grace period | `stop_on_exit: false` disables the exit path; no `stop_command` disables explicit stop | A failed stop is reported to the explicit command; the server may remain up | VS Code killed or crashed: the detached exit watcher can still stop it if no window reopens | None |
| Detached stop watcher (host binary as Node, then `stop_command`) | `deactivate()`, before the unload POST                  | Exits after the grace period, having launched `stop_command` or not     | A live lease at expiry (reload) skips the stop; a 409 kills it while the host lives | Dies part-way: Strata either got the close message or keeps running, as above                         | Must outlive the extension host; phase 1 step 4 verifies this                                                                                | 20 s grace, then ~3–5 s |
| Cross-window liveness entries (existing registry, reused) | Owned by the existing registry; no new artifact                | Existing rules                                                          | n/a                                     | Existing rules                                                                                        | Existing staleness rule; a crashed window must not block the stop forever                                                                    | Existing rule      |
| Residency map (in memory, existing)                       | First config read: `unknown`                                   | Dies with the extension host                                            | n/a                                     | n/a                                                                                                   | Restart starts at `unknown` = loaded                                                                                                         | None               |

CI-enforced row: a unit test proves `stop_on_exit` without `stop_command` (or
without `unload_path`) is rejected by the config schema, and that
`ExternalModelServers` launches the stop command only when it is the last window
and nothing is busy. The spawn is injected and asserted; the watcher script
itself is really run against a lease directory with and without a live pid.

## Acceptance criteria

- [x] Phase 0 findings are written into this file, with the root cause named.
- [x] Explicit `/unloadModel` and `/unloadAll` unload Strata, then run the
  configured stop command and wait for the endpoint to close; a busy (409)
  response prevents the stop. A model switch and control `POST /unload` remain
  unload-only. Unit coverage: `test/unit/ExternalModelServers.test.ts` and
  `test/unit/ConversationTabsPinModel.test.ts`. Live GPU/process validation
  remains to be performed after installing this version.
- [ ] With `stop_on_exit: true`: closing the last VS Code window stops the Strata
  process. No `strata.exe` remains within 30 s (20 s grace + the .bat), and
  port 8080 is closed. Reloading the only window leaves it running. Closing
  one of two Forge windows leaves it running. Closing while a Strata turn or job
  runs leaves it running and logs why. Unit coverage proves the last-window,
  busy, 409, detached-spawn, and `unref()` decisions; process survival is left
  to the reviewer.
- [x] Configs without the new fields behave exactly as before.
- [x] No `taskkill /F` and no hardcoded path anywhere in `src/`.
- [x] `npm run ci` is green (3,745 passed, 39 skipped; 2026-10-02).
