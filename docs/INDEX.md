# Forge — Documentation Index

Single navigational entry point. **Start here.**

---

## Read in this order

1. **[01-overview.md](01-overview.md)** — what Forge is, target users, scope
2. **[02-wedge-and-positioning.md](02-wedge-and-positioning.md)** — the four pillars; how Forge differs from Continue/Cline/Cursor
3. **[03-architecture.md](03-architecture.md)** — backend (Direct + Bridge), repo layout, lifecycle, llama-server detection
4. **[04-config-schema.md](04-config-schema.md)** — `config.yaml` schema, `settings.json` split, capability/permission system
5. **[05-tools.md](05-tools.md)** — full tool catalog, v0.5 implementation set, tool-design rules
6. **[06-networking.md](06-networking.md)** — search/fetch policy, SSRF guard, prompt-injection mitigation
7. **[07-roadmap.md](07-roadmap.md)** — versioned roadmap v0.1 → v1.0+
8. **[08-risks.md](08-risks.md)** — consolidated risks + mitigations
9. **[09-references.md](09-references.md)** — VS Code, llama.cpp, libraries, research
10. **[10-bridge-audit.md](10-bridge-audit.md)** — `llamabridge/` audit + lift list
11. **[11-hallumeter.md](11-hallumeter.md)** — companion tool integration (decision deferred)
12. **[12-release-and-publish.md](12-release-and-publish.md)** — packaging, CI workflow, GitHub Release, Marketplace + Open VSX publish
13. **[13-testing.md](13-testing.md)** — test strategy: vitest unit, @vscode/test-electron integration, ESLint, coverage thresholds, quality gates by stage

Also relevant at repo root:
- **`CLAUDE.md`** / **`AGENTS.md`** — agent rules (hard stops, single-point-of-truth, code quality gates)
- **`llamabridge/`** — in-tree reference, removed before deploy
- **`llamabridge/SLIM-RECOMMENDATIONS.md`** — slim instructions for the upstream `llamabridge` repo (apply elsewhere, not here)

### Planning drafts

- **[multi-tab-chat-plan.md](multi-tab-chat-plan.md)** — multiple sidebar conversation tabs and persistence migration path
- **[offline-vscode-integration-plan.md](offline-vscode-integration-plan.md)** — low-code offline VS Code integration surfaces
- **[embedding-code-search-plan.md](embedding-code-search-plan.md)** — optional local embedding index and `search_codebase` implementation plan

---

## Locked Decisions

These are settled. Do not relitigate without flagging.

| Area                      | Decision                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| Project name              | **Forge**                                                             |
| Backend default           | **Path A — Direct** (TS spawns `llama-server`, no Python required)    |
| Backend alternative       | Path B — Bridge mode (opt-in, for users running `forge-llamacpp-bridge`) |
| Backend protocol          | OpenAI-compatible HTTP (`/v1/chat/completions`)                       |
| Ollama as backend         | **Dropped** — llama.cpp only                                          |
| Target models             | Qwen3 family + Gemma 4 family (3-bit, ~100k ctx default)              |
| UI                        | `WebviewViewProvider` sidebar (not Copilot Chat API)                  |
| Modes                     | Ask / Plan / Execute                                                  |
| Streaming + cancellation  | From v0.1                                                             |
| Templating                | Nunjucks (Jinja2-compatible)                                          |
| Config (models/templates) | `config.yaml`                                                         |
| Config (UI/endpoint/keys) | VS Code `settings.json` + `SecretStorage`                             |
| Checkpoints               | Per-turn snapshot stack, restored via `WorkspaceEdit`                 |
| Edit UX                   | Inline Keep/Undo via `CodeLens` decorations                           |
| Tool order                | Read-only (v0.5) → write + checkpoints (v0.6) → terminal (v0.7)       |
| Tool schemas              | **Strict JSON Schema** — never free-form `string` blobs               |
| Terminal execution model  | `exec_command`: `spawn` + arg array, `shell: false`; Windows built-ins require explicit `cmd.exe`/`powershell.exe` as `command` |
| Terminal confirmation      | Show-before-execute always — user sees exact command before any run   |
| Terminal denylist         | Platform-aware: Unix + Windows/PowerShell destructive patterns; override-phrase required; extensible via config |
| Shell operator policy     | `exec_command`: `&&`, `\|`, `;`, `$()` in args → `ToolError`; model splits into separate calls |
| PowerShell eval ban       | `-Command <string>` and `-EncodedCommand` banned as args to `powershell.exe`; use `-File` only |
| `run_terminal` send policy | `sendText(cmd, false)` only — command pasted but not submitted; user presses Enter |
| Terminal untrusted-content | Commands from fetched/searched content never dispatched — origin check in ToolRegistry |
| Search providers          | Tavily (default, free 1k/mo) + Brave (alt)                            |
| Outbound network          | Only `web_search` + `web_fetch`. Both opt-in via API key/explicit enable |
| Editor target             | VS Code first; Cursor compatibility post-v1.0                         |
| `llamabridge/` location   | In-tree reference; **removed before deploy**                          |
| Bridge logic source       | TS port (no Python runtime dep for end users)                         |
| README posture (v1.0)     | Document both Path A (default) and Path B; link to upstream `llamabridge` repo for Path B users |
| `llama-server` binary     | Detect on PATH or absolute path in config; **no bundling pre-v1.0**   |
| HalluMeter integration    | **Deferred** — decide post-v0.5 dogfooding                            |
| Test framework            | vitest (unit) + @vscode/test-electron (integration); 80% line/function coverage floor |
| Lint + format             | ESLint + `@typescript-eslint/recommended-type-checked` + Prettier via eslint-plugin-prettier |
| Quality gate              | tsc + lint + unit + integration + build — all green on Win/Mac/Linux before merge |

---

## Source-of-truth precedence

If two docs disagree, this is the precedence order:

1. `CLAUDE.md` / `AGENTS.md` — runtime rules for agents working in this repo
2. This file (`docs/INDEX.md`) — locked decisions table
3. Topic-specific docs (`02-` through `11-`) — current detail
4. (No older `PLAN-*.md` files exist anymore — they were consolidated into `docs/`)

---

## Status

- ✅ Planning complete
- ⏳ v0.1 implementation pending — gate is final read-through + sign-off on this docs set
