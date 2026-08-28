# Vision history stripping + image aging (impl plan)

**Bug:** attach images to a vision model, switch the conversation to a
projector-less model, send one more prompt → the turn dies with
`HTTP 500: {"error":{"message":"image input is not supported - hint: if this is
unexpected, you may need to provide the mmproj"}}`. The conversation is unusable
until the images are manually cleared or the window is reloaded.

**Root cause:** the vision gate in `AgentLoop.runTurn` (src/sidebar/AgentLoop.ts:286)
tests `attachments` — the images on *this* prompt — not `conv.messages`, which is
what actually goes on the wire (src/sidebar/ModelTurn.ts:202). With no new
attachment the guard is a no-op, and the `image_url` parts left in history by
`buildUserContent` (src/sidebar/ConversationOps.ts:275), `view_image`
(src/tools/imageTool.ts:144) and `view_video` (src/tools/videoTool.ts:246) ship to
a backend with no `--mmproj`.

**Why it looks intermittent:** `slimPersistMessages` (src/sidebar/sessionTypes.ts:299)
already strips image parts before persistence — base64 must never reach
`workspaceState`. So a reload "fixes" it, and the bug only reproduces inside a
live session.

**Scope discipline:** Phase 1 is the crash fix and is small — two exported image
helpers, one model-facing call site, one per-turn notice plus a once-per-model
toast, and one error classifier integrated at both OpenAI-compatible error sites.
Phase 2 (aging) is a separate, optional pass that reuses Phase 1's stripper and
adds one config key. Ship and verify Phase 1 first; Phase 2 does not block it.

---

## Phase 1 — stop sending images a model cannot read

### 1.1 One owner for image-part handling

The implementation keeps image-part inspection and replacement in the dedicated
`src/sidebar/imageParts.ts` module. `sessionTypes.ts` imports the persistence
stripper from it; `ModelTurn.ts` imports the model-facing stripping and aging
helpers. This preserves one implementation without pushing the already-large
session types/persistence file further past the practical source-file limit.
`docs/OWNERS.md` records `imageParts.ts` as the owner.

```ts
// src/sidebar/imageParts.ts
export function countImageParts(messages: readonly ChatMessage[]): number

/** Replace every image_url part with a note saying why it is not there.
 *  Returns the SAME array reference when nothing changed. */
export function stripImageParts(
  messages: ChatMessage[],
  options:
    | { reason: 'persist' }
    | { reason: 'no-vision'; modelName: string },
): ChatMessage[]
```

The discriminated options object picks the note text and supplies the model name
only where it is required. The two cases are genuinely different, and the wrong
note actively misleads:

- `persist` → the existing reload notes (image is gone, re-attach / re-call).
- `no-vision` → **the image still exists**, the active model just cannot see it:

  > `[An image was attached here. The active model "<name>" has no vision
  > projector, so it cannot see it. Switch to a vision-capable model to view it —
  > do not describe or guess at its contents.]`

The "do not guess" clause is load-bearing. A local model handed a bare gap will
confabulate a description, and the pixels are no longer there to contradict it.

`slimPersistMessages` is refactored to call
`stripImageParts(msgs, { reason: 'persist' })` before converting the surviving
content to the persistence shape, so there is exactly one image-part replacement
implementation. The helper clones only the messages whose content changes and
returns the original top-level array when there are no image parts.

### 1.2 Apply it at the single choke point

`prepareMessages` in src/sidebar/ModelTurn.ts:213 already builds the model-facing
copy each round and already leaves `conv.messages` untouched. `isVisionModel` is
computed 40 lines above (ModelTurn.ts:173). One line:

```ts
const windowed = applyCompactionWindow(messages, conv.compaction);
const visible = isVisionModel
  ? windowed
  : stripImageParts(windowed, { reason: 'no-vision', modelName: model.name });
const injected = injectSystemPrompt(visible, ...);
```

Ordering: **after** `applyCompactionWindow` (no point rewriting messages the
window drops) and **before** `injectSystemPrompt` / `prepareToolResultContext`,
so the freed tokens are visible to the budget math — the same reason the comment
at ModelTurn.ts:225 gives for ordering `supersedeStaleReads` first.

This covers every provider at once: llama.cpp, Ollama (`contentPartsToOllama`,
src/llm/OllamaNativeClient.ts:86, forwards data-URL images into `images[]` and
would fail the same way), and cloud.

`AgentLoop.ts:286` keeps its guard unchanged — refusing a *new* attachment with a
clear error is still right; it is not the thing that is broken.

### 1.3 Tell the user — in the transcript, not a toast

**This must never be silent.** The failure it produces is not "slightly degraded
output", it is one of two things, both of which look like a broken model rather
than a config fact:

1. The model answers *"I can't see any image"* while the screenshot is visibly
   sitting in the transcript above. The natural response is to re-attach it —
   which then trips the *attachment* guard (AgentLoop.ts:286) and produces a
   second, differently-worded error. Two unrelated-looking failures, one cause.
2. The model **guesses** from surrounding context and describes an image it
   never saw. Nothing can contradict it, because the pixels are gone. A
   fabrication with no correction path — the exact class of failure Forge exists
   to avoid.

A `warnOnce` toast is too weak for that: toasts are dismissed, missed entirely
when the sidebar is not focused, and fire once per session while the confusing
behaviour repeats on every turn. Use the in-conversation channel instead.

**Primary — a live `notice` row in the conversation** (`NoticeMsg`,
src/sidebar/messageBridge.ts:52, "a non-model status row displayed in the
conversation"; the same channel `CompactionService` uses at
src/sidebar/CompactionService.ts:134). It sits inline where the user is already
reading, immediately above the reply that will be missing the images:

> ⚠ **`<model>` cannot see images.** 3 image(s) earlier in this conversation
> were replaced with a placeholder for this turn. Switch back to a vision-capable
> model to use them. If `<model>` *is* multimodal, add `capabilities: [vision]`
> (or `mmproj_path` for llama.cpp) to it in `config.yaml`.

Posted once per turn that actually strips something — not once per session. The
condition is per-turn state, so it should be restated whenever it applies; a
suppressed notice on turn 5 is exactly the silent-degradation case.

Post it through `postC`, the existing per-turn sender on `ModelTurnRequest`
(ModelTurn.ts:93) — exactly the shape the round-cap notice already uses at
ModelTurn.ts:333:

```ts
postC({
  type: 'notice',
  message,
});
```

**Do not pass `conversationId`, and do not add an `onNotice` hook to
`ModelTurnContext`.** `postC` is already conversation-scoped: `AgentLoop.runTurn`
builds it as a closure that stamps `conversationId` onto every message
(AgentLoop.ts:284). Passing the id again is redundant, and a new context hook
would be a second status channel alongside one that already works.

`notice` is a host-to-webview event, not a `ChatMessage`, so Phase 1 deliberately
does **not** claim that this row survives reload. Persisting status rows would
require a new persisted transcript shape and is outside this crash fix. The
per-turn repetition is what prevents silent degradation during the live session;
after reload, image parts have already become the existing persistence notes.

**Secondary — keep a `warnOnce` toast** keyed `${model.name}:vision-strip`
(ModelTurn.ts:113 pattern) for the *first* occurrence only. It catches the case
where the user switched models via the picker and is not looking at the
transcript yet. Belt and braces; the notice is the one that matters.

Both are computed once per turn from the first actual model-facing window:

```ts
const initialWindow = applyCompactionWindow(conv.messages, conv.compaction);
const strippedImageCount = countImageParts(initialWindow);
```

Do this outside `prepareMessages` — that callback runs every tool round and
would rescan and re-post on each one. Counting the compacted window, rather than
all of `conv.messages`, also prevents a false notice when compaction already
excluded every image. A non-vision model cannot introduce later legitimate
image tool results because `view_image` and `view_video` are withheld and
dispatch-refused for that model.

Import `countImageParts` from `imageParts.ts`; do not duplicate image-part
traversal in `ModelTurn.ts`.

The `capabilities` sentence is not decoration: it is the only thing pointing at
the cause in the mistagged-model case. See Risks.

### 1.4 Map the backend error anyway (defence in depth)

Even with 1.2 in place, `HTTP 500: image input is not supported` is an
unactionable blob, and the no-silent-swallowing rule applies. There is already a
precedent for translating a llama-server 500 by body content —
`isTruncationParseError` at src/llm/OpenAIClient.ts:141. Add a sibling classifier
and use it in each OpenAI-compatible error path:

```ts
function imageUnsupportedMessage(modelName: string, httpStatus?: number): string;

if (isImageUnsupportedError(body)) {
  handlers.onError(new Error(imageUnsupportedMessage(request.model, response.status)));
  return;
}
```

The message reads:

> Model `<name>` rejected an image: it has no vision projector. Set
> mmproj_path (llama.cpp) or remove the vision capability. (HTTP 500)

Match on the distinctive `image input is not supported` substring. Apply the
mapping in **both** OpenAI-compatible failure paths:

1. the non-2xx HTTP response block (OpenAIClient.ts:147), which passes
   `response.status`; and
2. streamed SSE `error` frames (OpenAIClient.ts:266), which pass **nothing** —
   the stream is already HTTP 200 and the frame carries no status of its own.

The optional `httpStatus` parameter exists precisely so the SSE path does not
have to invent one. A shared message with a hardcoded status suffix would report
a fictional HTTP code for every streamed failure; omitting the suffix entirely
would throw away real information on the response path. The model name is
available as `request.model` in both. This catches OpenAI-compatible
paths that ever bypass `prepareMessages`; unlike the truncation case there is
nothing to retry, so it is a plain actionable error, not a recovery. Native
Ollama has a separate client, but Phase 1 stripping prevents the request there;
do not claim this OpenAI-client mapping covers native Ollama errors.

### 1.5 Tests (`test/unit/VisionHistoryStrip.test.ts` + OpenAI client error tests)

1. `countImageParts` counts images across messages, and `stripImageParts`
   replaces an `image_url` part with the note, keeps sibling text parts, and
   returns the **same reference** when there are no images.
2. A transcript with a user image + a `view_image` tool result, run through
   `runModelTurn` with a captured/mock client request on the non-vision path,
   contains zero `image_url` parts and two notes.
3. The equivalent `runModelTurn` vision path sends the transcript byte-identical.
   Both integration tests assert that the original `conv.messages` is unchanged.
4. `slimPersistMessages` still emits the *persist* notes — regression guard: the
   two reasons must not get crossed by the refactor.
5. `isImageUnsupportedError` matches the real llama-server body and does **not**
   match the truncation body (both are 500s from the same server). Client-level
   tests verify that both a non-2xx response and an SSE error frame produce the
   actionable image/projector error, and that only the response path carries the
   `(HTTP <status>)` suffix.
6. **A stripping turn posts exactly one `notice` even across multiple tool
   rounds** — and a turn on the same non-vision model with no images in its
   compacted window posts none. An image that exists only outside the compaction
   window also posts none. This is the regression guard for the whole point of
   1.3: a future refactor that makes stripping silent must fail the suite, not
   slip through review.
7. The secondary toast fires once for repeated affected turns on the same model,
   while the transcript notice fires once on every affected turn.

Existing `AgentLoop.test.ts` keeps covering the attachment-time refusal.

---

## Phase 2 — aging images out of long conversations

Separate pass. Even on a vision model, an image sits in context forever and can
be a large slice of a local model's per-slot window. Worse for `view_video`,
which injects N frames at once.

**Do not start this until Phase 1 is verified.** It is an optimization; Phase 1
is a crash.

### Design

Reuse the same image-part replacement machinery with a third options variant,
`{ reason: 'aged-out' }`, applied at the same `prepareMessages` choke point —
deliberately keeping one place where images are ever removed from the
model-facing copy.

```ts
const visible = isVisionModel
  ? ageOutImageParts(windowed, resolveImageRetention(model))
  : stripImageParts(windowed, {
      reason: 'no-vision',
      modelName: model.name,
    });
```

One branch, no dead arm: aging and `no-vision` stripping are mutually exclusive
by construction, and the single `visible` binding keeps Phase 2 at the same
choke point Phase 1 established.

- Retention counts **subsequent user messages**, not assistant/tool protocol
  messages. This is directly computable from the current transcript and means a
  tool-heavy round cannot evict an image by itself. An image is aged when the
  number of later user messages is greater than `image_retention_turns`.
- `0` therefore keeps an image throughout the user turn that introduced it and
  removes it on the next user prompt. The newest image always has zero later user
  messages and is never removed from the turn in which it arrived.
- Phase 2 does not promise filenames in aging notes. `ContentPartImage` currently
  retains only the URL: user attachment names are discarded, while `view_image`
  paths happen to live in sibling text. Parsing sibling prose would be brittle,
  and adding local-only provenance that must be removed at the wire boundary is
  a separate schema change. Preserve sibling text and use role-aware generic
  notes: tool images say to call `view_image` again; user images say to ask the
  user to re-attach them.
- Config: one optional, non-negative integer per-model key,
  `image_retention_turns`. **Omitted means disabled / never age out**, preserving
  today's behaviour. There is no hidden default and YAML `null` is not accepted;
  users opt in explicitly. `4` may be shown as a recommended example, not used
  as an implicit fallback.
- Add the key to `ModelConfig`, the Zod model schema, model resolution/merge
  handling, the user-facing config example, and config resolver/loader tests.
  Do not add it to group/profile shapes unless that broader scope is explicitly
  chosen and tested.
- Aging runs only for vision models. On a non-vision model, `no-vision` wins so
  the placeholder accurately explains why the model cannot see the image now.

### Explicitly not doing: auto-captioning

The tempting version is "have the vision model describe the image on arrival,
keep the caption, drop the pixels." Rejected for now:

- costs an extra model call per image, on hardware where that is real seconds;
- the caption is written before anyone knows what will be asked of it, so it
  answers the wrong question as often as not;
- a wrong caption becomes plain text that later turns treat as fact, with no
  image left to check it against — the worst of the three failure modes, and
  exactly the hallucination class Forge exists to avoid.

The `view_image` re-call escape hatch gives the same recovery without
manufacturing text nobody verified. Revisit only if re-calling proves too lossy
in practice.

---

## Risks / judgement calls

**Capability detection is asymmetric.** `deriveStaticCapabilities`
(src/config/ConfigResolver.ts:313-325) *infers* `vision` from `mmproj_path` for
llama.cpp, but for Ollama and cloud it only trusts a declared
`capabilities: [vision]`. So a genuinely multimodal Ollama model that nobody
tagged gets its history stripped.

That is the conservative direction, and it is the **same rule the attachment
guard already enforces** — nothing becomes less consistent. But it does raise the
cost of a forgotten tag: today it blocks a new attachment; after this change it
also removes existing images from a model that could have read them.

This is the whole reason 1.3 is an in-transcript `notice` rather than a toast,
and why it names `capabilities` explicitly. Stripping is only acceptable
*because* it is announced every time it happens — an unannounced strip would
turn a one-line config omission into a model that appears to be lying about what
it can see. If 1.3 is ever weakened, this risk becomes a real defect rather than
a documented tradeoff.

**Why not hard-block the turn instead** (matching the attachment guard)?
Considered and rejected: it would leave the conversation permanently unusable
after any image, since the only escape is clearing history — which is the
present bug wearing a nicer error message. Switching to a text model to ask a
text question about the code is legitimate and common. Announce and continue.

**Compaction interaction.** The 1.3 scan and the stripping decision both use the
post-compaction window. Images already outside the window produce no vision
notice because nothing was replaced for that turn. `conv.messages` remains the
untouched source of truth.

**Round-loop cost.** `prepareMessages` runs every tool round; the strip is an
array walk over messages that are almost never image-bearing. Returning the same
reference when nothing changed keeps it free in the common case.
