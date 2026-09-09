# Question Dialog Incremental UX Plan

## Goal

Improve Forge's current `ask_user` modal without changing the approval or
question-routing architecture. The immediate change makes long questions
comfortable to read and makes an explicit free-text alternative available when
the agent supplied numbered choices.

The long-term direction is to keep questions inside the chat/task UI rather
than in a native-style popup, as Claude Code and Codex do. That preserves the
visible conversation and makes a question feel like the next task step. It is
intentionally deferred from this small change.

## Current behavior and constraints

- `ask_user` travels through `UserQuestionService`, the typed sidebar bridge,
  the webview dialog, and optional remote question sinks.
- An options question currently renders one immediately-submitting button per
  option; it does not render the textarea.
- A free-text question renders the textarea and accepts Enter to submit
  (`Shift+Enter` inserts a line).
- The host already resolves a bare numeric reply such as `2` to the second
  supplied option, and passes all other text through verbatim. This is used by
  local, remote, and programmatic answers and must remain true.
- The service accepts only one answer per question. A later agent question is
  already the natural boundary for a follow-up decision; no multi-page answer
  protocol is required for this increment.

## Immediate implementation

### 1. Make the existing modal roomier

In `webview-ui/styles/dialogs.css`, enlarge only `.question-dialog` and its
question-content allowance so ordinary multi-paragraph questions fit without
premature scrolling. Keep a viewport-safe maximum size and retain scrolling as
the fallback for unusually long text. Do not change the shared confirmation
dialog's dimensions.

### 2. Add explicit `Other…` to option questions

In `webview-ui/src/components/QuestionDialog.tsx`:

1. Preserve the numbered option buttons and their immediate-answer behavior.
2. Add an `Other…` control below the option list.
3. Selecting it switches the dialog to the existing textarea, focuses that
   textarea, and shows `Answer` beside `Dismiss`.
4. `Other…` must never be sent as the answer. Only the user-entered text is
   posted.
5. Keep Escape, Enter-to-submit, Shift+Enter, dismissal, and disabled-empty
   answer behavior consistent with today's free-text question dialog.

This is a presentation-only expansion: no change is needed to
`UserQuestionService`, the message bridge, remote routing, or the `ask_user`
tool schema. Free text is already valid for an option-bearing question.

### 3. Tell models to ask one decision group at a time

Add concise, tool-specific guidance to `makeAskUserTool` in
`src/tools/uxTools.ts` (not a second duplicated global prompt rule):

- Ask one related decision group per `ask_user` call.
- When using `options`, keep choices short and use them for mutually exclusive
  decisions.
- Ask a follow-up decision, such as whether to run a final build, in the next
  `ask_user` call after the first answer rather than appending it as an
  unrelated “also” question.

The model can still make a poor choice, so this guidance is not treated as a
UI guarantee. The UI change above remains useful regardless of prompt quality.

## Acceptance criteria

- An option question shows all numbered options and an `Other…` choice.
- Choosing a numbered option returns precisely that option as it does today.
- Choosing `Other…` reveals and focuses a free-text textarea; its submitted
  text returns verbatim and does not map to an option unless it is a bare valid
  number under the existing host rule.
- The enlarged question dialog is visibly more readable at normal sidebar
  widths, remains within the webview viewport, and scrolls only when necessary.
- Dismiss, Esc, Enter, Shift+Enter, remote answers, and question resolution
  from another surface continue to close the dialog correctly.
- The model-facing `ask_user` description directs separate decision groups to
  separate calls.

## Test plan

- Add/update a focused DOM test for `QuestionDialog` covering option selection,
  `Other…` expansion, focus, free-text submission, and keyboard behavior.
- Extend `test/unit/UserQuestion.test.ts` to preserve numeric selection and
  verbatim non-numeric text behavior for option-bearing questions.
- Add a tool-definition assertion for the one-decision-group guidance, if the
  existing tool-schema tests cover descriptions.
- Run `npm run ci` and `npm run package` before release.

## Deferred: inline chat/task questions with paging

Replace the modal with an inline `Forge asks` task card in the transcript. The
card would keep the surrounding conversation visible, support numbered choices
plus `Other…`, and show a small `Question 1 of N` indicator when a single
structured question has multiple decision areas.

Before building that, define a structured page/section contract in the typed
message bridge and preserve partial selections until the final page is
submitted. Back/Next navigation, keyboard selection, cancellation, remote
delivery, persistence/reload behavior, and concurrent-conversation isolation
need dedicated tests. Do not simulate this by stuffing multiple unrelated
questions into one free-text prompt; the immediate prompt guidance instead
uses sequential `ask_user` calls.

## Non-goals for this increment

- No removal of the modal.
- No change to confirmation dialogs or the approval gate.
- No new external dependency, setting, network call, or config schema.
- No change to remote question formatting or behavior.
