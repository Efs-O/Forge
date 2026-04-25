# LLamaSide — Implementation Plan

A local-first VS Code extension providing a Continue-style sidebar AI assistant
backed by GGUF models via llama.cpp / Ollama. Three modes: Ask, Plan, Execute.

---

## 1. Locked Design Decisions

| Area              | Decision                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| Backend           | OpenAI-compatible HTTP (`/v1/chat/completions`) — llama.cpp / Ollama     |
| Target models     | Qwen3 family, Gemma 3/4 family — 3-bit quants                            |
| Default context   | ~100k tokens (user-tunable)                                              |
| UI                | `WebviewViewProvider` sidebar (no Copilot Chat API)                      |
| Modes             | Ask / Plan / Execute                                                     |
| Streaming         | SSE from v0.1, with cancellation token                                   |
| Templating        | Nunjucks (Jinja2-compatible) — user-overridable                          |
| Config            | `config.yaml` for models/flags/templates; `settings.json` for UI/endpoint|
| Checkpoints       | Per-turn snapshot stack, restore via `WorkspaceEdit`                     |
| Edit UX           | Inline Keep/Undo via `CodeLens` decorations                              |
| Tool order        | Read-only → write → terminal (with allowlist)                            |
| Editor target     | VS Code first; Cursor compatibility after v1.0                           |

---

## 2. Repository Layout

```
LLamaSide/
├── package.json                  Extension manifest + contributions
├── tsconfig.json
├── esbuild.config.mjs            Bundling (faster than webpack)
├── .vscodeignore
├── PLAN.md                       This file
├── README.md
│
├── src/
│   ├── extension.ts              activate() / deactivate()
│   ├── sidebar/
│   │   ├── SidebarProvider.ts    WebviewViewProvider implementation
│   │   ├── messageBridge.ts      Typed host↔webview message protocol
│   │   └── webview/              Built webview assets (HTML/JS/CSS)
│   ├── llm/
│   │   ├── OpenAIClient.ts       Streaming OpenAI-compatible client
│   │   ├── types.ts              ChatMessage, ToolCall, etc.
│   │   └── cancellation.ts       AbortController plumbing
│   ├── config/
│   │   ├── ConfigLoader.ts       YAML loader + schema validation
│   │   ├── schema.ts             Zod schema for config.yaml
│   │   └── defaults.ts           Built-in templates + sane defaults
│   ├── templates/
│   │   ├── TemplateEngine.ts     Nunjucks wrapper (sandboxed)
│   │   └── builtin/              Default Ask/Plan/Execute templates
│   ├── modes/
│   │   ├── AskMode.ts            Pure chat
│   │   ├── PlanMode.ts           Structured-step output
│   │   └── ExecuteMode.ts        Agent loop
│   ├── tools/
│   │   ├── ToolRegistry.ts       Tool dispatch + JSON-schema descriptors
│   │   ├── readFile.ts
│   │   ├── searchCode.ts
│   │   ├── writeFile.ts
│   │   ├── replaceSelection.ts
│   │   ├── insertAtCursor.ts
│   │   └── runTerminal.ts        With allowlist + per-call confirmation
│   ├── checkpoint/
│   │   ├── CheckpointStack.ts    Per-turn snapshot + restore
│   │   └── KeepUndoCodeLens.ts   Inline Keep/Undo decorations
│   └── util/
│       ├── logger.ts
│       └── tokens.ts             Approx token counter
│
├── webview-ui/                   Webview source (separate build)
│   ├── index.html
│   ├── main.ts                   Chat UI logic
│   ├── components/               Mode selector, model picker, message list
│   └── styles.css
│
└── test/
    ├── unit/
    └── integration/              vscode-test runner
```

---

## 3. Versioned Roadmap

### v0.1 — Chat MVP
- Extension manifest, activation, sidebar registration
- `WebviewViewProvider` rendering a chat panel
- Streaming OpenAI-compatible client with `AbortController`
- Endpoint + model name in `settings.json`
- Cancel button, basic message history (in-memory)
- **Exit criteria**: type a prompt, see streamed tokens from local llama.cpp/Ollama

### v0.2 — Editor Context
- "Send selection" button + active-editor context capture
- Insert response at cursor / Replace selection actions
- Per-message "copy" / "insert" / "replace" buttons in webview

### v0.3 — Multi-model + per-model params
- Model picker dropdown
- Multiple endpoints registered in settings
- Per-model temperature / top_p / max_tokens

### v0.4 — Plan Mode
- Structured-step output (numbered plan, no execution)
- Mode selector wired (Ask vs Plan)
- Plan rendered as checklist in webview

### v0.5 — Tool framework + read-only tools
- `ToolRegistry` with JSON-schema descriptors
- Native tool-calling path (Qwen/Gemma function-call format)
- Structured-output fallback parser for weaker models
- `read_file`, `search_code` implemented and tested
- Tool call rendering in chat UI

### v0.6 — Write tools + checkpoints + Keep/Undo
- `write_file`, `replace_selection`, `insert_at_cursor`
- Per-turn `CheckpointStack` snapshotting touched files
- Inline `CodeLens`-based Keep/Undo on each agent edit
- Session-level "Undo last turn" command

### v0.7 — Execute Mode (full agent loop)
- Agent loop: prompt → tool call → exec → result → repeat
- `run_terminal` with default-deny allowlist + per-command approval UI
- Iteration cap + token-budget guard
- Mode selector includes Execute

### v0.8 — YAML config + Nunjucks templates
- `config.yaml` loader with Zod schema validation
- Models, flags, system prompts, mode templates all overridable
- Default templates shipped in `templates/builtin/`
- Hot-reload on save

### v0.9 — Polish
- Conversation persistence (per workspace)
- Token budget UI (used / max)
- Error surfacing (backend down, model not found, context overflow)
- Settings UI improvements

### v1.0 — Multi-model UX + autodetect
- GGUF folder scan → auto-register models
- Quick-switch model per message
- Telemetry-free, account-free release

### Post-v1.0
- Cursor compatibility pass
- `apply_patch` (unified diff parser + fuzzy hunk apply)
- Routing rules in `config.yaml` (e.g. coding model vs reasoning model)
- MCP tool support

---

## 4. Critical Path / Risks

| Risk                                                    | Mitigation                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tool-calling reliability varies across local models     | Dual path: native function-call + structured-output fallback parser     |
| Double templating (extension + backend chat template)   | Send `messages[]`, let backend template; document this clearly          |
| Agent edits trash files                                 | Per-turn checkpoints + Keep/Undo before any write tool ships            |
| `run_terminal` hallucinated destructive commands        | Default-deny allowlist + per-call approval UI from day one              |
| Context overflow on long sessions                       | Token budget guard with summarization fallback                          |
| Cursor API drift breaks extension                       | Defer Cursor support to post-v1.0; pin VS Code engine version           |
| Webview ↔ host message protocol drift                   | Single typed `messageBridge.ts` with discriminated unions               |

---

## 5. Tech Stack

- **Language**: TypeScript (strict mode)
- **Bundler**: esbuild
- **Webview**: vanilla TS + lit-html (or Preact if state grows) — no React bloat
- **HTTP**: `fetch` + `ReadableStream` for SSE (no axios)
- **YAML**: `yaml` (eemeli/yaml)
- **Schema**: `zod`
- **Templates**: `nunjucks`
- **Testing**: `@vscode/test-electron` + `vitest` for unit

---

## 6. Open Questions Before Coding

1. Single endpoint or multiple endpoints simultaneously in v0.1? (Recommend: single, multi in v0.3)
2. Conversation persistence storage — `globalState`, `workspaceState`, or file? (Recommend: `workspaceState` per workspace)
3. Webview state on hide/show — preserve or recreate? (Recommend: `retainContextWhenHidden: true`)
4. Default system prompt content for each mode — ship now or after first dogfood pass?

---

## 7. v0.1 Deliverable Checklist

- [ ] `package.json` with `viewsContainers` + `views` contribution
- [ ] Activity Bar icon + sidebar view
- [ ] `SidebarProvider` rendering webview HTML
- [ ] Webview chat UI (input, message list, send, cancel)
- [ ] `OpenAIClient` with streaming + `AbortController`
- [ ] Settings: `llamaside.endpoint`, `llamaside.model`, `llamaside.temperature`
- [ ] End-to-end smoke test against local llama.cpp server
- [ ] README with setup steps
