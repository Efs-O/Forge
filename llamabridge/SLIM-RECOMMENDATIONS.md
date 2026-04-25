# LlamaBridge — Slim & Polish Recommendations

Standalone improvements for the `llamabridge` repo. None of these are
required for LLamaSide; they're independent quality-of-life wins for the
bridge itself.

Apply these in the `llamabridge` repo's own commit history, not LLamaSide's.

---

## 1. Drop `requests`, use `httpx` everywhere

### Why
The bridge currently depends on two HTTP libraries that do the same job:

- `httpx>=0.27.0` — used in `app.py` (async upstream + sync helpers)
- `requests>=2.32.0` — used in **one place only**: a health check in `llama_server.py`

`httpx` has a sync API equivalent to `requests` (`httpx.get(...)`,
`httpx.RequestError`). Removing `requests` drops one direct dep and three
transitive deps (`urllib3`, `idna`, `charset-normalizer`) from end-user
installs.

### The change (4 edits, ~5 lines)

#### a) `continue_llamacpp_bridge/llama_server.py`

**Line 12** — change import:
```diff
-import requests
+import httpx
```

**Lines 53–58** — change the `is_up()` method:
```diff
 def is_up(self) -> bool:
     try:
-        r = requests.get(f"{self.base_url()}/v1/models", timeout=_HEALTH_TIMEOUT)
+        r = httpx.get(f"{self.base_url()}/v1/models", timeout=_HEALTH_TIMEOUT)
         return r.status_code == 200
-    except requests.RequestException:
+    except httpx.RequestError:
         return False
```

#### b) `pyproject.toml`

Remove the `requests>=2.32.0` line from `[project].dependencies`:
```diff
 dependencies = [
   "PyYAML>=6.0.1",
   "httpx>=0.27.0",
   "fastapi>=0.115.0",
   "uvicorn[standard]>=0.30.0",
-  "requests>=2.32.0",
 ]
```

#### c) `requirements.txt`

Remove the `requests>=2.32.0` line:
```diff
 PyYAML>=6.0.1
 httpx>=0.27.0
 fastapi>=0.115.0
 uvicorn[standard]>=0.30.0
-requests>=2.32.0
```

### Verification

After the change, search the repo for any remaining `requests` references
to confirm none are left:

```bash
grep -rn "requests" continue_llamacpp_bridge/ scripts/
# Should return no Python import or usage hits
# (string matches in comments/docs are fine)
```

Run the bridge with `--debug` and confirm the startup poll still detects
llama-server readiness:

```bash
continue-llamacpp-bridge config/bridge.yaml --debug
# Expect: [llama-server] ready at http://127.0.0.1:8080
```

### Risk

Near-zero. `httpx.get()` is a drop-in replacement for `requests.get()` with
the same blocking semantics, same `timeout` parameter shape, and a parallel
exception class. The `is_up()` method is only called from one place
(`start()`'s startup poll loop), so behavior is identical.

### Effort

~5 minutes including verification.

---

## 2. Document `preserve_thinking` in `bridge.example.yaml`

### Why

`continue_llamacpp_bridge/sampling.py` accepts a `preserve_thinking: bool`
key under a model's `sampling:` block. It's special-cased into
`chat_template_kwargs.preserve_thinking` for the upstream request.

This key is **not mentioned in `config/bridge.example.yaml`**, so users
discover it only by reading source. Worth documenting.

### The change

Add a comment to the example `sampling:` block:

```yaml
    sampling:
      # ...existing keys...
      max_tokens: 4096

      # Optional: keep <think> blocks in the model's response (chat_template_kwargs).
      # Most users want this off; turn on if you want to inspect the model's
      # reasoning traces in the IDE.
      # preserve_thinking: false
```

### Effort

~2 minutes.

---

## 3. Add a `/health` endpoint at the bridge level

### Why

The bridge currently exposes `/v1/models` and `/v1/chat/completions`. Both
require a Bearer token. Clients (Continue, LLamaSide, monitoring) have no
unauthenticated way to ask "is the bridge process up?" — they have to
either send a real auth'd request or TCP-probe the port.

A simple unauthenticated `GET /health` returning `200 OK` lets clients
check liveness cheaply and gives monitoring tools an obvious endpoint.

### The change

In `continue_llamacpp_bridge/app.py`, inside `build_app()` after the CORS
middleware setup:

```python
async def health(_request: Request) -> JSONResponse:
    """Liveness check — does NOT verify upstream llama-server."""
    return JSONResponse({"status": "ok"})

app.add_api_route("/health", health, methods=["GET"])
```

Optionally, return upstream status too:

```python
async def health(_request: Request) -> JSONResponse:
    upstream = "up" if proc.is_up() else "down"
    return JSONResponse({"status": "ok", "upstream": upstream})
```

### Risk

None — adds a new endpoint, no existing behavior changes. Note: this
endpoint is intentionally unauthenticated; do not include sensitive data
in the response.

### Effort

~10 minutes.

---

## 4. Optional — Add HF-cache GGUF autodetection

### Why

Currently every model must be explicitly listed in `bridge.yaml` with an
absolute or relative `gguf_path`. Users with the standard HuggingFace
cache (`~/.cache/huggingface/hub`) typed `huggingface-cli download` once
and now have GGUFs they can't use without manually pasting paths.

An optional `model_dirs:` field plus a startup scan would let users add a
GGUF and have it appear automatically.

### Sketch

```yaml
# bridge.yaml
model_dirs:
  - "~/.cache/huggingface/hub"
  - "D:/local-models"

# Auto-discovered models become available aliases:
#   <repo>__<filename-without-ext>
# e.g.  bartowski_Qwen3-7B-Instruct-GGUF__Qwen3-7B-Instruct-Q4_K_M
#
# Explicit `models:` entries still win on alias collision.
```

Implementation: walk each dir, find `*.gguf`, register as model entries
with sane defaults (`num_ctx: default_num_ctx`, no `system_prompt`, no
`sampling:` overrides).

### Effort

~3–4 hours including tests, error handling, Windows path normalization.

### Note

This is also a planned feature for LLamaSide (PLAN-ADDENDUM § A pillar 3,
roadmap v0.3). If both the bridge and LLamaSide implement it, consider
extracting the scan logic into a small shared utility.

---

## 5. Application Order

If you apply these in one session:

1. **#1 (drop `requests`)** — pure cleanup, lowest risk, biggest dep-tree win
2. **#2 (document `preserve_thinking`)** — pure docs
3. **#3 (`/health` endpoint)** — small additive feature
4. **#4 (autodetect)** — bigger, defer to its own dedicated session

`#1`–`#3` together fit a 30-minute commit. `#4` is a separate effort.

---

## 6. Out of Scope (do not change)

These were considered and rejected as unnecessary:

- **Replace FastAPI with stdlib `http.server`** — would cost ~200 LOC of
  async-streaming plumbing for negligible binary savings. FastAPI stays.
- **Replace `uvicorn` with `hypercorn` or similar** — no clear win.
- **Add async health-check** — `httpx.get` (sync) is fine inside the
  startup poll loop; converting it to `await httpx.AsyncClient().get(...)`
  buys nothing because the poll loop is already running on the main thread
  during startup.
