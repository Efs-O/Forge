# Wide transcript and activity typography (2026-10-12)

## Status and scope

Reviewed plan; implementation and verification pending. The approved wide and
440 px mockups on the owner's Desktop are visual references, not runtime assets.
This change is confined to webview layout, activity labels and styles, and
expanded reasoning typography. No transcript content, persistence, tool
execution, or scroll-follow logic changes.

The worktree began with an unrelated modification to
`src/backend/ExternalModelServers.ts`. Leave it untouched and unstaged. Commit
only files changed for this plan, explicitly by path.

## Observed causes

- `layout.css` centers every transcript row and caps it at 1040 px;
  `messages.css` caps assistant prose again at 930 px. Those two limits create
  the left and right empty bands when the Forge pane is wide.
- The grouped header puts count, the words “tool call(s),” and live “Working”
  inside one `.activity-group-label`, so its one muted color cannot express
  the owner's requested emphasis. Tool names in compact/full rows and the
  grouped pending line have separate elements already.
- `.activity-group-status.is-live` uses the bright editor warning color,
  whereas the “Heating the room” dot uses `--forge-clanker`.
- `.activity-group-details`, `.thinking-row-toggle`, and `.thinking-content`
  use very small or editor-monospace type. The reasoning content is plain text
  in a `<pre>` and must retain whitespace and line breaks.

## Implementation

1. **Responsive width.** In `layout.css`, stop centering/capping the entire
   transcript. Use modest responsive side padding (about 28 px in a wide pane,
   12 px in a narrow sidebar). Activity cards can use the available pane
   width; assistant prose should start at the same left edge and may retain a
   generous reading cap around 1400–1440 px. User and queued prompt bubbles
   remain right aligned. Keep the existing `content-visibility`, intrinsic
   sizing, first-row auto margin, and scroll-follow behavior. No page-level
   horizontal overflow at 440 px.
2. **Selective color.** Split grouped labels into separate count and words so
   only “tool call(s)” uses `--vscode-foreground`; count, separator, “Working,”
   thinking duration/word, edit metadata, and targets retain the muted theme
   color. In the live “3 calls” phrase, the count stays muted and “calls” uses
   the same emphasized word treatment. Tool names (`shell`, `write_file`,
   etc.) use foreground in compact/full/pending rows; long command/target text
   remains muted. Preserve error, success, retry, and diff colors.
3. **Status hue.** Use `--forge-clanker` for the grouped live dot, matching the
   dot next to “Heating the room.” Do not recolor success/failure marks.
4. **Details and thinking typography.** Keep `Details`/`Hide details` muted but
   use the VS Code UI font at a readable medium weight/size. Render expanded
   reasoning in the UI font, at a readable size and line height, while keeping
   its muted color and `white-space: pre-wrap`. Apply consistently to grouped
   and full views; labels remain compact and muted. Do not parse reasoning as
   Markdown or erase indentation/code-like spacing.
5. **Narrow behavior.** Paragraphs and reasoning wrap without shrinking the
   font. Long command and file targets ellipsize in collapsed headers; the
   `Details` control remains visible at the right. Opening a row preserves
   access to its full content. Check grouped, compact, and full modes at wide
   and sidebar widths, including long names, streaming updates, and light and
   dark theme variables.

## Review findings before delegation

- The prior reply-readability plan intentionally introduced the 1040/930 px
  centered column. This plan supersedes only that width choice; its scroll
  stability and tool-result disclosure behavior remain required.
- The approved narrow mockup initially clipped the final `Details` label.
  The corrected mockup gives variable file summaries the shrinkable slot and
  keeps `Details` fixed; implementation must preserve that outcome.
- `ActivityGroup.tsx` owns grouped summary markup. `ActivityRow.tsx`,
  `ToolRow.tsx`, and `activity-group.css`/`activity-row.css`/`tool-rows.css`
  own the other activity text. `ThinkingGroup.tsx` and `Message.tsx` share
  `.thinking-content`, so a focused style change can cover both rendering
  paths without duplicating state or content transforms.
- The three display modes are `full`, `compact`, and `grouped` in
  `activityRows.ts`. Verification must cover all three, although grouped is
  the screenshot's primary view.

## State × lifecycle ledger

No new durable or in-memory state. Existing activity disclosure choices,
transcript persistence, streaming, and scroll position keep their current
owners and lifecycle. The only markup change separates existing text into
spans for styling; it must not alter accessible button names.

## Verification and handoff

- Inspect wide and 440 px Edge screenshots against the approved references.
  Check that the page does not scroll horizontally, `Details` stays visible,
  prose and reasoning wrap, and user bubbles remain right aligned.
- Add focused coverage for the grouped label's separate spans and accessible
  name, plus a browser-level responsive geometry/color check if the existing
  browser fixture can be extended without fragile pixel assertions.
- Run focused tests, then `npm run ci` and `npm run package` after the last
  code/test/plan edit. On this Windows host, one Vitest worker is the proven
  path around unrelated Git Bash `/tmp` startup contention. Finish with
  `git diff --check`, explicit-file staging, `git status`, and one commit of
  this task's files only. Install the VSIX only after the final package gate;
  verify the installed extension version. The open VS Code window needs
  `Developer: Reload Window` to activate a same-version reinstall.
