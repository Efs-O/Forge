# Relay Dispatch Findings — Forge-side issues (2026-06-11)

Source: a live multi-provider worker-dispatch test driven by Forge Relay
against this Forge instance (control API :8799). Relay-side findings (a
colon-id routing bug, MCP config split) live in the forge-relay repo:
`docs/MULTIPROVIDER_DISPATCH_FRICTION.md`. The items below are Forge's.

---

## 1. `/ensure` cannot serve provider-backed models (bridge-removal fallout)

`GET /models` advertises the xAI and OpenRouter entries migrated from
`bridge.yaml` during the bridge removal, but `POST /ensure` only knows how to
launch **llama.cpp** and **ollama** backends. Dispatching any provider-backed
model fails like this (live):

> failed to load "grok-4.3": Model "grok-4.3" is missing gguf_path for llama.cpp
> failed to load "google/gemma-4-26b-a4b-it": ... missing gguf_path for llama.cpp

The Python bridge that used to serve these models was deleted with no
replacement, so the catalog is writing checks the control server can't cash.

Fix options (either restores honesty):
- implement provider adapters behind `/ensure` (xai / openrouter /
  openai-compatible entries proxy to their HTTP APIs; nothing to "load", so
  `/ensure` can return immediately with the provider endpoint), or
- filter unservable entries out of `/models` (or mark them
  `servable: false`) so callers never dispatch to them.

Note: provider API keys live in VS Code SecretStorage (`api_key_secret`), so
any serving path must run inside the extension host — external callers (Relay)
cannot self-serve these models.

## 2. Entitlement-gated cloud models fail only at call time

`deepseek-v4-pro:cloud` and `deepseek-v4-flash:cloud` are listed as normal
catalog entries but the ollama backend returns at first use:

> HTTP 403: this model requires a subscription, upgrade for access

On this account the working ollama-cloud models were `gemma4:31b-cloud` and
`qwen3-coder:480b-cloud`. Suggestion: surface entitlement in the catalog
(probe once, cache, mark gated models) so orchestrators can pick reviewers/
workers without call-time surprises.

## 3. Daemon supervision gap (ollama tray ≠ ollama server)

During the test, `ollama app.exe` (tray) was running but nothing listened on
:11434 — every ollama-backed dispatch died "connection refused" until
`ollama serve` was started manually. Same family as the known "Forge backend
must be started manually" item (previously deferred): the stack depends on
daemons nothing supervises. A cheap improvement: when an ollama-backed model
is ensured and :11434 refuses, attempt to start `ollama serve` (or return a
clear actionable error naming the daemon), mirroring whatever is decided for
the Forge backend auto-start.

## Code-audit findings (2026-06-12 sweep, prompted by the above)

A follow-up read of the backend-lifecycle code (ControlServer, BackendPool,
DirectBackend, OllamaAdapter) found five more bugs in the same cluster:

### 4. Port double-push race in `BackendPool.release`

If `release(model)` is called while that model's slot is still starting and
the boot then fails, both paths return the port to `freePorts`: the boot's
`.catch` deletes the slot and pushes the port, then `release` resumes after
its `await slot.starting` and pushes the same port again. The duplicate lets
two future models spawn on one port — surfacing later as the "port already
serving a different model, refusing to adopt" error.

### 5. Fire-and-forget release in `ControlServer.makeRoom`

`void this.pool.release(idle[0])` is not awaited before `pool.acquire(model)`
runs. `release` only frees the slot/port *after* awaiting `backend.stop()`,
so `allocatePort` can run first, see no free ports, LRU-evict the same slot
itself and reuse its port — then the in-flight `release` pushes that port
into `freePorts` while the new slot occupies it. Same double-allocation
corruption as #4, different trigger.

### 6. Cannot hot-swap away from a dead Ollama model

`DirectBackend.hotSwap` awaits `releaseOllamaModel` for the *old* model
unguarded. If the Ollama daemon is down (the finding-#3 scenario), swapping
from an ollama model to a working llama.cpp model throws on the release call
— you're stuck on the dead backend. Old-model release must be best-effort.

### 7. `releaseOllamaModel` fetch has no timeout

No `AbortSignal.timeout` on the fetch — a hung daemon (connection accepted,
no response) hangs `stop()` / `hotSwap()` / `stopAll()` indefinitely,
including extension deactivation.

### 8. Adopted-server monitor leaks across hotSwap

`stopAdoptedMonitor()` is only called from `stop()`. Hot-swapping from an
adopted llama.cpp model to an Ollama model leaves the 5 s poll timer running
against the old port forever; when that old server eventually dies, the
timer's catch handler sets `this.ready = false`, spuriously marking the
now-Ollama backend dead.

### Aggravator for finding #1

Dispatching a cloud-provider model via `/ensure` doesn't just fail — because
it isn't recognized as non-local, it first runs `makeRoom` and can evict a
loaded, idle llama.cpp model before failing. A bad dispatch to `grok-4.3`
actively unloads the working local model as collateral.

### 9. Stale `ready` flag hands out a dead ollama baseUrl (found live, 2026-06-12)

Caught during live validation: after the ollama daemon was stopped,
`POST /ensure` for a cached ollama model returned 200 with a baseUrl in 0 ms —
`DirectBackend.ready` was never re-verified for daemon-backed models, and the
pool's `acquire` trusted it without ever reaching `hotSwap` (where re-ensure
and auto-start live). Fixed: both reuse paths (pool slot and same-model
hotSwap) now re-probe the endpoint cheaply and fall through to the full
re-ensure when the daemon is gone.

### Daemon auto-start field notes (live-tested 2026-06-12)

- Bare `ollama serve` launched programmatically came up reliably in 5–9 s,
  every attempt. The Windows tray app (`ollama app.exe`) spawned fine but
  repeatedly never started its server (two Ollama versions; its retry loop
  only re-connects, it does not re-spawn). Candidate order is therefore:
  config `ollama.executable` > `ollama.exe serve` (%LOCALAPPDATA% install) >
  `ollama serve` (PATH) > tray app last, tried in sequence with a
  per-candidate health wait.
- `ollama serve` reads env vars only — the Ollama app's model-directory
  setting does NOT apply to it. Users with a custom model dir must set
  `OLLAMA_MODELS` system-wide (done on this machine: `N:\.ollama\models`).
- Detached console spawns on Windows need `windowsHide: true` or the daemon
  and its model-runner children flash visible DOS windows.

### Resolution direction (agreed 2026-06-12)

Clear, reason-bearing errors over hidden machinery: `/ensure` rejects
provider-backed models with the actual reason (and `/models` marks them
`servable: false`); ollama entitlement and daemon-down failures surface the
real cause, naming the daemon (`ollama serve`).

Additionally implemented for #3 (the-more-auto-the-better):
- When a model's **local** ollama endpoint refuses connection, Forge now
  starts `ollama serve` itself (executable resolved: `ollama.executable` in
  config.yaml > `ollama` on PATH > the standard `%LOCALAPPDATA%` install
  location on Windows). Opt out with `ollama.auto_start: false`. Remote
  endpoints are never auto-started; if no executable is found, the clear
  error remains.
- Forge now activates on VS Code startup (`onStartupFinished`), so the
  control server on :8799 comes up with any open window — no need to click
  the sidebar first. Relay seeing ":8799 refused" now simply means no VS
  Code window is open (or `control_server.enabled` is false).

## What worked

Once routed, this Forge instance handled the whole run cleanly: hot-loaded the
local 12B worker GGUF alongside the sidebar 26B, served two parallel 12B
workers plus two ollama-cloud models (`gemma4:31b-cloud` spec/coordination,
`qwen3-coder:480b-cloud` builder), all through `/ensure` + the control
catalog, no reload wars.
