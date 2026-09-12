# Handoff — image lightbox + `image_retention_turns` (post-compact)

Read this top to bottom, then do the remaining work. Everything below is
self-contained; do **not** rely on memory of the earlier conversation — several
of its facts (especially the model list and every line number) are **wrong**.

## What the user wants
1. Images shown as thumbnails in the Forge webview sidebar (from the sidebar
   composer **and** from Telegram) should be **clickable and expandable** in
   place — a lightbox, not a hand-off to VS Code's image preview. (Chosen:
   "Option A — Replace.")
2. Set `image_retention_turns: 2` on the vision models so an agent-viewed image
   (`view_image`) is aged out of the model-facing copy after 2 user turns and
   stops costing image tokens every turn.

## DONE — do not redo (already written to disk)
Verify by reading, but these are complete:
- `webview-ui/src/components/ImageLightbox.tsx` — new component. Fixed-inset
  overlay (z-index 1000, like `.confirm-overlay`), closes on Escape / backdrop
  click / close button; the `<img>` and caption stopPropagation so tapping the
  picture doesn't dismiss it.
- `webview-ui/src/components/MessageAttachments.tsx` — rewired. Image thumbnails
  now `setExpanded(...)` → render `<ImageLightbox>`. **Non-image** chips (text /
  PDF) still post `{ type: 'openAttachment', relativePath }` to the host (they
  have no pixels to expand). A non-image chip with no `relativePath` stays
  disabled.
- `webview-ui/styles/messages.css` — `.lightbox-overlay`, `.lightbox-image`,
  `.lightbox-caption`, `.lightbox-close` appended at the end.
- `test/webview/MessageAttachments.dom.test.ts` — 4 jsdom cases: image click
  opens lightbox (no host post), Escape closes, non-image still posts
  `openAttachment`, non-image without `relativePath` is disabled.

## REMAINING — the config edit (the only real work left)
Add `image_retention_turns: 2` to **every vision model** in `.forge/config.yaml`.

### Hard rules for this edit (the earlier attempt failed for these reasons)
- **Do NOT trust any model name or line number from the pre-compact
  conversation.** The file is large, my reads of it were superseded, and the
  user has confirmed the model list I had (Qwen3 / Qwen3.5 / Qwen3.8 / Gemma /
  …) is wrong — "we don't have qwen3 models." Re-read the file fresh and work
  only from what you actually see.
- **Do NOT use `apply_line_edits` with line numbers.** Line numbers drift and
  this file is big; the tool already rejected a stale batch twice.
- **One model per `edit_file` call.** Do not batch.
- **Anchor on the unique `name:` line, not a shared line.** Several models share
  an identical `mmproj_path:` value, so anchoring on `mmproj_path` alone is
  ambiguous. Instead make `old_str` a multi-line block that starts at the
  model's unique `  - name: <name>` line and runs down through its
  `mmproj_path:` (local) or `capabilities:` (cloud) line, and put
  `    image_retention_turns: 2` on the line after that anchor in `new_str`.
  The unique `name:` at the top of the block makes the match unambiguous.

### How to find the vision models (after a fresh read)
- **Local (llamacpp) vision models:** the model entries that have an
  `mmproj_path:` line.
- **Cloud vision models:** the model entries whose `capabilities:` list contains
  `vision`.
- That's the complete set. Do not guess the count — count what you actually see.

### Exact insert
Insert at the model's own indent (4 spaces), immediately after its
`mmproj_path:` / `capabilities:` line:
```
    image_retention_turns: 2
```
Why per-model and not in `defaults`: `defaults` is `ProfileSchema.partial()`
(`src/config/schema.ts`) and `ProfileSchema` does **not** include
`image_retention_turns` — it only exists on `ModelConfigSchema`. So it must be
set on each model.

### Why this feature exists (so you don't second-guess it)
`ageOutImageParts` (`src/sidebar/imageParts.ts`) is wired at
`src/sidebar/ModelTurn.ts` (`ageOutImageParts(windowed, model.image_retention_turns)`).
Omitted = disabled = image stays in context forever (the current behavior).
`2` = keep the image for 2 subsequent user turns, then replace it with a note
telling the model to call `view_image` again if it still needs it. This is the
token-saving half of the user's request; it is a pre-existing, tested feature —
we are only turning it on.

## Verification (do all three, in this order)
1. `npm run type-check` — the new component + rewired file must compile.
2. `npm test` — runs the non-live set, including the new
   `test/webview/MessageAttachments.dom.test.ts` and the config-loader tests
   (which will catch a YAML/indent mistake in `config.yaml`).
3. Confirm the config still parses and the vision models now carry
   `image_retention_turns: 2` (a config test failing means an indent or
   placement error — re-read the block you edited).

## Notes / gotchas
- `config.yaml` is **never** written back by the code — editing it by hand is
  the only way to change these values, and it is the source of truth.
- The loaded extension host is a pre-reload build; the lightbox won't be visible
  to the user until they rebuild + reload the extension. That's a user step, not
  a code one.
- If a model block is unusually shaped (e.g. the `name:` line and the anchor
  line are far apart with many fields between), still anchor from `name:` down
  to the anchor line — just make the block longer. Keep it exact (whitespace
  matters).
