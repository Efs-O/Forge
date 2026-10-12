# Reply readability and transcript scroll stability (2026-10-12)

## Status and scope

Implemented. Targeted checks, Edge layout QA, full CI, and packaging passed.
The supervising owner completes the commit and local VSIX installation.
Reference images are `artifacts/activity-view-mockups/reply-readability-1808.png`
and `reply-readability-440.png`. This change affects Forge's webview transcript
and the instructions Forge gives its own agents. It does not rewrite stored
messages, change delivery/order, or add a new display mode.
The owner also included a shell-result regression: long live command output
must stay closed unless the reader opens it, while errors, approvals, and short
nested outputs remain visible.

## Baseline and cause

- The screenshot shows a wide assistant reply with dense paragraphs, long
  bullets, and many inline code chips. `.msg.assistant` has no reading-width
  limit. The `execute.njk` native prompt already asks for a short final answer,
  and `CliChatRunner.ts` asks CLI agents for a concise final response, but
  neither specifies answer-first structure or one point per bullet. Existing
  user/project instructions must keep priority; no forced truncation.
- `MessageList.tsx` follows the end using `userScrolledUp`. Its `scroll` event
  calls `nextScrolledUp`, which interprets any upward `scrollTop` movement away
  from the bottom as reader intent. Chromium can produce that movement when
  a transcript row changes height or its `content-visibility: auto` estimate
  resolves. Once latched, token, mutation, load, and resize handlers stop
  pinning the end. The screenshot alone does not prove one exact trigger.
- A newly shown long pane uses `settleToBottom`, which stops when one frame
  reports a bottom distance under 1 px, or after 30 frames. Later intrinsic
  height corrections can leave the viewport above the true end. Hidden panes
  restore a saved pixel offset when the reader had intentionally scrolled up.
- Nested `ToolRow` instances treated the activity-step disclosure as an
  instruction to expand each long tool body (`open = choice ?? nested`), and
  `ToolGroup` passed `defaultOpen={nested}` to its rows. Opening a step that
  contained a running or completed shell call therefore expanded its long
  command/result. Short nested results depended on this same default to remain
  visible, so the fix must separate those behaviors.

## Implementation

1. **Reading column.** In `webview-ui/styles/layout.css` and `messages.css`,
   center transcript rows in a responsive max-width column of about 1040 px
   in wide panes, while keeping the assistant's prose around 930 px. Narrow
   sidebars use their available width. Keep user and queued bubbles aligned
   right within the column; keep grouped activity, details, attachments,
   diffs, code blocks, and resumed markers usable. Preserve long-command
   horizontal scrolling inside code blocks. Check light/dark themes and
   Clanker state. Do not alter stored content or render a synthetic summary.
2. **Answer shape.** Extend the existing native `execute.njk` final-answer
   guidance and the existing CLI chat request owner (`CliChatRunner.ts`) with
   a short rule: lead with the direct answer, use short sections or bullets
   when helpful, keep one point per bullet, and move corrections into a brief
   closing note. Respect a request for exhaustive detail or a specific
   format. Existing CLI sessions resume with only the latest user text, so
   review whether a brief reminder on resumed turns is needed for the change
   to reach them; keep it short enough to avoid conversation bloat. No
   postprocessing of model text or provider-specific duplicate formatter.
3. **User scroll intent.** In `MessageList.tsx` and `scrollFollow.ts`, latch
   `userScrolledUp` only from an actual upward reader action: wheel/touch,
   keyboard navigation in the transcript, or scrollbar pointer/drag. A
   layout-driven `scroll` event or Forge's own `scrollToBottom` must not latch.
   Keep following while the reader has not opted out; return to follow when
   they deliberately reach the bottom. Preserve the current behavior when
   they read earlier material, including tab switches and new tokens.
4. **Bottom settling.** Re-pin the active transcript after content height
   corrections and pane resize until the bottom and measured height are stable
   for multiple frames, with a bounded/cancelable loop. Restart settling on
   relevant mutations, image loads, activity disclosure changes, and active
   pane switches; never force-follow a reader who scrolled up. Avoid a busy
   perpetual animation loop. Keep the existing off-screen rendering benefit
   of `content-visibility: auto` unless measurement proves a narrower change
   is necessary.
5. **Tool result disclosure.** Opening a compact activity step may reveal its
   tool rows, but must not automatically expand a long shell command/result.
   Keep short nested results inline, allow explicit open/close choices to
   survive streaming remounts and final host sync, and keep failure detail and
   approval state visible.

## Review before implementation

Review completed against current code: `MessageList.tsx` is the scroll owner;
the only pure latch helper is `scrollFollow.ts`. Its current tests explicitly
expect a negative `scrollTop` delta to latch even without an input event, which
is the behavior to change. `SIDEBAR_SWITCH_LATENCY_PLAN.md` confirms that
removing `content-visibility: auto` wholesale would regress tab performance.
The native final-answer rule lives in `execute.njk`; `CliChatRunner.ts` puts its
concise guidance in the initial CLI task, while resumed tasks carry only the
latest user message and optional plan. The implementation adds the same brief
answer-shape reminder to resumed tasks. The shell disclosure cause was the
nested/default-open coupling described above; short nested result visibility
now uses its own condition.

- Confirm `MessageList.tsx` is the only scroll-follow owner and inspect all
  places that read/write `userScrolledUp`, saved offsets, `scrollTop`, and
  `content-visibility` before editing. Review prior scroll-follow tests and
  `SIDEBAR_SWITCH_LATENCY_PLAN.md` so the fix keeps tab performance.
- Check the exact prompt assembly and CLI resume path before changing answer
  guidance. Avoid duplicating a guideline across rounds or overriding a
  user's requested format/detail.
- Check full, compact, and grouped transcripts at wide and sidebar widths.
  Centering must not shrink an already narrow sidebar or break right-aligned
  user bubbles, opened tool results, wide code blocks, or the composer.
- Treat the CSS and answer-guidance changes as separate effects in review:
  layout is deterministic, while model wording is a preference and may vary.

## State × lifecycle ledger

| State | Create/update | End/reset | Hidden/reload | Boundary behavior |
| --- | --- | --- | --- | --- |
| Follow versus reader-scrolled-up (webview ref) | Explicit reader input or a deliberate return to bottom | Conversation switch starts at the new pane's end | Existing mounted pane preserves reader offset; reload starts at end | Layout reflow, streaming token, tool-card collapse, image load, and programmatic scroll cannot impersonate upward intent |
| Settling animation/observer work (webview only) | Active pane mount/switch, content growth, resize/load | Stable bottom, user opt-out, unmount, or hidden pane | No durable state | Bounded scheduling; no stale RAF or observer follows a hidden/old conversation |
| Tool result disclosure (webview only) | Explicit reader toggle keyed by tool message id | Webview lifecycle/reset | Existing mounted rows and streaming remounts retain the in-memory choice; reload starts from closed defaults | Long nested output starts closed; short nested result and failure detail stay visible |
| Reply content | Existing agent output | Existing transcript lifecycle | Existing persistence unchanged | Prompt advice does not truncate or replace model text; user format/detail instructions win |

## Verification and handoff

- **Passed:** focused tests for explicit wheel, touch, keyboard, and scrollbar
  direction; layout-driven scroll changes; follow opt-out; and returning to the
  bottom. A jsdom `MessageList` regression covers programmatic upward movement,
  wheel opt-out, keyboard navigation from the focusable transcript pane, and a
  delayed height correction during bottom settling. An Edge browser regression
  covers real content reflow, reader wheel opt-out, and follow resumption.
- **Passed:** Edge layout QA at 1808 px and 440 px. Wide rows measured 1040 px,
  assistant prose 930 px, and the user bubble aligned to the column edge; at
  440 px, assistant prose used the available 420 px. Long code retained
  internal horizontal overflow. This fixture checked layout geometry, not the
  complete VS Code light/dark theme or a full production transcript.
- **Passed:** tool-row DOM regressions cover live output remaining collapsed,
  explicit open state across streaming update/remount, visible short nested
  output, and expanded failure detail. Existing tool-group tests pass.
- **Passed:** native answer guidance and CLI first/resumed-turn tests. Model
  wording still varies; these instructions do not postprocess or truncate it.
- **Passed:** `npm run ci` with one Vitest worker: 4,560 tests passed,
  42 skipped; type-check, lint, build, and bundle checks passed. Unrestricted
  Windows parallel runs hit an unrelated Git Bash `/tmp` startup failure in
  existing process tests; the same tests passed in the final one-worker run.
- **Passed:** `npm run package` produced `forge-llm-0.17.19.vsix`.
- **Remaining handoff:** final diff/status review, commit, local installation,
  and live VS Code theme/transcript verification. A reload of the open VS Code
  window activates a same-version reinstall.
