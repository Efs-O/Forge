# Forge — Future Improvements

Items agreed on but not yet scheduled. Add here during review sessions, pick from here when planning the next version.

---

## UX

- **Type-while-streaming**: allow typing in the prompt box while the agent is running, but keep the Submit button disabled. Users can compose their next message while waiting instead of staring at a locked input. UI-only change — disable textarea submit, not the textarea itself.

---

## Agent / FORGE.md

- **FORGE.md hierarchy**: support multi-level FORGE.md files (workspace root → subdirectory), same pattern as Claude Code's CLAUDE.md. Useful in monorepos where sub-packages have different stacks.
- **`/initForge` model quality**: for models that still output tool-call JSON instead of raw markdown, consider a retry pass or a stricter extraction fallback.

---

## Tooling

- **`/initForge` for non-JS projects**: currently scans `package.json` and `src/`. Add detection for Python (`pyproject.toml`, `requirements.txt`), Rust (`Cargo.toml`), and Go (`go.mod`) to produce better Stack and Key Files sections.

---

## Performance

- **Parallel tool execution**: `ToolDispatch.dispatch()` runs tool calls sequentially. If the model requests 3 file reads, they execute one-by-one. Switch to `Promise.all` for independent tool calls — would be noticeably faster especially on multi-file operations. (Flagged by 27B model review)

---

## Reliability / Edge Cases

- **CheckpointStack: disk-based snapshots**: current implementation holds full file content in RAM as JS strings. Fine for source files, but risky for large generated files or binaries. Future version should write snapshots to a temp directory on disk instead. (Flagged by 27B model review)
- **`format_file` brittleness**: currently calls `editor.action.formatDocument` on the active editor — unreliable if another tab is focused or formatting fails silently. Replace with `vscode.languages.getDocumentFormattingEdits()` for direct, tab-independent formatting. (Flagged by 27B model review)
- **`git_*` tools: VS Code Git extension dependency**: if the user doesn't have the VS Code Git extension installed, all git tools throw unhelpfully. Add a fallback to `child_process.spawnSync('git', ...)` or at minimum surface a clear error message pointing to the dependency. (Flagged by 27B model review)
- **`run_build` / `run_tests`: npm hardcoded**: detect `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` and use the correct package manager runner instead of always calling npm. (Flagged by 27B model review)
- **`htmlToText` in `web_fetch`**: naive regex stripping misses HTML entities (`&nbsp;`, `&amp;`), `<br>` spacing, and `<p>` gaps. Results in garbled text on some pages. Replace with a proper HTML-to-text pass. (Flagged by 27B model review)
