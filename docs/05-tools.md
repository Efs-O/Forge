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

---

### Terminal safety architecture (hard rules)

This is the highest-risk tool surface in Forge. The following rules are
non-negotiable and must all be in place before `run_terminal` or `exec_command`
ship.

#### 1. Show-before-execute — always

The user sees the **exact, fully-resolved command string** in a confirmation
dialog before any execution. No exceptions. The dialog shows:

- The command and every argument, rendered verbatim
- The working directory it will run in
- A **denylist warning banner** if any blocked pattern matches (see §3)
- `[Run]` / `[Cancel]` — no auto-accept, no session-level bypass for exec tools

The model is told: "Forge will show the user the command before running it."
This is included in the system prompt for Execute mode.

#### 2. No shell interpretation — ever (`exec_command`)

`exec_command` uses `child_process.spawn` with an **argument array** and
`shell: false`. Never a shell string, never `shell: true`:

```ts
// CORRECT
spawn('git', ['reset', '--hard', 'HEAD'], { shell: false, cwd: workspaceRoot })

// NEVER
spawn('git reset --hard HEAD', { shell: true })
```

The tool schema requires `command: string` (the executable) and
`args: string[]` (separate array). A single `commandLine: string` field is
explicitly banned — splitting on spaces is lossy and injection-prone.

**Windows built-in commands (`dir`, `echo`, `copy`, `type`) are not
executables** — they only exist inside `cmd.exe`. On Windows the model must
pass the shell explicitly:

```ts
spawn('cmd.exe',        ['/c', 'dir', '/b'],   { shell: false })
spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'script.ps1'], { shell: false })
```

`-Command <string>` and `-EncodedCommand <base64>` are **banned** as
PowerShell args — both accept a shell string that PowerShell evaluates,
reintroducing injection risk. The implementation checks for these flags and
returns `ToolError` if found. Models that need PowerShell must use `-File`
with a `.ps1` file, or use discrete `-Command` only with a single safe
literal verb (validated against allowlist).

#### 2b. `run_terminal` — shell-string risk

`window.createTerminal` opens the user's **default interactive shell** (bash/zsh
on macOS/Linux, PowerShell or cmd on Windows). There is no arg array here —
any text the model sends to the terminal is a string the shell interprets.

This means `run_terminal` **cannot rely on shell-operator blocking or
the arg-array model**. Its only defences are:

- Show-before-execute (§1) — the user sees the full string before it is sent
- Denylist pattern match on the string (§3)
- No auto-send: the command is pasted into the terminal but **not submitted**
  (i.e. `sendText(cmd, false)`) — the user must press Enter themselves

The last point is critical: `sendText(text, true)` submits immediately.
Forge **always** uses `sendText(text, false)`. The user retains final control.

#### 3. Denylist — platform-aware, hard block with override

A static denylist is checked against the full command string **before** showing
the confirmation dialog. A match:

- Shows a **red warning banner** in the confirmation dialog
- Requires the user to type a confirmation phrase (e.g. `"i understand"`)
  rather than just clicking `[Run]`
- Is always logged to the output channel regardless of outcome

**Unix/cross-platform patterns:**
```
rm\s+-[rR][fF]?\s+[/~]        # rm -rf / or ~/
git\s+reset\s+--hard           # git reset --hard
git\s+clean\s+-[fFdDxX]        # git clean -f / -fd / -fx
git\s+push\s+--force           # force push
DROP\s+(TABLE|DATABASE|SCHEMA) # SQL DROP
shutdown|reboot|halt|poweroff  # system power (cross-platform)
mkfs\.|fdisk\s                  # disk format (Linux)
curl\s+.*\|\s*(ba)?sh           # curl | sh / bash
wget\s+.*-O\s*-.*\|            # wget pipe
```

**Windows-specific patterns:**
```
del\s+/[fFsS]                         # del /f /s
rd\s+/[sS]                            # rd /s
rmdir\s+/[sS]                         # rmdir /s
format\s+[a-zA-Z]:                    # format C:
Remove-Item.*-Recurse.*-Force         # PowerShell rm -rf equivalent
ri\s+.*-r.*-fo                        # ri alias shorthand
Format-Volume                          # PowerShell disk format
Stop-Computer|Restart-Computer        # PowerShell power commands
Invoke-Expression|iex\s               # PowerShell eval — curl|sh equivalent
-EncodedCommand|-enc\s                # PowerShell base64 eval
diskpart\s                             # Windows disk partition tool
cipher\s+/w                           # Windows secure wipe
```

The denylist is extensible via `config.yaml`:

```yaml
exec:
  denylist_extra:
    - "my-destroy-script"
  denylist_override: []    # set to disable specific built-in patterns
```

#### 4. Shell operator blocking (`exec_command` only)

The `args` array is scanned before execution. If any element contains:
`&&`, `||`, `;`, `|`, `` ` ``, `$(`, `>`, `>>`, `<`

...the tool returns an error to the model:

```
ToolError: Shell operators are not permitted in arguments.
Split into separate tool calls.
```

This does not apply to `run_terminal` (which is already a shell — the user
types freely). It applies only to `exec_command`'s arg array.

#### 5. Workspace-root scope

`exec_command` always runs with `cwd` set to the workspace root unless
`config.yaml` explicitly grants `exec.allow_arbitrary_cwd: true`.

`run_terminal` opens in the workspace root. The user can `cd` freely —
that is their session to control.

#### 6. Timeout + kill

`exec_command` has a hard timeout (default 30s, configurable via
`exec.timeout_ms`). On timeout: `SIGTERM`, then `SIGKILL` after 5s.
On Windows, `SIGTERM` is not supported — use `process.kill(pid)` directly.
The user is notified. No zombie processes.

`run_terminal` has no timeout — the user owns the interactive session.

#### 7. Untrusted-content origin block

Commands discovered inside `<UNTRUSTED_CONTENT>` delimiters (fetched web
pages, search results) are **never dispatched**, even if the model wraps them
in a tool call. The `ToolRegistry.dispatch` origin check applies to all
exec-category tools with zero exceptions.

This is the primary defence against prompt-injection → RCE.

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
