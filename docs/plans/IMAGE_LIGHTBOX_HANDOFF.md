# Handoff — image lightbox + `image_retention_turns`

This note records the completed implementation. The webview changes and the
per-model retention setting are both present; no follow-up edit is required.

## What the user wants
1. Images shown as thumbnails in the Forge webview sidebar (from the sidebar
   composer **and** from Telegram) should be **clickable and expandable** in
   place — a lightbox, not a hand-off to VS Code's image preview. (Chosen:
   "Option A — Replace.")
2. Set `image_retention_turns: 2` on the vision models so an agent-viewed image
   (`view_image`) is aged out of the model-facing copy after 2 user turns and
   stops costing image tokens every turn.

## DONE

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
- `test/webview/MessageAttachments.dom.test.ts` — jsdom cases covering image click
  opens lightbox (no host post), Escape closes, non-image still posts
  `openAttachment`, and non-image chips without a usable `relativePath` are
  disabled; the close button callback is also single-fire.
- `.forge/config.yaml` — all 12 detected vision models carry
  `image_retention_turns: 2`: 9 local models with `mmproj_path` and 3 cloud
  models whose capabilities include `vision`.

### Why the retention setting exists

`ageOutImageParts` (`src/sidebar/imageParts.ts`) is wired at
`src/sidebar/ModelTurn.ts` (`ageOutImageParts(windowed, model.image_retention_turns)`).
Omitted = disabled = image stays in context forever (the current behavior).
`2` = keep the image for 2 subsequent user turns, then replace it with a note
telling the model to call `view_image` again if it still needs it. This is the
token-saving half of the user's request.

## Verification

The implementation was verified with `npm test`, the production build, and a
YAML parse/count check for the 12 vision models.

## Notes / gotchas
- `config.yaml` is **never** written back by the code — editing it by hand is
  the only way to change these values, and it is the source of truth.
- The loaded extension host is a pre-reload build; the lightbox won't be visible
  to the user until they rebuild + reload the extension. That's a user step, not
  a code one.
