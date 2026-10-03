# External server start: Forge launches a managed server before the first request

Status: implemented 2026-10-03.

## Problem

A managed external server (Strata: `openai-compatible` + `unload_path`) is one
Forge does **not** spawn — it only unloads and stops it. If the server process
is down (the user killed it, or it was never started), the first request fails
with `fetch failed: connect ECONNREFUSED 127.0.0.1:8090`, and there is no way
to make the prompt "just work" without starting the server by hand.

`llama.cpp` models do not have this problem: `BackendPool.startSlot` spawns
`llama-server.exe` itself. This plan gives a managed external server the same
"send a prompt → it starts" behaviour, opt-in per model.

## Design

- **`start_command`** (optional, model field, `openai-compatible` only): an argv
  array, exactly like `stop_command`. Never a shell string. An exact `{num_ctx}`
  argv item resolves to the configured model context before launch.
  Its presence + `unload_path` marks the model as a managed server Forge may
  start.
- **When it runs:** in `BackendPool.prepareExternal`, which already runs before
  every request to a managed server. Order:
  1. `freeLocalForExternal` — unload every local llama.cpp/Ollama model so the
     two never share VRAM (existing behaviour; this is what makes room for
     Strata to load).
  2. `ensureStarted` — **new**: probe the endpoint; if it is down, launch
     `start_command` and wait until it accepts connections.
  3. `markInUse` — record that a request is about to go (existing).
- **`ensureStarted(name)`** (`ExternalModelServers`):
  - Probe `GET {endpoint}/v1/models` (`probeHttp`). If `reachable`, the process
    is up — return immediately (the model load, if `--lazy`, happens on the
    first request and is transparent to Forge). A 401/404 still counts as
    reachable: the process is up, auth/route is a separate concern.
  - If not reachable and **no** `start_command`: throw a clear error naming the
    endpoint and telling the user to start it manually (today's behaviour, but
    actionable instead of a bare `ECONNREFUSED`).
  - If not reachable and **`start_command` present**: spawn it `detached`,
    `windowsHide`, `stdio: ignore`, then `unref()` (same shape as the stop
    watcher, so it survives the extension host). Then poll `probeHttp` until
    `reachable` or `START_TIMEOUT_MS`. On timeout, throw — the process is left
    running (detached), so a retry on the next prompt succeeds.
- **Timeouts:** `START_TIMEOUT_MS = 240_000` (4 min — Strata loads its ~30 GB
  model at startup when started without `--lazy`), `START_POLL_MS = 2000`.
- **Config (Strata):**
  ```yaml
  start_command: ["wscript.exe", "N:/Strata/start-strata-hidden.vbs", "{num_ctx}"]
  num_ctx: 100000
  ```
  The VBS passes `hidden` and the context to `start-strata.bat`. The local Python
  launcher forwards it as Strata's `--max-context` CLI override; a direct batch
  start with no context argument reads the same Forge YAML. Strata replaces the
  JSON config's context for that server start.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
| --- | --- | --- | --- | --- | --- | --- |
| `start_command` in config.yaml | Hand edit only | Hand edit; absent = no auto-start (today's behaviour) | Absent is the off switch | Existing loader reports an unparseable config and keeps the last good config | Read via `getConfig()` at request time; nothing cached | None |
| Strata server process (owned by the user's start script, now also by Forge) | User's start script, **or** Forge's `ensureStarted` when down | User's `stop-strata.bat`; or Forge's `stop_on_exit` at last-window exit; or a manual unload | `stop_on_exit: false` / no `start_command` | `start_command` fails to launch: error is logged, the request fails, the user starts it by hand (today's state) | Forge's extension host dies: the detached, unref'd child is an orphan and keeps running — the server stays up, which is the desired state | None |
| Readiness wait (in memory, per request) | `ensureStarted` when the probe is not reachable | Resolves on reachable or timeout | n/a | n/a (no durable artifact) | The waiting request is dropped with the host; the detached server keeps starting and the next prompt finds it up | `START_TIMEOUT_MS` |

## Files

| File | Change |
| --- | --- |
| `src/config/modelSchema.ts`, `types.ts`, `schema.ts` | `start_command` field + cross-field checks (openai-compatible only; requires `unload_path`) |
| `src/backend/ExternalModelServers.ts` | `ensureStarted()`, `launchStart()`, `waitReachable()` + `START_TIMEOUT_MS`/`START_POLL_MS` |
| `src/backend/BackendPool.ts` | `prepareExternal` calls `ensureStarted` after freeing local models |
| `.forge/config.yaml` | set `start_command` on `strata-flashnext-iq3s` |
| `test/unit/ExternalModelServers.test.ts` | down+start, down+no-start, already-up, timeout, config checks |
| `CHANGES.md` | entry |

## Acceptance criteria

- [x] `start_command` is accepted on `openai-compatible` with `unload_path`, and
  refused elsewhere or without `unload_path` (config schema tests).
- [x] Server already reachable → `ensureStarted` returns without spawning
  (no `spawn` call, no wait).
- [x] Server down + `start_command` set → `spawn` is called detached/hidden/
  unref'd, then the wait polls until the endpoint is reachable.
- [x] Server down + no `start_command` → throws an actionable error naming the
  endpoint; no `spawn` call.
- [x] Server down + `start_command` set but never becomes reachable within
  `START_TIMEOUT_MS` → throws a timeout error; the spawned process is not
  killed (left running for a retry).
- [x] `prepareExternal` frees local models **before** `ensureStarted`, so VRAM
  is free when the server loads.
- [x] Configs without `start_command` behave exactly as before.
- [x] `{num_ctx}` in `start_command` reaches the launcher; Strata's CLI override
  replaces its JSON context without changing the JSON (`ExternalModelServers.test.ts`,
  `serve.test_server.ContextOverride`). A direct local batch start also reads
  `num_ctx` from Forge YAML when no argument is supplied (`start_strata.context_size`).
- [x] `npm run ci` is green.

The live "send a prompt to a dead Strata and it comes up with the configured
context" check remains pending: the currently running server reports 154624,
and the new 100000 value takes effect only after its next start.
