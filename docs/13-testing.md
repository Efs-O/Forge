# 13 — Testing Strategy

What to test, with what tools, at what threshold, and what gates on what stage.

---

## Framework stack

| Layer             | Tool                          | Scope                                              |
| ----------------- | ----------------------------- | -------------------------------------------------- |
| Unit              | `vitest`                      | Pure logic — no VS Code API, no child processes    |
| Integration       | `@vscode/test-electron`       | VS Code Extension Host — real API, no llama-server |
| Type checking     | `tsc --noEmit`                | All TypeScript, strict mode                        |
| Linting           | `eslint` + `@typescript-eslint` | Code style + safety rules                        |
| Formatting        | `prettier`                    | Enforced via lint, not a separate step             |

All five run in CI on every push. All five must be green to merge.

---

## Unit tests (`vitest`)

Unit tests cover **pure logic only** — modules with no VS Code API imports
and no process side effects. The rule: if the module can be tested by just
calling a function with inputs and asserting outputs, it belongs here.

### What gets a unit test (required for every module)

| Module                          | What to test                                                      |
| ------------------------------- | ----------------------------------------------------------------- |
| `src/llm/SamplingMerge.ts`      | All 10 pass-through keys; YAML-wins merge rule; unknown key → error; `preserve_thinking` routing |
| `src/llm/SystemPromptInjector.ts` | Inject into empty messages; inject before existing system; no-op when absent |
| `src/llm/ThinkingMode.ts`       | `think: true` sets `enable_thinking`; `think: false` does not; `preserve_thinking` flag |
| `src/llm/StripTools.ts`         | Strips `tools` field from payload; leaves everything else intact  |
| `src/backend/LlamaServerArgs.ts` | argv composition for every flag: `-m`, `--ctx-size`, `--n-gpu-layers`, `--flash-attn`, etc. Platform path separators (Win/Unix). |
| `src/backend/HealthCheck.ts`    | Retry logic; max-attempts ceiling; early-exit on proc death       |
| `src/config/schema.ts` (Zod)    | Valid full config parses; missing `gguf_path` → error; unknown top-level key → warning not throw; API key in YAML → error |
| `src/config/ConfigLoader.ts`    | Workspace config overrides global; invalid YAML surfaces error not crash |
| `src/tools/ToolRegistry.ts`     | Capability gate drops tools; permission gate blocks dispatch; untrusted-content origin blocks exec tools |
| `src/llm/OpenAIClient.ts`       | SSE chunk parsing; abort cancels in-flight; error response surfaces correctly |
| `src/util/tokens.ts`            | Token estimates within ±20% of known values                       |
| Terminal denylist               | Every pattern in the denylist matches its target; no false positives on common safe commands (`git status`, `npm install`, `ls`) |
| Shell operator blocker          | Each operator (`&&`, `\|`, `;`, `$()`, `` ` ``) triggers `ToolError`; clean args pass through |

### What does NOT get a unit test

- Anything that imports `vscode` — that goes in integration tests
- `window.createTerminal`, `workspace.fs`, `languages.*` — VS Code API
- `child_process.spawn` calls in `DirectBackend.ts` — integration test scope
- Webview-side TypeScript — tested visually, no automated unit tests

### Coverage threshold

Vitest is configured with a minimum coverage requirement:

```jsonc
// vitest.config.ts
{
  coverage: {
    provider: 'v8',
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 75,
      statements: 80
    },
    exclude: [
      'src/sidebar/webview/**',  // webview UI — not unit-testable
      'src/extension.ts',        // activation glue — integration test scope
      '**/*.d.ts'
    ]
  }
}
```

CI fails if coverage drops below threshold. The threshold is a floor, not a
target — aim higher on pure-logic modules (SamplingMerge, LlamaServerArgs,
denylist should be 100%).

---

## Integration tests (`@vscode/test-electron`)

Integration tests run inside a real VS Code Extension Host process. They can
call `vscode.*` APIs, activate the extension, and interact with the sidebar.
They do **not** require a running `llama-server` — backend calls are stubbed.

### What integration tests cover

| Scenario                                    | Approach                                              |
| ------------------------------------------- | ----------------------------------------------------- |
| Extension activates without error           | `activate()` completes; sidebar view registered       |
| Config validation surfaces in sidebar       | Load a broken `config.yaml`; assert error message shown |
| Capability gate drops vision tool           | Activate with model without `vision` capability; assert `analyze_image` not in tool list |
| Permission gate blocks `fs:delete`          | Config with `delete: false`; dispatch `delete_file`; assert "permission denied" result |
| Confirmation gate fires for write tool      | Mock `showQuickPick`; assert it is called before `write_file` executes |
| Untrusted-content tool call is blocked      | Inject tool call inside `<UNTRUSTED_CONTENT>` delimiter; assert not dispatched |
| `config.yaml` hot-reload                   | Write new config to disk; assert extension picks it up without restart |
| Message bridge typed correctly              | Post a `send` message; assert `tokens` messages arrive back |

### Stub strategy

- `llama-server` / bridge HTTP calls → `fetch` stub via `vi.stubGlobal`
- `child_process.spawn` → stub returns a mock process with controllable stdout/exit
- File system writes → `workspace.fs` calls are real (test workspace is a temp dir)
- `SecretStorage` → mock implementation returning test values

### What integration tests do NOT cover

- Streaming SSE correctness at scale — unit-test the parser, trust Node's `fetch`
- `llama-server` CLI behavior — that is llama.cpp's test suite, not ours
- UI rendering, CSS, layout — manual review

---

## Type checking

```bash
npx tsc --noEmit
```

`strict: true` is non-negotiable. The following are treated as errors:

- `any` without an inline `// justified: <reason>` comment
- Missing return types on exported functions
- Unhandled promise rejections (`@typescript-eslint/no-floating-promises`)
- Unused variables and imports

Type checking runs before tests in CI. A type error blocks everything
downstream.

---

## Linting

### ESLint config (`.eslintrc.json`)

```jsonc
{
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked"
  ],
  "rules": {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/explicit-module-boundary-types": "error",
    "no-console": "error",                  // use logger.ts, never console.*
    "eqeqeq": ["error", "always"],
    "no-eval": "error",                     // belt-and-suspenders for terminal safety
    "no-new-func": "error"                  // same
  }
}
```

`no-eval` and `no-new-func` are enforced by the linter as a belt-and-suspenders
safety net alongside the terminal safety architecture in [05-tools.md](05-tools.md).

### Prettier

```jsonc
// .prettierrc
{
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "es5"
}
```

Prettier is run via ESLint (`eslint-plugin-prettier`). One pass, one command:
`npx eslint --fix` formats and lints simultaneously. Formatting is not a
separate CI step — lint failure catches it.

---

## Quality gates by stage

### On every file save (developer machine — optional but recommended)

- Type check on the changed file (VS Code's built-in TS language server)
- ESLint on save (VS Code ESLint extension)

These are IDE-only. Not enforced by CI.

### On every `git push` / PR (CI — `ci.yml`, all three platforms)

| Check              | Command                        | Blocks merge? |
| ------------------ | ------------------------------ | ------------- |
| Type check         | `tsc --noEmit`                 | Yes           |
| Lint               | `eslint src/**`                | Yes           |
| Unit tests         | `vitest run --coverage`        | Yes           |
| Coverage threshold | (vitest built-in)              | Yes           |
| Integration tests  | `@vscode/test-electron`        | Yes           |
| Build smoke        | `npm run build`                | Yes           |

All six must be green on all three platforms (Windows, macOS, Linux).
A red on any single platform blocks the PR.

### Before every release (pre-publish checklist in [12-release-and-publish.md](12-release-and-publish.md))

All of the above, plus:

| Check                                    | How                                           |
| ---------------------------------------- | --------------------------------------------- |
| Manual golden-path test on each platform | Install `.vsix` locally; run through Ask / Plan / Execute |
| Terminal safety denylist smoke test      | Trigger each denylist pattern in a dev session; verify banner appears |
| `legacy/llamabridge/` removed (v1.0+)    | `ls legacy/` returns empty or directory gone  |
| `vsce ls` package contents audit         | No secrets, no Python files, no `docs/`       |

### Per tool added to catalog (ongoing discipline)

Every new tool that lands in `src/tools/` must ship with:

1. Unit test for schema validation (valid args pass; invalid args → `ZodError`)
2. Unit test for `ToolRegistry` dispatch (capability gate; permission gate; origin check)
3. Integration test for the confirmation gate (if the tool is write or exec category)
4. Entry in the denylist if the tool can produce destructive shell output

No tool merges without all four. This is enforced via code review, not CI
(CI cannot know a tool is "new" without a custom script).

---

## What we deliberately do not test

| Area                              | Reason                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| Webview CSS / layout              | No stable headless browser in the VS Code test harness; manual review |
| `llama-server` inference quality  | llama.cpp's responsibility; we test our HTTP client, not the server  |
| Streaming latency / throughput    | Hardware-dependent; not reproducible in CI                          |
| Model tool-call reliability       | Inherent LLM variance; covered by per-model system prompts and fallback path, not assertions |
| OS-level process isolation        | We trust `child_process.spawn` with `shell: false`; no need to test Node internals |

---

## Running locally

```bash
# Type check
npx tsc --noEmit

# Lint (+ format check)
npx eslint src/**

# Unit tests with coverage
npx vitest run --coverage

# Integration tests (requires a display on Linux — use Xvfb)
npm run test:integration

# All in one (mirrors CI)
npm run ci
```

`npm run ci` is a convenience script that chains all checks in the same order
as the CI workflow. Run it before pushing any non-trivial change.
