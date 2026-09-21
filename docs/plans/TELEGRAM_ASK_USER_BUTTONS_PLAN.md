# Telegram `ask_user` Buttons — Implementation Plan

**Date:** 2026-09-21
**Status:** implemented; sequential sub-question buttons remain deferred.
**Base observed:** `71fc85b feat: add Telegram contact workflow`

## Goal

Give a Telegram user inline buttons when Forge's `ask_user` call contains one
flat list of choices:

```text
Forge asks: Which approach should I use?

[Option A]
[Option B]
[Option C]
[Option D]
[Other…]
```

Selecting a button answers the exact pending question, closes the Telegram
choice message, and lets the blocked agent turn continue.

The first implementation deliberately does **not** add button navigation for
the multi-question `questions` shape. Those requests keep the existing
numbered-text behavior until the sequential flow is planned and implemented.

## Coordination boundary

The contact workflow was completed before implementation. The shared Telegram
callback and fake-channel surfaces were extended in place; the question
callbacks use a separate `q:` namespace and do not reuse model/profile state.

Before any future source edit:

1. Inspect its branch/working-tree diff and identify whether it touches the
   files listed below.
2. Do not overwrite, reset, or re-implement its work.
3. Rebase this plan against the final code path and run the complete gates
   after integration.

The likely overlap is `RemoteQuestionBridge.ts`, Telegram callback/types, and
the remote unit tests.

## Current architecture

- `src/remote/RemoteQuestionBridge.ts` keeps pending questions in memory and
  currently publishes them as text via `renderQuestionAsText`.
- `src/remote/RemoteController.ts` routes the next non-command text from that
  chat to `RemoteQuestionBridge.answerText`.
- `src/sidebar/UserQuestionService.ts` owns first-answer-wins settlement and
  exposes `answer(id, text)` to non-local surfaces through `ForgeHostFacade`.
- `src/util/questionAnswers.ts` owns option numbering and answer resolution.
- `src/remote/TelegramSelectionPagination.ts` already provides short,
  authenticated callback tokens and inline choice buttons for the model-profile
  flow. Its callback protocol must not be reused in a way that can answer the
  wrong question.

## UX and behavior

### Flat `options`

- Telegram sends the prompt with one button per option.
- `Other…` is an explicit user choice, not a hidden fallback. It changes the
  pending question into a free-text reply state.
- A valid option answers with the option's exact text, matching the sidebar.
- Duplicate taps after settlement are harmless and produce no second answer.
- A stale button is rejected visibly and cannot answer a later question.

### No options

Questions that require free text continue to use the existing ordinary Telegram
message path.

### Multi-question `questions`

- No Telegram buttons in this phase.
- Keep the current numbered text contract, including replies such as `1 2`.
- Sequential per-group buttons are a later phase and must not be simulated by
  combining choices or silently dropping a group.

### Other transports

WhatsApp and transports without inline-button support keep their current text
behavior. The strict button requirement applies only when the Telegram choice
surface is selected.

## Strict failure policy

For a Telegram flat-choice question, button delivery is a required capability.
Do not silently downgrade it to numbered text if Telegram rejects the message,
the callback cannot be encoded, or the button surface is unavailable.

On delivery failure, Forge must:

- emit an explicit remote error that the question could not be presented;
- settle/cancel the pending question through an explicit host-side cancellation
  path, so the agent turn cannot remain blocked forever;
- record the failure for diagnostics; and
- never claim that the user answered.

This may require adding `dismissQuestion(id)` to the host facade. Do not answer
with an empty string as a substitute: `ask_user` distinguishes cancellation
from an actual answer.

## Callback and state invariants

- Every button callback identifies the exact pending question, not merely the
  chat or option label.
- The callback is bounded to Telegram's callback-data limit and contains no
  untrusted free-form answer text.
- The bridge validates that the question is still pending and belongs to the
  callback's authenticated chat before calling `answerQuestion`.
- Settlement is first-writer-wins across Telegram, the sidebar, cancellation,
  and turn abort.
- The question is removed from the bridge only after the host accepts the
  answer or cancellation result; a stale/duplicate callback cannot delete a
  newer question.
- Closing/removing the Telegram choice message happens after settlement and is
  best-effort observable; it must not create a second answer.

## Implementation stages

### Stage 1 — flat Telegram choices

Likely owners:

- `src/remote/RemoteQuestionBridge.ts`
- `src/remote/RemoteController.ts` or the existing typed remote callback route
- `src/remote/TelegramSelectionPagination.ts`
- `src/remote/types.ts`
- `src/sidebar/ForgeHostFacade.ts`
- `src/sidebar/UserQuestionService.ts` if cancellation is added

Implemented in `src/remote/TelegramQuestionButtons.ts`,
`src/remote/RemoteQuestionBridge.ts`, and the shared Telegram event/facade
surfaces. Tests are in `test/unit/UserQuestion.test.ts` and
`test/unit/TelegramQuestionButtons.test.ts`.

Use a question-specific callback namespace or a typed callback variant. Do not
store a question's options as a fake model selection. Keep model/profile
selection and question settlement separate.

### Stage 2 — strict delivery and cancellation

Add the explicit cancellation path, visible error behavior, and tests proving a
failed Telegram delivery does not leave an agent turn waiting indefinitely.

Implemented: delivery failure dismisses the host question and sends an explicit
error; a concurrent sidebar answer remains authoritative.

### Stage 3 — sequential sub-question buttons (deferred)

For `questions`, maintain the selected answers and show one group at a time:

```text
Question 1 of 2
[Option A] [Option B]
```

After the first choice, edit the same message for the next group. Only the
final group settles the host question with the existing
`formatGroupAnswer` contract. This stage needs its own plan or an amendment to
this one.

## Acceptance matrix

| Case | Required result |
| --- | --- |
| Flat options on Telegram | Prompt arrives with one button per option and explicit `Other…`. |
| Tap option | Exact option text reaches the pending `ask_user`; turn resumes. |
| Duplicate tap | No second host answer and no duplicate continuation. |
| Stale button | Visible rejection; no effect on a newer question. |
| Sidebar answers first | Telegram tap becomes harmless; sidebar answer remains authoritative. |
| Telegram send failure | Explicit error plus question cancellation; no silent text downgrade. |
| Free-text question | Existing text reply behavior remains. |
| `questions` array | Existing numbered text behavior remains in this phase. |
| WhatsApp/no button transport | Existing numbered/text behavior remains. |
| Turn cancellation | Pending Telegram question is dismissed and buttons cannot answer later. |
| Long/unsafe labels | Message and callback limits are enforced without malformed Telegram calls. |

## Test matrix

Add or update tests for:

- Telegram choice keyboard rendering and callback parsing.
- Bridge publication of flat options.
- Exact option-to-answer mapping.
- `Other…` entering explicit free-text mode.
- Duplicate and stale callback handling.
- Sidebar/Telegram first-answer-wins races.
- Delivery failure and explicit cancellation.
- Turn abort and question resolution cleanup.
- Preservation of existing `questions` numbered-text behavior.
- WhatsApp/plain transport behavior.

## Gates and handoff

After the last source or test edit, run:

```text
npm run ci
npm run package
git diff --check
git status --short
```

Do not claim the Telegram feature is complete until the strict failure path,
flat-choice tests, and all repository gates pass. Do not implement sequential
sub-question buttons under this first-phase plan without updating the scope and
acceptance matrix.
