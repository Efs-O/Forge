# F3 — `POST /chat` provider-backed worker proxy (impl plan)

**Goal:** give Relay a path to OpenRouter/xAI/OpenAI workers. Those models'
keys live in VS Code SecretStorage and are only readable inside the extension
host, so `/ensure` correctly 422-rejects them. Add a thin proxy that runs the
completion *inside* the host (where the key is readable) and returns the text.
Key never leaves Forge — consistent with the hard-stop rules.

**Scope discipline (no complexity):** one new route, one tiny new module, one
wiring line. No streaming to the caller, no tool-call loop, no agent loop — a
single buffered completion in, JSON out. Local llama.cpp/Ollama models keep
using `/ensure` exactly as today; `/chat` is *only* for cloud-provider models.

---

## Design

`ControlServer` stays decoupled from `vscode`/SecretStorage (today it imports
only `http` + types). Inject the capability as an optional function in deps:

```ts
// ControlServerDeps
chatProxy?: (req: ChatProxyRequest) => Promise<ChatProxyResult>;
```

- `chatProxy` undefined (e.g. unit tests, or secrets unavailable) ⇒ `/chat`
  returns **501** `{ error: "chat proxy not configured" }`.
- The function is built in `extension.ts`, where `config` + `secrets` exist,
  and passed into `new ControlServer(pool, config, { chatProxy })`.

### New module: `src/llm/ControlChatProxy.ts` (~90 LOC)

`buildControlChatProxy(getConfig, secrets)` returns the `chatProxy` fn. For one
request it:

1. Looks up the model in config. Not found ⇒ throw → 404.
2. **Not a cloud provider** ⇒ throw a typed "use /ensure for local models"
   error → 422. (Local models have a real port; the caller should `/ensure`.)
3. Resolves `baseUrl = getCloudBaseUrl(model)` and the key:
   - `xai` → `resolveXaiToken(model.api_key_secret, secrets)`
   - others → `secrets.get(model.api_key_secret)`; missing ⇒ throw → 422 with
     the "Run Forge: Set Cloud Provider Token" message (reuse AgentLoop's text).
4. Builds the request: `mergeSampling({ model, messages, stream: true, ... }, model)`
   so the model's **config defaults apply** (sampling + `reasoning_effort`) —
   this is the F1 root-cause tie-in (Relay's direct dispatch bypassed config).
   Caller-supplied fields win over config defaults.
5. Calls `streamModelChatCompletion(baseUrl, req, model, handlers, signal, apiKey)`
   with buffering handlers: accumulate `onToken` → `content`, `onReasoning` →
   `reasoning`, capture `finish_reason` from `onDone`, reject on `onError`.
6. Resolves `{ content, reasoning, finishReason }`.

> `tool_calls` are out of scope for this pass (workers in the smoke test only
> needed `write_file` text output). If a tool-call worker path is needed later,
> add `onToolCalls` buffering — additive, no redesign.

### Route: `POST /chat` in `ControlServer.handle`

Request body (validated, strict — no free-form blob):
```jsonc
{ "model": "grok-4.3", "messages": [...],   // required
  "temperature": 0.2, "max_tokens": 2048,    // optional pass-through
  "reasoning_effort": "low", "stop": [...] }
```
- `model` missing ⇒ 400 (reuse `requireModel`).
- `messages` not a non-empty array ⇒ 400.
- No `chatProxy` ⇒ 501.
- Delegate to `chatProxy`; map outcomes:
  - success ⇒ **200** `{ content, reasoning, finish_reason, model }`
  - thrown `ProxyError` carries an HTTP `status` (404 unknown / 422 local or
    missing key) ⇒ that status + `{ error }`
  - other throw ⇒ **502** `{ error }`

**Not serialized** through `this.chain` — `/chat` neither loads nor evicts
local backends, so it must not block behind `/ensure`/`/release`. It runs
concurrently; the cloud provider handles its own concurrency.

`finish_reason` is returned verbatim so a follow-up F1 fix can treat
`length` + empty `content` as an error at the Relay layer without another
Forge change.

### Body size

`readJson` caps at 64 KB. Worker prompts can exceed that with large context.
Bump the cap to 1 MB **for `/chat` only** by adding an optional `maxBytes` arg
to `readJson` (default unchanged for other routes). Minimal, no behavior change
elsewhere.

---

## Files touched

| File | Change | ~LOC |
|------|--------|------|
| `src/llm/ControlChatProxy.ts` | **new** — proxy fn + `ProxyError` + types | ~90 |
| `src/backend/ControlServer.ts` | `chatProxy` dep + `POST /chat` route handler | ~35 |
| `src/backend/controlHttp.ts` | optional `maxBytes` arg on `readJson` | ~3 |
| `src/extension.ts` | build proxy, pass into `ControlServer` ctor | ~4 |
| `test/unit/ControlChatProxy.test.ts` | **new** — proxy unit tests (fake stream) | ~70 |
| `test/unit/ControlServer.test.ts` | `/chat` route: 400/501/200 with a fake proxy | ~30 |

All files stay < 350 LOC (ControlServer is at 336 — the +35 lands ~371, so
move the `/chat` body-parse/validate into a small `parseChatRequest` helper in
`controlHttp.ts` to stay under budget).

---

## Test plan

Unit (vitest, no network):
- proxy: cloud model + fake `streamModelChatCompletion` → buffers tokens,
  returns `content` + `finish_reason`.
- proxy: local model → throws `ProxyError(422)`.
- proxy: unknown model → `ProxyError(404)`; missing key → `ProxyError(422)`.
- route: missing `model` → 400; missing `messages` → 400; no proxy dep → 501;
  happy path → 200 with `{ content, finish_reason }`.

Manual (after VSIX rebuild + reload), real provider:
```powershell
Invoke-RestMethod http://127.0.0.1:8799/chat -Method POST -ContentType application/json `
  -Body '{"model":"grok-4.3","messages":[{"role":"user","content":"PONG?"}]}'
```
Expect 200 with text. Then a local model name → 422 (use /ensure).

## Out of scope (follow-ons)
- F1 empty-on-overflow handling (this exposes `finish_reason`; F1 acts on it).
- Tool-call worker path (additive `onToolCalls` buffering).
- Relay-side change to route `openrouter`/`xai` via `/chat` — separate repo.
