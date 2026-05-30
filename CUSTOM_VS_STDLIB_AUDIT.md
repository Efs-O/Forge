# Custom Implementations Audit

Scanned: `src/` and `webview-ui/src/`
Method: compare hand-rolled logic against VS Code APIs, Node stdlib, and existing project owners.

This report reflects the fixes that were implemented for the highest-value audit items.

---

## Implemented Fixes

### 1. `ForgeInstructionsLoader` watcher and truncation warning
**Owner:** `src/llm/ForgeInstructionsLoader.ts`
**Status:** Fixed

Changes shipped:
- Replaced `fs.watch()` with `vscode.workspace.createFileSystemWatcher()`.
- Added a 150 ms debounce so rapid saves trigger a single reload.
- Subscribed to create, change, and delete events for `FORGE.md`.
- Kept the 8 KB guard, but it is no longer silent: Forge now warns once when truncation happens.
- Disposes the watcher and any pending debounce timer cleanly.

Why this fix:
- `createFileSystemWatcher()` matches the config watcher pattern already used elsewhere in the extension.
- Users now get explicit feedback when `FORGE.md` is larger than the injected limit.

---

### 2. GGUF scan caps removed
**Owner:** `src/backend/GgufScanner.ts`
**Status:** Fixed

Changes shipped:
- Removed the silent depth cap.
- Removed the silent result cap from scanning.
- Replaced recursive traversal with an iterative directory walk.
- Added a visited-directory set so the scanner avoids rescanning the same real path.
- Preserved external directory scanning behavior, including non-workspace paths and mounted drives.

Why this fix:
- The previous implementation silently returned incomplete results for deeper model folders or larger model collections.
- `workspace.findFiles()` was not used because this scanner intentionally searches outside the workspace.

---

### 3. `search_code` now uses ripgrep
**Owner:** `src/tools/dirTools.ts`
**Status:** Fixed

Changes shipped:
- Replaced manual `findFiles` + `readFile` + line scanning with a structured `rg --json` search.
- Kept the existing tool contract: literal query string, include glob, and `max_results`.
- Preserved ignored-path behavior for `.git`, `node_modules`, `dist`, and `out`.
- Returns grouped match previews per file instead of loading whole files into memory.
- Stops the ripgrep process once enough matching files have been collected.

Why this fix:
- The old implementation scaled poorly because it read each candidate file in full and scanned it line-by-line in extension code.
- `rg` is a better fit for this codebase because the current VS Code API type surface here does not expose `findTextInFiles()`.

---

## Remaining Audit Items

Not addressed in this change set:
- `HealthCheck.ts` startup polling backoff
- Token estimation accuracy in `SidebarProvider.ts`
- Parser dedup between `OpenAIClient.ts` and `OllamaNativeClient.ts`
- Adopted-server monitor consolidation in `DirectBackend.ts`

Those are still valid follow-up candidates, but they need more design care than the three fixes above.
