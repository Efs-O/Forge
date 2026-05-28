# Custom Implementations vs. Ready-Made Solutions — Audit

Scanned: `src/` + `webview-ui/src/`
Method: same as the diff fix — compare hand-rolled logic against Node stdlib,
VS Code API, or git CLI equivalents.

The diff/LCS fix is already shipped; it is listed first as the reference
pattern. Everything else is unresolved.

---

## Already Fixed

### ~~LCS diff algorithm~~ → `git diff --no-index`
`src/sidebar/DiffUtils.ts` — O(m×n) table, 500-line hard cap.
Replaced with `gitDiffLarge` + `parseUnifiedDiff`. **Done.**

---

## Open Findings

### 1. `fs.watch()` instead of VS Code file watcher — MEDIUM
**File:** `src/llm/ForgeInstructionsLoader.ts:35–43`

```ts
this.watcher = fs.watch(path.dirname(this.filePath), (_, filename) => {
  if (filename === FORGE_MD) this.load();
});
```

**Problem:** `fs.watch()` is unreliable on Windows network drives and some
Linux setups. No debounce — multiple rapid saves trigger multiple reloads. Not
tied to extension disposal lifecycle.

**Fix:** `vscode.workspace.createFileSystemWatcher()` — already used in
`ConfigLoader.ts`. Same 3-line pattern, platform-safe, auto-disposes.

**Should we refactor?** Yes — same API already used one file over.
Risk: LOW.

---

### 2. Health-check polling — no backoff — MEDIUM
**File:** `src/backend/HealthCheck.ts:27–81`

Fixed 1 000 ms `setInterval` hammers the backend on startup. Manual `settled`
flag and `clearInterval` cleanup is error-prone.

**Fix:** Exponential backoff with `AbortSignal.timeout()` (Node 17+, available
in the VS Code extension host). Pattern already partially used in
`probeHealthy()` on line 6 of the same file — just extend it.

**Should we refactor?** Yes, but carefully — it's on the startup hot path.
Risk: MEDIUM.

---

### 3. Token estimator: chars ÷ 4 — MEDIUM
**File:** `src/sidebar/SidebarProvider.ts:47–62`

```ts
return sum + Math.ceil(chars / 4);
```

Off by 30–50 % for real prompts (especially code). Causes the context-budget
display to be misleading.

**Fix:** `js-tiktoken` (MIT, 200 KB WASM, zero native deps) for cl100k/o200k
models, or the simple lookup table from `@anthropic-ai/tokenizer` if we only
target Claude. Neither adds a large footprint.

**Should we refactor?** Worth a spike — wrong estimates make the progress bar
unreliable. Risk: LOW (isolated utility function).

---

### 4. Manual NDJSON parser (Ollama streaming) — LOW
**File:** `src/llm/OllamaNativeClient.ts:172–293`

Hand-rolled line-splitting + JSON.parse loop. Correct, but reinvents a common
pattern. No upper bound on the tool-call accumulator.

**Fix:** Extract into a small `NdjsonParser` class (no new dep needed — the
pattern is a `Transform` stream from Node stdlib). Alternatively the current
code is fine as-is given the test coverage.

**Should we refactor?** Low urgency — code is correct. Worth extracting to a
shared util if/when `OpenAIClient.ts` does the same (see #5).
Risk: LOW.

---

### 5. Manual SSE parser (OpenAI-compat streaming) — LOW
**File:** `src/llm/OpenAIClient.ts:96–180`

Same pattern as #4 but for `data:` prefixed SSE lines. Duplicate of the
buffering/splitting logic in `OllamaNativeClient.ts`.

**Fix:** A shared `SseParser` + `NdjsonParser` util extracted from both clients
eliminates the duplication. No new npm dep required.

**Should we refactor?** Yes — the two parsers should be one. Deduplication
reduces future drift. Risk: LOW.

---

### 6. Directory walk with hard depth/result caps — LOW
**File:** `src/backend/GgufScanner.ts:12–13, 30–68, 96–119`

```ts
const MAX_DEPTH   = 5;
const MAX_RESULTS = 50;
```

Users with GGUF files deeper than 5 levels or more than 50 models see a
silently incomplete list. Hand-rolled recursion reinvents `glob`.

**Fix:** `fast-glob` (already a common VS Code extension dep) or VS Code's
`workspace.findFiles('**/*.gguf')`. Both respect the workspace FS abstraction
and handle symlinks correctly.

**Should we refactor?** Yes — the caps are a real UX bug for power users.
Risk: LOW (isolated scanner).

---

### 7. Manual grep in `search_code` tool — LOW
**File:** `src/tools/dirTools.ts:78–135`

Reads every candidate file into memory, splits on `\n`, linear scans for the
query. 50-line hard cap on results.

**Fix:** `vscode.workspace.findTextInFiles()` — indexed, cancellable, handles
binary files, no manual file I/O. Or shell out to `rg` (ripgrep) if already on
PATH, same as how Claude Code handles it.

**Should we refactor?** Yes — the manual approach doesn't scale to large repos
and the 50-line cap silently drops results. Risk: LOW.

---

### 8. Adopted server monitor — mixed concerns — LOW
**File:** `src/backend/DirectBackend.ts:168–196`

Fixed 5 000 ms `setInterval` for an adopted llama-server, with output
formatting mixed into the polling callback. Silent `catch` swallows errors.

**Fix:** Consolidate into `HealthCheck.ts` (existing owner of health polling).
Surface errors instead of swallowing them.

**Should we refactor?** Low urgency — adopted-server path is rarely used.
Risk: LOW.

---

### 9. FORGE.md silent truncation at 8 KB — LOW
**File:** `src/llm/ForgeInstructionsLoader.ts:29`

```ts
this.content = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
```

Silently truncates mid-instruction. User has no idea their FORGE.md is being cut.

**Fix:** Either warn the user ("FORGE.md exceeds 8 KB — instructions truncated")
or remove the cap and let the model context window be the real limit.

**Should we refactor?** Yes — surface the truncation as a warning at minimum.
Risk: LOW.

---

## Priority Order

| # | Finding | File | Risk | Action |
|---|---------|------|------|--------|
| 1 | `fs.watch()` → `createFileSystemWatcher` | ForgeInstructionsLoader.ts | LOW | **Do it** — same API already next door |
| 2 | GgufScanner depth/result caps | GgufScanner.ts | LOW | **Do it** — real UX bug |
| 3 | `search_code` manual grep | dirTools.ts | LOW | **Do it** — use `findTextInFiles` |
| 4 | SSE + NDJSON parser dedup | OpenAIClient / OllamaNativeClient | LOW | **Do it** — dedup before they drift more |
| 5 | FORGE.md silent truncation | ForgeInstructionsLoader.ts | LOW | **Warn** — one-liner |
| 6 | Token estimator accuracy | SidebarProvider.ts | LOW | **Spike** — evaluate js-tiktoken size |
| 7 | Health-check backoff | HealthCheck.ts | MEDIUM | **Plan carefully** — hot path |
| 8 | Adopted server monitor | DirectBackend.ts | LOW | Low urgency — consolidate later |

Items 1–5 are surgical, low-risk, and can be batched in a single PR.
Items 6–8 need more thought before touching.
