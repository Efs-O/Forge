# LLamaSide — Backend Plan

Third complementary plan file. Covers the llama.cpp backend architecture,
v0.1 process model, llama-server detection, and the upcoming `llamabridge`
audit. Supplements `PLAN.md` and `PLAN-ADDENDUM.md`; where in conflict,
this file wins for backend topics.

---

## 1. Locked Architecture — Two Paths, One Schema

LLamaSide ships with **two backend modes**, both reading the same
`config.yaml`. User picks via a single key.

```yaml
backend:
  mode: direct                       # 'direct' (default) | 'bridge'
  llama_server_binary: auto          # 'auto' (PATH lookup) | absolute path
  bridge_command: continue-llamacpp-bridge
  bridge_config: ./config/bridge.yaml
  host: 127.0.0.1
  port: 8080                         # or 'auto' (find free port)
  api_key: <random>                  # generated at first run, persisted
```

### Path A — Direct (default for v0.1)
- Extension activates → spawns `llama-server -m <gguf> --port <p> --api-key <k>` directly.
- Pure TypeScript, **zero Python**.
- Model switch = kill + respawn (2–5s pause).
- Implementation: `child_process.spawn`, stdout-watch for ready signal, health-check `/health`, kill on `deactivate()`.
- ~80 LOC total for the controller.

### Path B — Bridge (opt-in)
- Extension activates → spawns `continue-llamacpp-bridge <bridge-config>` (or expects user-managed bridge already running).
- Reuses the existing FastAPI bridge: hot-swap, sampling-merge, system-prompt injection, debugged Continue tool-call path.
- Requires Python 3.10+ and `pip install -e .` of the bridge.
- For users who already run Continue with the bridge, this is zero new install.

### Why two modes
- **Path A** makes LLamaSide installable for the 95% of VS Code users who don't have Python.
- **Path B** preserves the existing investment in the bridge and stays compatible with Continue users.
- Both share `config.yaml` model definitions — only the backend block differs.

---

## 2. v0.1 — Direct Mode Implementation Sketch

```
src/backend/
├── BackendController.ts           Mode-agnostic interface
├── DirectBackend.ts               Path A — spawns llama-server itself
├── BridgeBackend.ts               Path B — spawns / connects to bridge
├── LlamaServerProcess.ts          child_process wrapper (used by Direct)
└── HealthCheck.ts                 GET /health, retry, ready-state
```

### `BackendController` interface
```ts
interface BackendController {
  start(model: ModelConfig): Promise<void>;     // ensure model is loaded
  switchModel(model: ModelConfig): Promise<void>;
  endpoint(): { url: string; apiKey: string };  // for OpenAIClient
  stop(): Promise<void>;
  state: 'idle' | 'starting' | 'ready' | 'switching' | 'error';
}
```

### Direct mode lifecycle
1. `start(model)` — `child_process.spawn(binary, args)` with `--port auto-picked --api-key random`
2. Watch stdout for `"server listening"` or HTTP 200 on `/health` (whichever first)
3. Resolve `ready`
4. `switchModel(other)` — `kill('SIGTERM')` → wait → `start(other)`
5. `stop()` — `kill('SIGTERM')` with 5s grace period, `SIGKILL` if needed

### llama-server detection (v0.1)
1. Read `backend.llama_server_binary` from config
2. If `auto` → check `PATH` for `llama-server` / `llama-server.exe`
3. If `auto` and not on PATH → check well-known install locations (Windows: `C:/Program Files*/Llamacpp/*/llama-server.exe`; macOS: `/opt/homebrew/bin/llama-server`; Linux: `/usr/local/bin/llama-server`)
4. If still not found → show notification with one-click "Open setup guide" linking to llama.cpp install instructions
5. **Do not bundle binaries in v0.1.** Bundling is post-v1.0 polish.

---

## 3. Bridge Audit Plan (Pending File Transfer)

User will copy `llamabridge` files into this repo so we can audit. **No
files in repo yet — this section is a placeholder for the audit checklist
once they land.**

### Audit goals (in priority order)
1. **What's the minimum dep set?** README claims PyYAML, httpx, FastAPI, uvicorn, requests. Verify against `pyproject.toml`. Are any of those redundant (e.g. requests vs. httpx — pick one)?
2. **Sampling-merge logic** — extract from `continue_llamacpp_bridge/sampling.py`. What keys are merged? What are the precedence rules? Goal: reuse the same semantics in LLamaSide's TS request builder.
3. **Hot-swap mechanism** — how does the bridge detect "different model requested"? Does it pre-load before killing, or kill-then-load? Latency profile?
4. **Streaming handling** — SSE pass-through, or buffered? Does it handle disconnect cleanly?
5. **Bearer auth** — how is the API key validated? Constant-time compare?
6. **Thinking-mode handling** — what gets stripped vs. forwarded for `<think>` blocks?
7. **System-prompt injection** — does it prepend or splice into existing system messages? Edge case behaviour when none exists?
8. **Continue tool-call bug fix** — find the commit/diff. What was Ollama doing wrong, what's the fix? Document in PLAN risks.

### Library slimming opportunities to evaluate
| Lib       | Used for                          | Slim option                              |
| --------- | --------------------------------- | ---------------------------------------- |
| FastAPI   | HTTP server                       | Could `aiohttp` or stdlib `http.server` replace? Probably not worth it — FastAPI is small. |
| uvicorn   | ASGI runner for FastAPI           | Required if FastAPI stays                |
| httpx     | Outbound to llama-server          | Could be `requests` (already a dep) — pick one |
| requests  | ?                                 | If only used in one spot, drop in favour of httpx |
| PyYAML    | Read bridge.yaml                  | Required                                 |

**Hypothesis to test against actual code:** drop `requests`, keep `httpx` for both sync and async. Could shrink dep tree by one.

### What we expect to lift into LLamaSide
| From bridge                                  | Into LLamaSide                                              |
| -------------------------------------------- | ----------------------------------------------------------- |
| `config/bridge.example.yaml` schema          | `config/config.example.yaml` (port to LLamaSide naming)     |
| Sampling-merge precedence rules              | TS port in `src/llm/SamplingMerge.ts`                       |
| System-prompt injection logic                | TS port in `src/llm/SystemPromptInjector.ts`                |
| Gemma 4 / tool-call troubleshooting README   | Direct copy into PLAN-ADDENDUM.md § D risks                 |
| Per-model `num_ctx`, `n_batch`, `think` fields | Direct schema reuse                                       |

### What stays in `llamabridge` only
- The FastAPI app itself
- Python packaging (`pyproject.toml`, entry points)
- The `--debug` logging path
- Continue-specific routing nuances

---

## 4. Why Two Paths is Worth the Complexity

Maintaining two backend modes adds surface area. Justification:

- **Path A is the only way to onboard users without Python.** That's the majority. Forcing Python is a wedge-killer.
- **Path B costs near-zero** if we keep the OpenAI-client side abstract. Both modes look identical to the rest of the extension — just a different `BackendController` implementation behind the same interface.
- **Path B also future-proofs us** for Continue interop, multi-agent setups, and any user who has a working bridge they don't want to abandon.
- **No duplicated business logic.** Sampling rules, model selection, YAML schema — all shared. The only divergence is the *process* that hosts llama-server.

---

## 5. Open Questions

1. **Bundled llama-server binary in v1.0?** ~50MB per platform. Hugely improves first-run UX. Counterpoint: bloats the extension and we'd need to track llama.cpp releases. Recommend: **no bundling pre-v1.0; revisit based on user feedback.**
2. **Auto-port picking** — should LLamaSide always auto-pick a free port (avoiding clashes with Continue, other agents) or honour user-set port? Recommend: **auto by default, override via config.**
3. **Multi-instance** — what if user has Continue + LLamaSide both wanting llama-server? Both can run their own (different ports). Path B (bridge) lets them share. Document this in README.
4. **First-run wizard** — show a setup view in the sidebar on first activation if `llama_server_binary` isn't found? Reasonable UX, ~100 LOC. Land in v0.1 or v0.2?

---

## 6. Action Items Before v0.1 Coding

- [ ] User copies `llamabridge` files into this repo (or a `reference/` subdir) for audit
- [ ] Audit completed against § 3 checklist
- [ ] Sampling-merge rules documented as TS pseudocode
- [ ] Gemma 4 / tool-call troubleshooting copied into PLAN-ADDENDUM § D
- [ ] Decision on first-run wizard (v0.1 or v0.2)
- [ ] `config/config.example.yaml` drafted, mirroring bridge schema
