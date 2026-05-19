# Inline Diff Viewer + UI Fixes

**Date:** 2026-05-19  
**Build:** forge-llm 0.10.4 — type-check clean, VSIX packages successfully

---

## 1. Inline Real-Time Diff Viewer

Every file write or delete the agent performs now surfaces a collapsible red/green diff block directly in the sidebar message flow, immediately after the tool executes.

### How It Works

```
Agent calls write_file / replace_in_file / delete_file
        │
        ▼
CheckpointStack.snapshotBefore()   ← already ran (for Undo)
        │
        ▼
Tool handler writes the file
        │
        ▼
ToolDispatch.postFileDiff()
  ├─ reads before-content from checkpoint snapshot
  ├─ reads after-content from disk
  ├─ calls computeDiff(before, after)
  └─ posts FileDiffMsg → webview
        │
        ▼
App reducer FILE_DIFF action
        │
        ▼
Message.tsx DiffBlock component renders hunks
```

### New Files

| File | Purpose |
|------|---------|
| `src/sidebar/DiffUtils.ts` | LCS-based line diff — returns structured `DiffHunk[]`. Skips files > 500 lines (returns `null`). Zero external dependencies. |
| `webview-ui/src/reducer.ts` | Extracted from `App.tsx` (was over 350 LOC limit). Owns `AppMessage`, `Action`, `reducer`, `initialState`. |

### Modified Files

| File | Change |
|------|--------|
| `src/checkpoint/CheckpointStack.ts` | Added `readSnapshotContent(filePath)` — exposes the pending before-snapshot to callers without exposing the full stack. |
| `src/sidebar/messageBridge.ts` | Added `DiffLineKind`, `DiffLine`, `DiffHunk`, and `FileDiffMsg` types. `FileDiffMsg` added to `HostToWebview` union. |
| `src/sidebar/ToolDispatch.ts` | Added `postFileDiff()` — fires after `write_file`, `replace_in_file`, and `delete_file`. Imports `fs` and `DiffUtils`. |
| `webview-ui/src/App.tsx` | Slimmed to component-only (reducer extracted). Handles `fileDiff` → `FILE_DIFF` dispatch. Re-exports `AppMessage` for downstream imports. |
| `webview-ui/src/components/Message.tsx` | Added `DiffBlock` component and `role === 'diff'` render branch. |
| `webview-ui/styles/messages.css` | Added diff block styles — collapsible header, new/modified/deleted badges, green `+` / red `−` line highlighting. |

### DiffBlock UI

- **Header row:** badge (`new` / `modified` / `deleted`) + file path (relative to workspace) + collapse toggle
- **Body:** unified diff hunks with 3 lines of context either side of each change
- **Colors:** green background + `+` gutter for added lines; red background + `−` gutter for removed lines; neutral for context
- **Large files:** falls back to "File too large to diff inline" message (> 500 lines)
- **Collapsed by default:** no — starts open so changes are immediately visible

---

## 2. Token Budget Bar Fix

**Problem:** A previous fix removed the `SYSTEM_AND_TEMPLATE_OVERHEAD` constant and `toolTokens` from `postTokenBudget()`, making `used = 0` on an empty conversation. Because `showBudget = tokenUsed > 0`, the bar became invisible.

**Fix:** Changed the visibility condition in `Header.tsx`:

```tsx
// Before
const showBudget = tokenUsed > 0;

// After
const showBudget = tokenMax > 0;
```

The bar now appears as soon as a model with a known `num_ctx` is configured, showing `0 / 32k` (or similar) on a fresh conversation and filling as tokens accumulate.

---

## 3. Tool Result Tag Stripping

**Problem:** `list_directory` results rendered as `[file] foo.ts [file] bar.ts …` and `git_status` lines showed `[staged]` suffixes in the sidebar preview — noisy for the user, even though the tags are useful for the model.

**Fix:** In `ToolDispatch.postResult`, strip bracket tags from the display-only `preview` string before it is inserted into the markdown blockquote. The raw `result` fed back into `conv.messages` (model context) is unchanged.

```typescript
const preview = truncated
  .replace(/\[(file|dir|staged)\]\s*/g, '')
  .replace(/\r?\n/g, ' ');
```

Tags stripped from UI: `[file]`, `[dir]`, `[staged]`.

---

## Build Artifacts

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` (extension host) | ✓ Clean |
| `npx tsc --noEmit` (webview) | ✓ Clean |
| `npm run package` | ✓ `forge-llm-0.10.4.vsix` (322 KB, 15 files) |
