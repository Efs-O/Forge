# Remote `ask_user`: surface the "Other…" (free-text) route on Telegram

> **Status: implemented 2026-09-12.** One-line footer change in
> `src/util/questionAnswers.ts` plus tests in `test/unit/UserQuestion.test.ts`
> and new `test/unit/questionAnswers.test.ts`. Full suite green.

## Problem

A multi-question `ask_user` (the `questions` sub-question form) renders an
explicit **`Other…`** button in the sidebar dialog, but the Telegram mirror
shows only the numbered choices and the footer
`Reply with one number per question, in order — e.g. "1 2".` — with no
`Other…` affordance and no hint that free text is accepted. A phone-only user
is therefore funneled into picking a number and cannot express "none of these /
something else", even though the sidebar offers them exactly that.

Reproduced 2026-09-12: sidebar "Forge asks" card shows 4 numbered options plus
`Other…`; the Telegram message for the same question shows the 4 options and
only the number-reply instruction.

## Root cause

The single owner of the plain-text question is
`renderQuestionAsText` in `src/util/questionAnswers.ts`. Its three branches
disagree about whether free text is offered:

- **Flat options** (line 111): `Reply with the number or the text.` —
  advertises free text.
- **Multi-question / groups** (line 107):
  `Reply with one number per question, in order — e.g. "1 2".` — **does not.**
- **No options** (line 113): `Reply with your answer.` — free text is the only
  route, so it is implied.

The sidebar (`webview-ui/src/components/QuestionDialog.tsx`) renders `Other…`
for both the options and the groups case
(`{!showOther && (options?.length || groups) ? … : null}`), so the groups case
has the route locally but the text renderer — which is what the remote chat and
the VS Code input box fall back to — drops it.

### Free text already works remotely; it is only unadvertised

The remote answer path does **not** reject prose for a multi-question:

`RemoteQuestionBridge.answerText` (`src/remote/RemoteQuestionBridge.ts`) →
`host.answerQuestion` → `UserQuestionService.answer`
(`src/sidebar/UserQuestionService.ts:136`) →
`resolveAnswerText(text, question.options, question.questions)`.

In `resolveAnswerText`, when `groups` is present, `pickIndices` returns
`undefined` for any reply that is not exactly one in-range index per
sub-question, so the text is **passed through verbatim** to the model. That is
identical to what the sidebar does when the user types into `Other…`
(`submit` sends `text.trim()` verbatim, overriding the clicked picks). The two
surfaces already agree on the *answer* semantics; they only disagree on
*advertising* the route.

## Fix

Make the groups footer advertise the free-text route, mirroring the flat-options
phrasing ("or the text") and the sidebar's `Other…`.

**`src/util/questionAnswers.ts` — `renderQuestionAsText`, groups branch (line 107):**

Before:

```ts
return `${prompt}\n\n${body}\n\nReply with one number per question, in order — e.g. "${example}".`;
```

After:

```ts
return `${prompt}\n\n${body}\n\nReply with one number per question, in order — e.g. "${example}" — or send free text instead.`;
```

No change to `resolveAnswerText`, `pickIndices`, `formatGroupAnswer`, the
bridge, or the sidebar. The number-reply contract is untouched: an exact
`"1 2"` still resolves to the labelled group answer, and anything else is still
passed through verbatim — the only thing that changes is that the user is now
told they may do the latter.

### Why not a real button?

Telegram has no callback-button surface for a free-text answer (the approval
bridge is a two-button callback; a question needs prose back), so the question
is delivered as an ordinary message and the next non-command text is the answer.
Advertising the route in the message body is the correct and only available
mechanism — it is also what the flat-options branch already does.

## Tests

`test/unit/UserQuestion.test.ts` already drives the bridge end to end and asserts
the rendered footer. Extend the existing multi-question test
(`numbers each sub-question separately and says how to reply`) and add a
focused unit test for the renderer.

1. **Bridge (existing test, `RemoteQuestionBridge` describe block):** after the
   current `expect(text).toContain('one number per question')`, also assert
   `expect(text).toContain('or send free text instead')`.

2. **Remote free-text passthrough (new bridge test):** ask a two-question
   question, then `bridge.answerText('chat-1', 'something else entirely')` and
   assert the pending resolves to the verbatim text (not a labelled group
   answer). This pins the invariant that the advertised route actually works —
   the regression that would turn the new footer into a lie.

3. **Renderer (new `test/unit/questionAnswers.test.ts`):**
   - `renderQuestionAsText` for groups contains both the number instruction and
     the free-text route.
   - `resolveAnswerText('1 2', undefined, groups)` returns the labelled group
     answer (number contract unchanged).
   - `resolveAnswerText('prose reply', undefined, groups)` returns `'prose
     reply'` verbatim (free-text contract).

## Acceptance criteria

- [ ] **AC1 — Telegram advertises the route.** A multi-question `ask_user`
      delivered to the bound chat contains the free-text route in its footer.
      *Validation:* bridge test #1 (`toContain('or send free text instead')`).
- [ ] **AC2 — The advertised route works.** A non-index reply to a
      multi-question is delivered to the model verbatim, not rejected and not
      coerced into a labelled group answer. *Validation:* bridge test #2 and
      renderer test #3c.
- [ ] **AC3 — Number contract unchanged.** An exact per-question index reply
      still resolves to the labelled group answer, and the numbering the sidebar
      and the chat share is byte-identical. *Validation:* renderer test #3b plus
      the pre-existing `numbers each sub-question separately` assertions
      (`1) Version`, `2) Install`, `   1. bump`).
- [ ] **AC4 — Flat-options and no-options footers unchanged.** The fix touches
      only the groups branch. *Validation:* existing `numbers the options it
      offers` test still passes; `renderQuestionAsText` flat/no-options output
      is byte-identical (covered by renderer test #3a scoping to groups).
- [ ] **AC5 — Sidebar parity.** The sidebar `Other…` button and the remote
      free-text route produce the same answer semantics (verbatim text wins
      over clicked picks). *Validation:* existing
      `test/webview/QuestionDialog.dom.test.ts` `Other…` cases still pass;
      renderer test #3c matches the sidebar `submit` verbatim behaviour.
- [ ] **AC6 — Full suite green.** `npm test` passes with no new failures.
      *Validation:* `npm test`.
