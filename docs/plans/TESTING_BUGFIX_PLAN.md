# Testing Bugfix Plan

## Scope

Address four issues found during sidebar testing:

1. Keep the context meter and HalluMeter bridge aligned with the live prompt
   after manual or automatic compaction.
2. Keep the sidebar pinned to generated content, including an expanding
   reasoning pane, when the reader has not scrolled away.
3. Show every file-edit diff collapsed initially.
4. Replace the assistant response's text copy action with an icon button.

## Findings

- The meter cached llama.cpp's exact prompt count after a streamed request, but
  that count became stale as soon as the completed assistant response joined
  the next prompt. Repeated turns and compactions could therefore render an
  old request count as current context.
- The outer message list only followed React message-array updates. Expanding
  a reasoning pane changes nested DOM height without changing that array.
- A standalone diff block deliberately opened small diffs by default, unlike a
  multi-file group.

## Implementation

- [x] Invalidate the exact-count cache after a completed loop changes the
  transcript, then publish a current estimate until llama.cpp supplies a count
  for the next prepared request.
- [x] Observe nested message-list mutations and scroll the actual sidebar
  container to its bottom only while it remains pinned.
- [x] Default standalone diffs to collapsed.
- [x] Use an icon-only, labelled copy action consistent with VS Code/Codex
  toolbar controls.
- [x] Add regression tests for the transcript mutation and diff defaults.

## Verification

- [x] Run focused unit and webview tests.
- [x] Run `npm run ci` (771 passed; 8 configured skips).
- [x] Run `npm run package` (created `forge-llm-0.12.46.vsix`).
