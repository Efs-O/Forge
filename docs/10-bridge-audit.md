# 10 — LlamaBridge Audit

Audit of `llamabridge/` (1072 LOC, 16 files) — the in-tree reference Python
bridge. Findings, lift list for Forge's TS port, and slim recommendations
for the upstream `llamabridge` repo.

`llamabridge/` itself is removed from this repo before deploy. Its semantics
are ported to TypeScript inside `src/`.

---

## 1. Files Inventory

| File                                           | LOC | Purpose                                |
| ---------------------------------------------- | --: | -------------------------------------- |
| `continue_llamacpp_bridge/app.py`              | 351 | FastAPI app: routes, SSE, payload merge|
| `continue_llamacpp_bridge/llama_server.py`     | 172 | Subprocess lifecycle for `llama-server`|
| `continue_llamacpp_bridge/sampling.py`         |  61 | YAML sampling validate + merge         |
| `continue_llamacpp_bridge/cli.py`              |  43 | argparse + uvicorn entrypoint          |
| `continue_llamacpp_bridge/__init__.py`         |   3 | Package marker                         |
| `continue_llamacpp_bridge/__main__.py`         |  10 | `python -m` entry                      |
| `config/bridge.example.yaml`                   |  73 | Schema reference                       |
| `config/continue.example.yaml`                 |  33 | Continue-side example                  |
| `pyproject.toml` / `requirements.txt`          |  42 | Packaging                              |
| `scripts/continue_llamacpp_bridge.py`          |  15 | Repo-root launcher (no install needed) |
| `scripts/restart-bridge.ps1`                   |  53 | Windows restart helper                 |
| `README.md` / `CONTINUE_PATCH_NOTE.md`         | 172 | Docs                                   |
| `LICENSE` (MIT)                                |  21 |                                        |

**Total Python code is ~640 LOC.** Easily TS-portable.

---

## 2. Library Audit — Slim Opportunity Confirmed

`requests` is imported in **only one place** — `llama_server.py:13` — for a
single health-check call:

```python
r = requests.get(f"{self.base_url()}/v1/models", timeout=_HEALTH_TIMEOUT)
```

This is trivially replaceable with `httpx.get(...)`. `httpx` is already a
dependency and offers an identical sync API.

### Recommended bridge dep trim

| Lib                | Status                                                     |
| ------------------ | ---------------------------------------------------------- |
| `PyYAML`           | Keep — required                                            |
| `fastapi`          | Keep — required                                            |
| `uvicorn[standard]`| Keep — required ASGI runner                                |
| `httpx`            | Keep — covers all HTTP after slim                          |
| ~~`requests`~~     | **Drop** — single use, replace with `httpx.get`            |

Effort: ~5 LOC change in `llama_server.py`. Removes one transitive dep tree
(`charset-normalizer`, `idna`, `urllib3`) from end-user installs.

(Detailed instructions live in `llamabridge/SLIM-RECOMMENDATIONS.md` — apply
in the upstream `llamabridge` repo, not here.)

### Could we drop FastAPI itself?
Considered. FastAPI gives:
- Two endpoints with type-validated bodies
- CORS middleware
- Bearer token validation patterns
- StreamingResponse for SSE pass-through

Replacing with stdlib `http.server` would cost ~200 LOC of streaming-async
plumbing for negligible binary savings. **Not worth it.** FastAPI stays.

---

## 3. Sampling-Merge Rules — Extracted

`sampling.py` defines exactly **10 allowed sampling keys** plus 1 special:

```
Pass-through to payload (10):
  temperature, top_p, top_k, min_p,
  frequency_penalty, presence_penalty,
  repetition_penalty, repeat_penalty,
  max_tokens, seed

Special-cased into chat_template_kwargs (1):
  preserve_thinking      (bool only)

Unknown keys → ValueError (validation rejects)
```

Merge rule: **YAML wins for any listed key, request passes through for the rest.**

This is the layered-config behaviour we adopt. Direct lift target.

Forge TS port: `src/llm/SamplingMerge.ts`, ~30 LOC, identical semantics.

---

## 4. Hot-Swap Mechanism — Kill-then-Load (not Pre-load)

From `llama_server.py` `start()`:

1. Fast-path: if server up AND `(model, ctx, batch)` all match current → no-op.
2. Otherwise: `terminate()` existing process, wait up to 10s, fall back to `kill()`.
3. `subprocess.Popen` new process with composed argv.
4. Poll `GET /v1/models` every 1s, max 120s, until 200.
5. Also watches `proc.poll()` to detect early exit.

**Switch latency = full model reload time.** No pre-load optimisation.

Compose flags (lifted from `_compose_cmd`):
```
-m <gguf>  --jinja  --host  --port
--n-gpu-layers  --ctx-size  --batch-size
--cache-type-k  --cache-type-v
--parallel  --flash-attn (on|off)
--threads  --threads-batch
+ extra_llama_server_args
```

Forge `DirectBackend.ts` (Path A) implements **the same lifecycle** in
TypeScript. ~80 LOC mapping to `child_process.spawn`.

---

## 5. The Continue "Patch" — Important Context

`CONTINUE_PATCH_NOTE.md` reveals this is **not a bridge fix**. It's a
hand-applied edit to Continue's bundled `extension.js` (in the Cursor
install dir) that removes the `edit_existing_file` tool from the model's
toolset. Reason:

> `edit_existing_file` uses a weak schema: `filepath: string`, `changes: string`.
> That free-form `changes` field is easy for smaller local models to misuse.

This isn't portable code we can lift. It's a **lesson** for Forge tool design:

### Tool-design rule: never ship `string` blobs as tool args

| Bad schema (Continue's `edit_existing_file`)            | Good schema (Forge must use)                          |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `changes: string` — free-form description of changes    | `unified_diff: string` — strict format, parseable     |
|                                                         | `old_str: string`, `new_str: string` — exact match    |
|                                                         | `edits: [{ range, replacement }]` — structured        |

This is a hard rule in `CLAUDE.md` and [05-tools.md](05-tools.md). Already
addressed: `replace_in_file`, `replace_selection`, `insert_at_cursor`,
`apply_patch` all have strict schemas.

---

## 6. Lift List — What Goes into Forge

| From bridge file                          | To Forge                                                       | Effort  |
| ----------------------------------------- | -------------------------------------------------------------- | ------- |
| `config/bridge.example.yaml` schema       | `config/config.example.yaml` (rename keys to Forge vocab)      | 30 min  |
| `sampling.py` rules                       | `src/llm/SamplingMerge.ts` (TS port, identical semantics)      | 1 hour  |
| `_merge_system_prompt_into_messages`      | `src/llm/SystemPromptInjector.ts`                              | 30 min  |
| `merge_reasoning_chat` (think mode)       | `src/llm/ThinkingMode.ts`                                      | 20 min  |
| `_strip_openai_tools_from_chat_payload`   | `src/llm/StripTools.ts` (Gemma 4 fallback)                     | 30 min  |
| `LlamaServerProc._compose_cmd` argv       | `src/backend/LlamaServerArgs.ts`                               | 1 hour  |
| `LlamaServerProc.start/stop` lifecycle    | `src/backend/DirectBackend.ts`                                 | 2 hours |
| Streaming-with-status-precheck pattern    | `src/llm/OpenAIClient.ts` (avoid "response already started")   | ref     |

**Total: ~6 hours of careful TS porting** for full Path A backend that mirrors
the bridge. All semantics preserved.

---

## 7. Bridge Self-Slim — Standalone Recommendations

These benefit the upstream `llamabridge` repo independently of Forge.
Detailed instructions in `llamabridge/SLIM-RECOMMENDATIONS.md`.

| Change                                                            | Win                                  | Effort |
| ----------------------------------------------------------------- | ------------------------------------ | ------ |
| Drop `requests`, use `httpx.get` in `llama_server.py`             | -1 dep tree                          | 5 min  |
| Document `preserve_thinking` in `bridge.example.yaml`             | Currently undocumented in YAML       | 5 min  |
| Add a `health` endpoint on the bridge itself (not just upstream)  | Lets clients check before requests   | 10 min |
| Optional: add `model_dirs` autodetect (HF cache scan)             | Wedge feature shared with Forge      | 4 hours|

**The bridge does not need slimming beyond the `requests` drop.** It's already
tight: 640 LOC, 4 deps after slim.

---

## 8. v0.1 Backend Decision — Reaffirmed

Path A (Direct, TS-only) remains the right default.

**Evidence supporting this:**
- The bridge is small enough to TS-port (~640 LOC → ~500 LOC TS)
- All complex logic (sampling merge, system-prompt injection, thinking mode,
  strip-tools, argv composition) is well-isolated and pure
- Hot-swap is just kill+spawn — no exotic Python state to preserve
- Path B users still get the value: they keep the existing bridge, point
  Forge at it, and we never touch the Python code

Forge neither forks the bridge nor depends on it. We **inherit the schema
and the semantics** through TS reimplementation, while staying compatible with
the bridge for users who want the Python path.

---

## 9. Removal Plan (before deploy)

Before publishing Forge to the marketplace:

1. Confirm all listed lift-list items have been ported to `src/`
2. Confirm `config/config.example.yaml` mirrors `llamabridge/config/bridge.example.yaml` semantics under Forge naming
3. Delete `llamabridge/` from this repo
4. Update README to point users at the upstream `llamabridge` repo for Path B
5. Tag the commit just before removal as `pre-bridge-removal` for archaeological reference

After removal, this audit doc remains in `docs/` as the historical record of
what was lifted and why.
