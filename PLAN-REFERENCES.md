# LLamaSide — External References

Single index of every external repo, doc, library, and research source the
project depends on or learns from. Use this as the "where do I look up X"
map. Companion to `PLAN.md`, `PLAN-ADDENDUM.md`, `PLAN-BACKEND.md`, and
`BRIDGE-AUDIT.md`.

---

## 1. VS Code Extension Development

### Required
| Resource                                   | URL                                                                | Why                                              |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| `@types/vscode` (npm)                      | https://www.npmjs.com/package/@types/vscode                        | TS declarations for the entire extension API    |
| Official Extension API docs                | https://code.visualstudio.com/api                                  | Canonical reference, daily-use pages             |
| `vscode-extension-samples`                 | https://github.com/microsoft/vscode-extension-samples              | ~40 minimal sample extensions, one per API      |

### Specific samples to read before coding
| Sample                          | Purpose for us                                       |
| ------------------------------- | ---------------------------------------------------- |
| `webview-view-sample`           | **Core pattern for our sidebar** — read this first   |
| `webview-codicons-sample`       | Using VS Code's icon font in the webview             |
| `chat-sample`                   | Skim only — confirms we're right to skip Chat API    |
| `tree-view-sample`              | Reference if we ever add a model-tree UI             |

### Not needed
- `microsoft/vscode` (the big repo) — millions of LOC, never clone
- `microsoft/vscode-docs` — auto-rendered to the docs site above; read the site

### Specific API pages we'll hit often
| Surface                          | URL                                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| WebviewViewProvider              | https://code.visualstudio.com/api/extension-guides/webview            |
| Workspace.fs (filesystem)        | https://code.visualstudio.com/api/references/vscode-api#FileSystem    |
| TextEditor / WorkspaceEdit       | https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit |
| Commands (LSP queries via execute)| https://code.visualstudio.com/api/references/commands               |
| Diagnostics                      | https://code.visualstudio.com/api/references/vscode-api#Diagnostic    |
| SecretStorage                    | https://code.visualstudio.com/api/references/vscode-api#SecretStorage |
| CodeLens                         | https://code.visualstudio.com/api/references/vscode-api#CodeLens      |
| Activation Events                | https://code.visualstudio.com/api/references/activation-events        |
| Contribution Points              | https://code.visualstudio.com/api/references/contribution-points      |

---

## 2. Local LLM Stack

### Required
| Resource                | URL                                                            | Why                                            |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| llama.cpp               | https://github.com/ggerganov/llama.cpp                         | The inference engine we spawn                  |
| llama-server flags      | https://github.com/ggerganov/llama.cpp/tree/master/examples/server | Source of truth for every CLI arg          |
| llama-server REST API   | https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md | OpenAI-compat endpoints + native ones |
| GGUF spec               | https://github.com/ggerganov/ggml/blob/master/docs/gguf.md     | File format we autodetect                      |

### Models (target families)
| Resource                | URL                                                            | Notes                                          |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Qwen3 collection (HF)   | https://huggingface.co/Qwen                                    | Tool-calling supported, function-call format   |
| Gemma 4 collection (HF) | https://huggingface.co/google                                  | Multimodal variants exist; tool-call quirks documented in bridge `CONTINUE_PATCH_NOTE.md` |
| Bartowski quants        | https://huggingface.co/bartowski                               | Common source for 3-bit GGUFs we target        |

### Multimodal (Vision)
| Resource                | URL                                                            | Notes                                          |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Qwen3-VL                | https://huggingface.co/Qwen (`-VL` variants)                   | Required for `analyze_image` tool              |
| Gemma 4 multimodal      | https://huggingface.co/google                                  | Required for `analyze_image` tool              |

---

## 3. Sibling Projects (Ours)

| Repo                          | URL                                                            | Role                                                |
| ----------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `llamabridge`                 | (to be confirmed by Efs-O)                                     | Python FastAPI bridge; in-tree under `llamabridge/` as reference, removed before deploy |
| `hallumeter`                  | https://github.com/Efs-O/hallumeter                            | Tauri context-fill overlay; complementary tool, see PLAN-ADDENDUM § K |

### In-tree reference files
- `llamabridge/README.md` — bridge usage, troubleshooting, flag semantics
- `llamabridge/CONTINUE_PATCH_NOTE.md` — Continue tool-schema lesson (informs LLamaSide tool design)
- `llamabridge/config/bridge.example.yaml` — schema seed for our `config.yaml`
- `llamabridge/SLIM-RECOMMENDATIONS.md` — slim instructions for the upstream `llamabridge` repo (do not apply here)
- `BRIDGE-AUDIT.md` — our audit + lift list

---

## 4. Competitors / Reference Implementations

Read for inspiration and to avoid reinventing solved problems. Do not lift code.

| Project              | URL                                                            | Why look                                            |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| Continue             | https://github.com/continuedev/continue                        | Closest competitor; their local-model gaps are our wedge |
| Cline                | https://github.com/cline/cline                                 | Strong agent loop, `WebviewViewProvider` patterns  |
| Roo Code             | https://github.com/RooVetGit/Roo-Cline                         | Cline fork, additional tool patterns                |
| aider                | https://github.com/Aider-AI/aider                              | Best-in-class diff/patch application heuristics     |

### Specific things to study
| Project    | What to look at                                                                   |
| ---------- | --------------------------------------------------------------------------------- |
| Continue   | `core/llm/` for OpenAI-compatible client patterns; `extensions/vscode/src/` for sidebar wiring |
| Cline      | `src/core/Cline.ts` for the agent loop shape; tool definitions in `src/core/prompts/tools.ts` |
| aider      | Patch/diff application — most robust open-source implementation                   |

---

## 5. Networking — Search & Fetch

### Search providers
| Provider             | URL                                                            | Notes                                            |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Tavily               | https://docs.tavily.com                                        | **Default**, free 1k/month, LLM-optimized        |
| Brave Search API     | https://brave.com/search/api/                                  | Alt provider, free 2k/month, REST                |
| (future) Exa         | https://exa.ai                                                 | Semantic search; consider as third option later  |

### Fetch + cleaning
| Library                   | URL                                                          | Purpose                                          |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `@mozilla/readability`    | https://github.com/mozilla/readability                       | HTML → article extraction                        |
| `turndown`                | https://github.com/mixmark-io/turndown                       | HTML → Markdown                                  |
| `jsdom` (peer)            | https://github.com/jsdom/jsdom                               | Required by Readability for DOM construction     |

### Security / SSRF
| Resource                  | URL                                                          | Why                                              |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| OWASP SSRF Cheatsheet     | https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html | Required reading before implementing `web_fetch` |
| Private IP ranges (RFC1918) | https://datatracker.ietf.org/doc/html/rfc1918              | Block list                                       |

---

## 6. Templates / Prompting

| Library / Resource        | URL                                                          | Purpose                                          |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Nunjucks                  | https://mozilla.github.io/nunjucks/                          | Jinja2-compatible JS templater                   |
| llama.cpp `--jinja`       | https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md | How upstream applies chat templates              |
| Hugging Face chat templates | https://huggingface.co/docs/transformers/main/en/chat_templating | Reference for the per-model template definitions |

---

## 7. Schema / Validation / Config

| Library                   | URL                                                          | Purpose                                          |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `zod`                     | https://github.com/colinhacks/zod                            | Runtime schema validation for `config.yaml`      |
| `yaml` (eemeli/yaml)      | https://github.com/eemeli/yaml                               | YAML parser                                      |
| JSON Schema spec          | https://json-schema.org                                      | Tool parameter schemas (sent to function-call API)|

---

## 8. Build / Test / Distribution

| Tool                          | URL                                                            | Purpose                                          |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| esbuild                       | https://esbuild.github.io                                      | Bundler — much faster than webpack               |
| `@vscode/test-electron`       | https://github.com/microsoft/vscode-test                       | Integration tests in a real VS Code instance     |
| vitest                        | https://vitest.dev                                             | Unit tests for pure logic                        |
| `vsce`                        | https://github.com/microsoft/vscode-vsce                       | Package + publish extensions                     |
| Open VSX Registry             | https://open-vsx.org                                           | Marketplace alternative for non-Microsoft hosts (Cursor uses it) |

---

## 9. Research (Hallucination & Context)

Background reading that informs HalluMeter integration and our token-budget design.

| Paper / Source                    | URL                                                            | Relevance                                          |
| --------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| "Lost in the Middle" (Stanford/Berkeley) | https://arxiv.org/abs/2307.03172                         | 15-20% accuracy gap mid-context vs edges           |
| Chroma "Context Rot" study (2025) | (to track via HalluMeter `RESEARCH.md`)                        | All 18 models degrade with context fill            |
| HalluMeter `RESEARCH.md`          | https://github.com/Efs-O/hallumeter (when public)              | Calibrated degradation curves we may reuse         |

---

## 10. Distribution Channels (Post-v1.0)

| Channel                       | URL                                                            | Notes                                            |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| VS Code Marketplace           | https://marketplace.visualstudio.com                           | Primary distribution                             |
| Open VSX Registry             | https://open-vsx.org                                           | Required for Cursor and Codium users             |
| GitHub Releases               | https://github.com/Efs-O/llamaside/releases                    | `.vsix` downloads, source archives               |

---

## 11. Quick-Start Cheatsheet (for v0.1 coding session)

When implementation starts, these are the open-tab-while-coding URLs:

1. https://code.visualstudio.com/api/extension-guides/webview-view — sidebar pattern
2. https://github.com/microsoft/vscode-extension-samples/tree/main/webview-view-sample — working code
3. https://code.visualstudio.com/api/references/vscode-api — full API search
4. https://github.com/ggerganov/llama.cpp/tree/master/examples/server — llama-server flag reference
5. `llamabridge/continue_llamacpp_bridge/llama_server.py` — semantic reference for our DirectBackend port

That's it. No source clone of microsoft/vscode required.
