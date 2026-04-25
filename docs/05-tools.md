# 05 — Tools

## Tool design rules (hard)

1. **Strict JSON Schema for every tool.** Never a free-form `string` blob arg
   (lesson from `llamabridge/CONTINUE_PATCH_NOTE.md`: Continue's `edit_existing_file`
   with `changes: string` caused Gemma 4 tool-call failures).
2. **Atomic operations only.** A tool either succeeds and returns a result or
   fails and leaves no partial state.
3. **Read-only tools first.** Write/exec tools land only after per-turn
   checkpoints + Keep/Undo decorations exist.
4. **Capability + permission gated.** Every tool declares
   `requiredCapabilities` and `requiredPermissions`; runtime drops or
   confirms accordingly.
5. **Native function-call when supported, structured-output fallback otherwise.**
   Both paths defined per tool.

## Tool registry shape

```ts
interface Tool {
  name: string;                        // canonical, snake_case
  description: string;                 // sent to model
  parameters: JSONSchema;              // strict, no free-form strings
  requiredCapabilities: Capability[];
  requiredPermissions: Permission[];
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

Every tool registers via `ToolRegistry.register(tool)` at activation.

## v0.5 — implementation set (16 tools)

All read-only or non-destructive, all on free VS Code APIs, no risky deps.

### Filesystem (read)
| Tool             | API source                                    | Permission |
| ---------------- | --------------------------------------------- | ---------- |
| `read_file`      | `workspace.fs.readFile`                       | fs:read    |
| `list_directory` | `workspace.fs.readDirectory`                  | fs:read    |
| `search_code`    | `workspace.findFiles` + bundled `rg`          | fs:read    |

### LSP (code intelligence)
| Tool                    | API source                                                        | Permission |
| ----------------------- | ----------------------------------------------------------------- | ---------- |
| `get_diagnostics`       | `languages.getDiagnostics`                                        | fs:read    |
| `get_document_symbols`  | `executeCommand('vscode.executeDocumentSymbolProvider')`          | fs:read    |
| `get_workspace_symbols` | `executeCommand('vscode.executeWorkspaceSymbolProvider')`         | fs:read    |
| `get_hover`             | `executeCommand('vscode.executeHoverProvider')`                   | fs:read    |
| `go_to_definition`      | `executeCommand('vscode.executeDefinitionProvider')`              | fs:read    |
| `find_references`       | `executeCommand('vscode.executeReferenceProvider')`               | fs:read    |

### Editor / VS Code UX
| Tool                  | API source                                                | Permission |
| --------------------- | --------------------------------------------------------- | ---------- |
| `show_diff`           | `executeCommand('vscode.diff', uri1, uri2, title)`        | —          |
| `ask_user`            | `window.showQuickPick` / `showInputBox`                   | —          |
| `show_notification`   | `window.showInformationMessage` / Warning / Error          | —          |
| `copy_to_clipboard`   | `env.clipboard.writeText`                                 | —          |
| `read_clipboard`      | `env.clipboard.readText`                                  | —          |
| `open_url_in_browser` | `env.openExternal(uri)`                                   | net:http   |

### Network (search/fetch)
| Tool         | Backing                                        | Permission |
| ------------ | ---------------------------------------------- | ---------- |
| `web_search` | Tavily (default) / Brave (alt)                 | net:search |
| `web_fetch`  | `fetch` + `@mozilla/readability` + `turndown`  | net:fetch  |

### Memory / state
| Tool              | API source                            | Permission |
| ----------------- | ------------------------------------- | ---------- |
| `remember`        | `context.workspaceState.update`       | —          |
| `recall`          | `context.workspaceState.get`          | —          |
| `list_memories`   | `context.workspaceState.keys`         | —          |

(`remember`/`recall`/`list_memories` count as 3 tools in the catalog above —
total v0.5 set is 16.)

---

## v0.6 — Write tools + checkpoints

| Tool                  | API source                                          | Permission | Notes                       |
| --------------------- | --------------------------------------------------- | ---------- | --------------------------- |
| `write_file`          | `WorkspaceEdit`                                     | fs:write   | Checkpointed                |
| `create_directory`    | `workspace.fs.createDirectory`                      | fs:write   |                             |
| `move_file`           | `workspace.fs.rename`                               | fs:write   |                             |
| `delete_file`         | `workspace.fs.delete`                               | fs:delete  | Checkpointed; default-deny  |
| `replace_selection`   | `editor.edit(eb => eb.replace(...))`                | fs:write   | Checkpointed                |
| `insert_at_cursor`    | `editor.edit(eb => eb.insert(...))`                 | fs:write   |                             |
| `replace_in_file`     | Strict `old_str` / `new_str` exact match            | fs:write   | Checkpointed                |
| `format_file`         | `executeCommand('editor.action.formatDocument')`    | fs:write   |                             |
| `rename_symbol`       | LSP `executeDocumentRenameProvider` → apply edit    | fs:write   | Project-wide, safe          |
| `insert_image`        | `WorkspaceEdit` + `fs.copyFile`                     | fs:write   |                             |
| `download_file`       | `fetch` + `fs.writeFile`                            | net:http   | Size cap, allowlist         |

`replace_in_file` parameter shape (the strict-schema example):

```jsonc
{
  "type": "object",
  "required": ["filepath", "old_str", "new_str"],
  "properties": {
    "filepath": { "type": "string" },
    "old_str":  { "type": "string", "description": "Exact match including whitespace" },
    "new_str":  { "type": "string" }
  },
  "additionalProperties": false
}
```

No `changes: string`, no `description: string`, no free-form fields.

---

## v0.7 — Execution + git

### Execution
| Tool             | API source                                | Permission     |
| ---------------- | ----------------------------------------- | -------------- |
| `run_terminal`   | `window.createTerminal`                   | exec:terminal  |
| `exec_command`   | `child_process.spawn` (captures stdout)   | exec:headless  |
| `run_tests`      | Testing API if present, else shell+parse  | exec:headless  |
| `run_build`      | Shell + parse                             | exec:headless  |

`run_terminal` is **user-visible interactive**. `exec_command` is **headless
output capture**. Different tools, different use cases. Both gated by
allowlist + per-call confirmation by default.

### Git (via `vscode.git` extension API)
| Tool                | Permission |
| ------------------- | ---------- |
| `git_status`        | git:read   |
| `git_log`           | git:read   |
| `git_diff`          | git:read   |
| `git_blame`         | git:read   |
| `git_show`          | git:read   |
| `create_branch`     | git:write  |
| `switch_branch`     | git:write  |
| `stage`             | git:write  |
| `commit`            | git:write  |

---

## v1.0 — Vision + heavy

| Tool              | Backing                                            | Permission     | Notes                        |
| ----------------- | -------------------------------------------------- | -------------- | ---------------------------- |
| `analyze_image`   | Multimodal model API call                          | fs:read        | Capability-gated `vision`    |
| `read_pdf`        | `pdf-parse`                                        | fs:read        |                              |
| `http_request`    | `fetch`                                            | net:http       | Allowlist + per-call confirm |
| `read_notebook`   | `workspace.openNotebookDocument`                   | fs:read        |                              |
| `run_notebook_cell`| `executeCommand('notebook.cell.execute')`        | exec:headless  |                              |

---

## Post-v1.0

| Tool              | Reason deferred                                |
| ----------------- | ---------------------------------------------- |
| `read_screenshot` | No stable VS Code API; needs native module     |
| `ocr_image`       | Multimodal models OCR fine; redundant most cases |
| `apply_patch`     | Diff parsing + fuzzy hunk apply is its own subsystem |
| `browser_automate`| Playwright; separate stack                     |
| `debug_session`   | DAP integration                                |

---

## Tool-call paths

### Native function-call (Qwen3, Gemma 4 — when working)

```
Forge sends:    body.tools = [{ type: 'function', function: { name, parameters } }, ...]
Model emits:    body.choices[0].message.tool_calls = [{ id, type, function: { name, arguments } }]
Forge parses:   JSON.parse(arguments) → strict-schema validation → ToolRegistry.dispatch
```

### Structured-output fallback (when native fails)

```
Forge sends:    System prompt explicitly asks for JSON-fenced tool calls
Model emits:    Free-form response containing fenced ```json blocks
Forge parses:   Extract fenced JSON → strict-schema validation → ToolRegistry.dispatch
                                                ↓
                                    Validation fail → re-prompt with schema reminder
```

`StripTools.ts` (TS port of bridge `_strip_openai_tools_from_chat_payload`) is
the safety valve: when a model returns 500 errors on tool JSON or starts
emitting malformed calls repeatedly, fall back to no-tool mode and surface a
notification to the user.

---

## Capability + permission interaction

A tool runs only if **all three** conditions hold:

1. Active model declares the required capabilities (e.g. `tool-call`, `vision`).
2. `config.yaml` `permissions:` block grants the required permissions.
3. Confirmation policy (per-call or session-allow) is satisfied.

If any fails:
- Capability fail → tool not registered for this session (model never sees it).
- Permission fail → tool registered but `dispatch` returns "permission denied" to model.
- Confirmation fail (user denied) → tool returns "user declined" to model.

The model sees only tools it can use; the user sees only confirmations for
tools the model can actually call.

---

## What this catalog does not include

- **No `apply_patch`** in v0.5 / v0.6 / v0.7 — strict `replace_in_file` is
  preferred until we ship a robust diff parser (post-v1.0).
- **No tool with `description: string` or `changes: string`** — strict
  schemas only, always.
- **No tools that bypass capability/permission gates** — including any "admin"
  or "raw" tools. The gating is uniform.
