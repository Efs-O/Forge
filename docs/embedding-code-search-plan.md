# Embedding Code Search Plan

**Status:** Proposed for review  
**Goal:** Add an optional local embedding index and `search_codebase` tool that improves semantic code retrieval without weakening Forge's local-only, low-dependency design.

---

## Recommendation

Ship this as a narrow v1:

- Optional feature behind explicit config
- Dedicated embedding backend instance
- Brute-force local vector index, no native addon dependency
- Manual indexing first, with dirty tracking instead of automatic reindex-on-save
- `search_codebase` as a focused retrieval tool, not a general repo browsing layer

This keeps complexity inside a bounded subsystem and avoids coupling semantic search to the main chat path too early.

---

## Why This Fits Forge

- `embeddinggemma-300m` is small enough for local CPU usage and aligns with Forge's local-first constraints.
- `llama.cpp` already supports OpenAI-compatible embeddings, so Forge can stay inside its existing backend strategy.
- Semantic retrieval complements the existing `search_code` tool rather than replacing it.

---

## Non-Goals For V1

- No native vector database dependency such as `sqlite-vec`
- No silent background full reindex on every save
- No replacement of exact lexical search
- No cloud embeddings or outbound indexing services
- No automatic indexing unless the user explicitly enables it

---

## Proposed User Experience

### Config

Add an opt-in embedding section to `config.yaml`:

```yaml
embeddings:
  enabled: true
  model_path: "N:/models/embeddinggemma-300m-Q4_0.gguf"
  port: 8091
  auto_index_on_search: true
  max_file_size_kb: 256
  include_globs:
    - "src/**"
    - "test/**"
  exclude_globs:
    - "**/node_modules/**"
    - "**/dist/**"
    - "**/.git/**"
```

### Commands

- `/reindex` rebuilds the workspace embedding index
- Optional future command: `Forge: Rebuild Semantic Index`

### Tool

Add `search_codebase` to the tool catalog with a strict schema:

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": { "type": "string" },
    "top_k": { "type": "integer", "minimum": 1, "maximum": 20 },
    "scope_glob": { "type": "string" }
  },
  "additionalProperties": false
}
```

Return shape should stay narrow:

- `path`
- `startLine`
- `endLine`
- `score`
- `snippet`
- optional `symbolName`

---

## Architecture

### Single Point Of Truth

These proposed owners keep the feature isolated:

| Concern | Owner |
| ------- | ----- |
| Embedding config schema | `src/config/schema.ts` |
| Embedding backend lifecycle | `src/backend/EmbeddingBackend.ts` |
| Workspace chunking + index persistence | `src/search/IndexManager.ts` |
| Embedding generation client | `src/search/EmbeddingClient.ts` |
| Semantic retrieval tool registration | `src/tools/ToolRegistry.ts` |

### Backend shape

Do not fold embeddings into `DirectBackend.ts`.

`DirectBackend.ts` owns the main generation server lifecycle already. A second dedicated backend is cleaner because:

- generation and embeddings may use different models
- readiness and error handling differ
- startup failures should surface independently
- the feature is optional and should be removable without disturbing main chat behavior

`EmbeddingBackend.ts` should:

- spawn `llama-server` with the embedding model
- expose a stable embeddings base URL
- own start/stop/readiness/error reporting
- reuse existing config and output-channel patterns where practical

### Index storage

Use a simple workspace-local index under `.forge/`:

- `.forge/embeddings.index.json` for metadata
- `.forge/embeddings.vectors.bin` for raw float storage, or a single JSON file if simpler for v1

The key requirement is no native module dependency. Brute-force cosine similarity is acceptable for early repo sizes and keeps packaging straightforward.

### Chunking strategy

Do not start with arbitrary fixed-width chunks only.

Preferred order:

1. function/class/symbol chunk when document symbols are available
2. fallback to bounded line-range chunks
3. small overlap only where needed

Each chunk record should include:

- file path
- content hash
- language id
- line range
- optional symbol name
- embedding vector

---

## Retrieval Strategy

Pure embeddings will miss exact identifiers and file-name intent. V1 should stay compatible with a hybrid future.

Recommended path:

1. Keep existing `search_code` for exact text and glob search
2. Add `search_codebase` for semantic retrieval
3. Optionally blend lexical signals later if result quality is weak

Do not rename or redefine `search_code` in the same change. That would make behavior harder to reason about.

---

## Index Lifecycle

Avoid eager background work in v1.

### Initial build

- Build on explicit `/reindex`
- If `auto_index_on_search: true`, build lazily the first time `search_codebase` is called and no valid index exists

### File changes

On save:

- mark the file dirty
- do not immediately recompute embeddings unless the user explicitly opts into that behavior later

On search:

- if dirty files exist, refresh only those files before running retrieval

This preserves responsiveness and reduces hidden work in large repos.

---

## File Changes

### `src/config/schema.ts`

Add a new optional `embeddings` block with strict validation. Invalid or missing `model_path` should produce a clear user-facing setup error.

### `config/config.example.yaml`

Document the feature as optional and disabled by default.

### `src/backend/EmbeddingBackend.ts`

New module for the embedding server lifecycle. Keep all spawn logic here so the main `DirectBackend` owner does not become a generic process bucket.

### `src/search/EmbeddingClient.ts`

Small OpenAI-compatible client for `/v1/embeddings`. Keep it isolated from chat-completions streaming behavior.

### `src/search/IndexManager.ts`

Responsibilities:

- enumerate files using include/exclude globs
- chunk files
- compute content hashes
- persist/load index state
- refresh dirty files
- perform cosine similarity search

### `src/tools/ToolRegistry.ts`

Register `search_codebase` only when:

- embeddings are enabled
- index manager is available
- model capabilities and permissions allow it

### `src/sidebar/SidebarProvider.ts`

Likely touch point only for:

- `/reindex` command routing
- surface indexing errors/status to the UI if needed

Keep semantic search orchestration out of sidebar logic as much as possible.

---

## Permissions And Tooling

`search_codebase` should remain read-only and use existing `fs:read` permission semantics unless the project introduces a distinct local-index permission. The index writer itself is Forge-owned internal state under `.forge/`, not an agent write tool.

If a new permission is added later, make it explicit rather than silently broadening `fs:read`.

---

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Native dependency pain in VS Code host | Do not use `sqlite-vec` in v1 |
| Slow indexing on large repos | Cap file size, respect globs, refresh only dirty files |
| Poor retrieval quality for exact symbol queries | Keep `search_code` and consider hybrid ranking later |
| Backend lifecycle sprawl | Isolate embeddings in `EmbeddingBackend.ts` |
| Hidden background CPU usage | Manual build first, lazy refresh only when needed |
| Stale search results | Track content hashes and dirty files explicitly |

---

## Implementation Order

1. Add `embeddings` config schema and example config
2. Implement `EmbeddingBackend.ts`
3. Implement `EmbeddingClient.ts`
4. Implement `IndexManager.ts` with brute-force cosine search
5. Register `search_codebase` in `ToolRegistry.ts`
6. Add `/reindex` command plumbing
7. Run quality gates and manual retrieval validation

---

## Acceptance Criteria

- Forge works unchanged when `embeddings.enabled` is absent or `false`
- Missing or invalid embedding model configuration produces a clear setup error
- `/reindex` builds an index for the configured workspace scope
- `search_codebase` returns relevant file snippets with line ranges and scores
- Dirty files are refreshed before semantic search results are returned
- No native addon dependency is introduced
- `npx tsc --noEmit` passes
- `npx vitest run` passes
- `npm run package` passes

---

## Recommended Follow-Up Phase

Only after v1 is working and reviewed:

1. add optional hybrid lexical + semantic ranking
2. add smarter symbol-aware chunking per language
3. evaluate a denser on-disk format if brute-force search becomes a bottleneck
4. consider optional continuous indexing behind an explicit config flag

This should be treated as a retrieval subsystem, not a broad architecture rewrite.
