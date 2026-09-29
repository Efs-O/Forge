# Local queue wait: 30-minute headers wait, visible wait

## Problem

A turn on a local llama.cpp model failed with
`fetch failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)` while a
second chat was using the same server.

Session `55fc5e60` (2026-09-29, Forge 0.16.58), model
`qwen38-27b-dflash2-ud-q6k-vision`, server b11243 started with
`--parallel 1` (`/props` reports `total_slots: 1`):

| UTC | Other chat (`331f87eb`) | This chat |
|---|---|---|
| 05:56:44 | request 23 takes the slot | |
| 05:57:55 | generating | request 1 queues |
| 06:00:22 | slot frees | |
| 06:00:45 | new user message takes the slot | |
| 06:00:46 | | request 1 answered after 171 s (~147 s queued); request 2 queues |
| 06:05:51 | generating | `UND_ERR_HEADERS_TIMEOUT`, 304.6 s after sending |
| 06:06:08 | slot frees, 17 s too late | |

Two facts make this happen:

1. **llama-server sends no response headers until its first result exists.**
   A queued request, and the prefill of a long prompt, both happen before
   headers. The session proves it: a request that had received headers would
   have failed on Forge's own 600 s stream-stall timer instead.
2. **The extension host's `fetch` gives up after 300 s without headers.**
   VS Code 1.138 runs Node 24.18.1, which bundles undici 7.29.0, and undici's
   default `headersTimeout` is 300 000 ms.

So a queued request is a normal state on a single-slot server, and Forge treats
it as a transport failure after 5 minutes. No correct upper bound exists: one
request of the other chat can take longer than 10 minutes on its own
(`max_tokens: 16384` at ~25 t/s is ~11 min, before prefill).

## Decision

Keep one slot for the 27B models (full context per chat). Do not add a turn
timeout, a Forge-side request queue, or change tool-command timeouts. Instead:

- **Fix 1 — a 30-minute headers wait for local llama.cpp (shipped in 0.16.59).**
  Requests for a model whose provider is `llama.cpp` (explicit, or unset, which
  Forge already treats as `llama.cpp`) go through the `undici` package's own
  `fetch` with one shared `Agent({ headersTimeout: 30 min })`. Every other
  provider keeps `globalThis.fetch` unchanged. The first draft of this plan
  turned the timeout off entirely; the user chose a finite 30 minutes so a
  genuinely stuck server still fails, unattended jobs included.
- **Fix 2 — show the wait.** When no headers have arrived 15 s after sending,
  the chat gets one status row saying the server has not started answering,
  most likely because another chat holds its slot or it is reading a long
  prompt, and that Stop cancels.

### Why the npm `undici` fetch and not a `dispatcher` on the global `fetch`

VS Code replaces `globalThis.fetch` in the extension host. With
`http.electronFetch` on, requests go through Electron's `net.fetch`, which has
no undici dispatcher at all; with it off they go through `@vscode/proxy-agent`'s
fetch patch. Passing a dispatcher through that layer would depend on VS Code
internals that can change in any release. A request to a local llama-server
needs no proxy resolution, so calling undici's own `fetch` with its own `Agent`
avoids the patched layer and the version mismatch between an npm `Agent` and the
undici bundled in Node.

The dependency is pinned to undici 6: undici 7 requires Node >= 20.18.1, and
`engines.vscode: ^1.90.0` admits VS Code builds on Node 20.9.

### Why fix 2 does not query `/slots`

With one slot, `/slots` shows the slot busy both when another chat holds it and
when this request is prefilling, and it exposes no id that tells Forge which
request is ours. The notice names both causes instead of guessing.

## Changes

| File | Change |
|---|---|
| `src/llm/localLlamaFetch.ts` (new) | Shared undici `Agent` with `headersTimeout` 30 min; `localLlamaFetch()`; `disposeLocalLlamaFetch()` |
| `src/llm/OpenAIClient.ts` | Fix 1: `streamChatCompletion` takes an optional trailing `fetchImpl` (default: global `fetch`). Fix 2: an `onWaitingForHeaders` handler the existing 15 s watchdog calls |
| `src/llm/ChatClient.ts` | Chooses `localLlamaFetch` when the provider resolves to `llama.cpp` |
| `src/agent/toolCallingStream.ts`, `src/agent/ToolCallingLoop.ts` | Thread an optional `onWaitingForServer` hook |
| `src/sidebar/ModelTurn.ts` | Post the waiting notice to the conversation |
| `src/extension.ts` | Register `disposeLocalLlamaFetch` for deactivation |
| `package.json`, `package-lock.json` | `undici@^6` dependency |

## Risks

- **A wedged server now fails after 30 min instead of 5.** Stop still cancels
  (the abort signal is passed through). An unattended job (Telegram) on a truly
  hung server waits up to 30 min before its turn fails.
- **30 min is not a hard bound on a legitimate wait.** A queued request waits
  for the other chat's current request plus its own prefill; one long answer
  (`max_tokens: 16384` at ~25 t/s is ~11 min) fits, several stacked ones may
  not. If that bites, the follow-up is a progress watchdog: no fixed limit, but
  abort when `/slots` shows no progress for several minutes. Unverified
  first: whether `/slots` counters move during prefill.
- **`bodyTimeout` stays at undici's default (300 s between body chunks).** After
  headers, llama-server streams continuously, so Forge's own stall timers
  remain the effective limit.
- **Bundle size** grows by undici's code (bundled by esbuild).

## Acceptance criteria

- A local llama.cpp request (`provider` unset or `llama.cpp`) is sent through
  `localLlamaFetch`; `xai`, `openrouter`, `openai`, `openai-compatible` and
  `ollama` requests never are (unit test in `ChatClient.test.ts`).
- The shared `Agent` is created once and reused across requests, and a
  caller's abort signal cancels a request still waiting for headers
  (`LocalLlamaFetch.test.ts`, against a real local HTTP server).
- `streamChatCompletion` calls `onWaitingForHeaders` once when headers are
  still missing at 15 s, and not at all when they arrive earlier (fake-timer
  unit test).
- A local request whose headers arrive later than undici's 300 s default
  completes normally. Not unit-tested (it would take over 5 minutes); the live
  check below covers it.
- `npm run ci` and `npm run package` pass.
- Live check: two chats on the single-slot 27B, the second queued for more than
  5 minutes, completes, and shows the waiting row.

## State × lifecycle ledger

No durable state. The shared undici `Agent` (created lazily on the first local request) lives in memory for the extension
host's lifetime and is closed on deactivation; nothing is written to disk,
config, or any store.
