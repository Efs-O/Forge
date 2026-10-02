# Unload commands reach local servers Forge does not spawn (Strata)

## Problem

Strata (`strata-flashnext-iq3s`, provider `openai-compatible`, endpoint
`http://127.0.0.1:8080`) holds ~30 GB of VRAM across both 5060 Tis plus its
vision encoder on the 3060. Forge treats every `openai-compatible` model as a
cloud API, so:

1. `/unloadModel`, `/unloadAll`, the command palette unload, Telegram unload,
   the control API's `POST /unload` (422 "nothing local to unload"), a tab's
   model switch, tab close and a window reload never touch it.
2. Switching a chat or a job from Strata to a llama.cpp/Ollama model loads the
   second model beside it — both fight for the same VRAM and RAM.
3. The reverse: switching to Strata while a llama-server is resident.

## What Strata already offers

`N:\Strata\serve\server.py`: `POST /unload` frees the engine's GPU/RAM and the
vision encoder (`unload()`, ~line 885-902); the server process stays up and
reloads the model on its next request (~line 855). Answers `409 {"status":
"busy"}` while a request runs. So Forge needs no process management at all:
it never starts, stops or kills the Strata process.

## Design

- **`unload_path`** (optional, model field, `openai-compatible` only — a config
  error otherwise): an absolute path POSTed against the model's `endpoint`
  origin to free its memory. Its presence marks the model as a *local server
  that holds VRAM while loaded* (a "managed external server").
- **One owner**: `src/backend/ExternalModelServers.ts`. Tracks residency per
  model in memory: `unknown` (start, counts as loaded — a hand-started server
  may hold VRAM), `loaded` (Forge dispatched to it), `unloaded` (Forge's POST
  succeeded). `unload()` sends the bearer token when `api_key_secret` resolves.
- **BackendPool** (the pool already owns every unload path):
  - `release(name)` on a managed model → `unload_path` POST.
  - `stopAll()` → stops local slots AND unloads every managed model (covers
    `/unloadAll`, the command palette, Telegram, the job's pre-run unload and
    deactivate / window reload — the same as llama.cpp, whose owned servers
    die with the window).
  - Spawning a new llama.cpp slot or attaching a new Ollama model → unload
    managed models first. A busy server (409) fails the spawn with that
    message, rather than loading beside it.
  - `isLoaded` / `loadedModelsExcept` count managed models, so tab switch,
    tab close, `/unloadModel` and the jobs' admission rules see them.
  - `prepareExternal(name)` before every request to a managed model: if any
    local slot is resident, stop them first; refuse with a named error when a
    turn is running on one (no mid-turn kill).
- **Request hook**: `resolveCloudRequestTarget` — the single path every
  openai-compatible dispatch takes (chat, `/compact`, jobs, delegation, chat
  proxy, image) — calls the hook the pool registers.
- **Control API** `POST /unload` accepts managed models.
- **Timeout**: managed models use `localLlamaFetch` (30 min headers wait): a
  just-unloaded Strata reloads before it sends headers.
- **Not covered**: the embeddings llama-server and sd-server keep their own
  lifecycles (small and opt-in). Two Forge windows each track Strata
  separately; the second window's `unknown` state means it also unloads it.

## Combinations

| Before \ action | Chat/job on Strata | Chat/job on llama.cpp | `/unloadModel` | `/unloadAll`, reload |
|---|---|---|---|---|
| Nothing loaded | Strata reloads on request | spawn; Strata `/unload` first (idempotent) | Strata tab: POST unload | stop slots + POST unload |
| Strata loaded | dispatch | POST unload, then spawn | POST unload | POST unload |
| llama loaded, idle | stop slots, then dispatch | reuse slot | release slot | stop + POST |
| llama mid-turn | refused, named | (pool rules as today) | refused (streaming) | as today |
| Strata mid-request | queued by Strata | spawn refused: 409 busy | 409 busy surfaced | 409 surfaced |
| Strata process down | request fails (connection refused, surfaced) | unload POST fails → spawn fails, named | error surfaced | error surfaced |

The last row is a cost: with Strata stopped by hand, a llama.cpp spawn fails
until `unload_path` is removed or Strata runs. Connection-refused on the
unload POST therefore counts as *unloaded* (nothing can hold VRAM without a
listening server) — the only error treated as success.

## Files

| File | Change |
|---|---|
| `src/config/modelSchema.ts`, `types.ts`, `schema.ts` | `unload_path` + provider check |
| `src/backend/ExternalModelServers.ts` (new) | residency, unload POST, request hook |
| `src/backend/BackendPool.ts` | release/stopAll/spawn/isLoaded/prepareExternal |
| `src/llm/CloudRequestResolver.ts` | call the hook |
| `src/llm/ChatClient.ts` | long headers wait for managed models |
| `src/backend/ControlModelLifecycle.ts` | unload accepts managed models |
| `src/extension.ts` | construct + wire |
| `docs/OWNERS.md` | new row |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `unload_path` in config.yaml | Hand edit only | Hand edit; absent = treated as cloud API (pre-change) | Removing it is the off switch | Existing loader reports an unparseable config | Read via `getConfig()` per call; nothing cached | None |
| Residency map (in memory) | First config read: `unknown` | Dies with the extension host | n/a | n/a (no write) | Restart starts at `unknown` = loaded, the safe side | None |
| Strata's loaded model (owned by Strata) | Strata loads on a request | Forge's POST `/unload`, or Strata exits | Strata's own idle unload, if configured | Strata's concern; a failed POST is surfaced, residency unchanged | Strata keeps running after Forge dies; next window starts at `unknown` and unloads it when needed | Strata's own idle settings |

CI-enforced row: `test/unit/ExternalModelServers.test.ts` asserts residency
starts as loaded, an unload POST marks it unloaded, and `stopAll()` on the pool
POSTs the unload.

## Acceptance criteria

- `/unloadModel` on a Strata chat, `/unloadAll`, control `POST /unload` and a
  window reload each POST Strata's `/unload`.
- A llama.cpp spawn unloads Strata first; a request to Strata stops idle
  llama.cpp slots first; neither happens mid-turn.
- Configs without `unload_path` behave exactly as before.
- `npm run ci` green.
