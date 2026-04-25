# AGENTS.md - LlamaBridge

## Stack
Python + FastAPI + llama.cpp bridge. Windows/Linux/macOS.

---

## What This Project Is
LlamaBridge is a standalone bridge that connects Continue to a local llama.cpp `llama-server`,
exposes OpenAI-compatible endpoints, and hot-swaps GGUF models based on the requested model id.

The bridge is configured from a single YAML file and is intended to stay lightweight and local-first.

---

## Hard Stops - Never Do These
- No hardcoded secrets, API keys, or OS paths
- No destructive commands (`rm -rf`, `DROP TABLE`, `git reset --hard`) without explicit user confirmation
- No duplicate implementations - grep before creating anything new
- No unsafe process management or force-killing unrelated processes without explicit approval
- No coupling to unrelated sibling projects

---

## Investigation Hard Limit
- Max 5 investigation steps before stopping
- Stop and ask the user at step 3 if direction is unclear
- Never silently pivot to a different approach mid-investigation

---

## File Size Limit
- 350 LOC max per source file where practical
- Split into modules if exceeded
- Does NOT apply to `.md`, `.json`, `.toml`, config files, or generated files

---

## Single Point of Truth
- `config/bridge.yaml` -> single source for runtime bridge configuration
- `continue_llamacpp_bridge/app.py` -> API behavior and request handling
- `continue_llamacpp_bridge/llama_server.py` -> llama-server lifecycle management
- `continue_llamacpp_bridge/sampling.py` -> sampling validation and forwarded generation params
- Grep before adding any new constant, type, or function

---

## Architecture Rules
- The bridge reads only its own YAML config - do not hardcode model paths or server args
- `llama-server` lifecycle must stay isolated in the bridge process management code
- OpenAI-compatible behavior should remain predictable for Continue clients
- Keep dependencies minimal unless the user explicitly asks otherwise
- Prefer explicit config over hidden fallback behavior

---

## Code Quality Gates
```bash
python -m compileall continue_llamacpp_bridge
```

If tests are added later, run them before finishing changes.

---

## Python Rules
- Keep modules focused and small
- Prefer clear data flow over clever abstractions
- Validate config and request inputs close to the boundary
- Keep platform-specific process behavior explicit and well-contained

---

## No Fallbacks Unless Requested
- No silent error swallowing
- No hardcoded fallback values for user-configurable params
- No hidden behavior that masks invalid config

---

## Ask vs Proceed

| Situation | Action |
|---|---|
| Deleting any file | Ask |
| Adding a new dependency | Ask |
| Changing config schema in a breaking way | Ask |
| Changing public API behavior | Ask |
| Implementing work beyond current scope | Ask |
| Bug fix within current scope | Proceed |
| Formatting / lint-style fixes | Proceed |
| Adding tests for existing behavior | Proceed |
