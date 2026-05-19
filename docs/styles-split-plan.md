# Plan — Split styles.css (1031 LOC → 7 partials)

**Date:** 2026-05-18  
**Rule violated:** 350 LOC max per source file (no exemptions)  
**File:** `webview-ui/styles.css` — 1031 lines

---

## Why

A 1031-line flat CSS file is as hard to navigate as a 1000-line TypeScript file.
Finding the confirmation dialog styles means scrolling past tabs, markdown, and
animations. The 350 LOC rule applies to all source files.

---

## Split strategy

Single source directory: `webview-ui/styles/`  
Build: `esbuild.config.mjs` concatenates partials in order → `dist/webview/styles.css`  
No change to the HTML `<link>` tag or the extension host.

| File | Contents | Est. LOC |
|------|----------|----------|
| `base.css` | Design tokens (`:root`), box-sizing reset, global `button` baseline | ~25 |
| `animations.css` | All `@keyframes` + animated elements (typing dots, thinking bounce, cursor blink, streaming label) | ~75 |
| `layout.css` | `body`, `#forge-root`, `#forge-header`, token budget bar, checkpoint bar | ~130 |
| `tabs.css` | Chats panel, tab strip, history panel | ~230 |
| `messages.css` | Message bubbles, thinking bubble, action bar, assistant markdown styles | ~220 |
| `input.css` | Input row, attachments, send/stop buttons, slash command menu | ~220 |
| `dialogs.css` | Confirmation dialog overlay, dangerous variant | ~95 |

All partials under 350 LOC.

---

## Build change

`copyWebviewAssets()` in `esbuild.config.mjs` currently does a single `copyFileSync`.  
Replace with a concatenation loop over the ordered partials list using Node `fs.readFileSync` + `fs.writeFileSync`.  
Output is still a single `dist/webview/styles.css` — zero change to runtime behaviour.

---

## Files changed

- `webview-ui/styles/` — new directory with 7 partials (created)
- `webview-ui/styles.css` — deleted
- `esbuild.config.mjs` — `copyWebviewAssets` updated
