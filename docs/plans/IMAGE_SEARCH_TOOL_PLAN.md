# `image_search` — reverse image search via SerpApi Google Lens (impl plan)

> **Status: DONE. Implemented 2026-09-15 incl. thumbnails (sidebar + Telegram); live smoke passed 2026-09-23.**
> "As built" notes below record where the implementation departs from the
> first draft of this plan, and why.

## As built — deviations from the draft

| Draft said | Built | Why |
|---|---|---|
| `timeout_ms: 60000` | **90000** | Second live call: `type: all` took **52 s**. |
| `type` enum incl. `about_this_image` | `all, exact_matches, visual_matches, products` | `about_this_image` has a different shape; nothing asked for it. |
| Register only when the block exists | Registered with `advertise: () => image_search !== undefined` | Same as `generate_image`; reads live config, no reload. |
| Gate via "existing approval path" | `RegisteredTool.approval` returns metadata only when `confirm_upload` is on and the source is an attachment | `ToolDispatch` confirms whenever `approval` returns metadata. `dangerous: false`, so `/clanker` auto-approves it — clanker is explicit consent. Decline returns the standard `User declined: image_search`. |
| Extend the set-search-key command | Reuse **`forge.setCloudToken`** ("Forge: Set Cloud Provider Token") | It already stores any named key; a new command would duplicate it. |
| Inject `ChatAttachmentStore` | Inject `resolveAttachment(relativePath)`; store construction moved above `registerAllTools` in `extension.ts` | Tools stay free of the sidebar class; tests pass a lambda. |
| — | Added `image_search` to `PROSE_RESULT_TOOLS` | Results carry markdown links; render like `web_search`. |
| Step 0: verify Telegram path | **Verified**: `RemoteQueueDrain` → `host.send` → `SendPipeline` `attachmentStore.save()` → user message `attachments` | No fix needed. |

`type: all` live shape (second search): `visual_matches` (59),
`organic_results` (8, with `snippet`, `date`), `related_content`
(`query: "Eiffel Tower"` — what Lens identified), `short_videos`,
`ai_overview`. Output leads with the identification, then exact matches,
web pages, visual matches, products; videos and AI overview are dropped.
Bad key: HTTP 401, `{"error":"Invalid API key. …"}` — surfaced verbatim.

**Thumbnails (added after the first build, on request).** Top
`thumbnails` (default 4) match thumbnails are downloaded into
`.forge/image-search/<stamp>/` (`lensThumbnails.ts`) — measured 1.5–7 KB
JPEGs, keyless, < 0.7 s, from `serpapi.com` / `encrypted-tbn*.gstatic.com`
only. The result text gains one `IMAGE_SEARCH_THUMBNAILS_PREFIX` line listing
the paths; `ToolRow` parses it (`imageSearchThumbnailPaths`) and renders a
thumbnail grid through the existing workspace-resource route, so no webview
CSP change. Each thumbnail goes to a watching remote chat via
`UserNotificationService.deliverImage`, as `generate_image` does, and the
result states whether any chat took them. Folders > 7 days are pruned on the
next search. Workspace rather than globalStorage: the webview's live tool rows
only know the workspace root URI.

**Yandex engine + enlarge (second follow-up).** `engine: yandex` routes to
SerpApi `yandex_images` (`yandexImages.ts`; shared transport in `serpApi.ts`).
Live on the Eiffel photo: HTTP 200, **4.3 s**, 162 KB; `image_results` 108,
`similar_images` 40, `image_sizes.large` (largest copy 2900×5367),
`image_tags` 5. `type` is Lens-only and refused with `engine: yandex`.
Enlarge: the first live run saved **92×92** thumbnails (Lens
`organic_results`). Measured maxima: Lens visual 165×306, Lens exact
(serpapi.com) 174×290, Yandex with `w`/`h` dropped 173×320; the original
was 2900×5367 / 5.2 MB on upload.wikimedia.org. Decision (user, 2026-09-15):
provider images only, prefer match thumbnails over organic ones, scale the
preview up in the lightbox, and add an "Open original" link that opens the
full image in the browser — Forge never fetches from the matched site. The
thumbnail line carries it as `path <url>` (originals > 300 chars dropped).

Also required, missed by the draft: the permissions block must grant
`net.search` (tool permission `search`), or the tool is never advertised.

**Goal:** the user attaches an image (sidebar or Telegram) and asks "where is
this from?"; the agent finds where it appears on the web with no further user
action. Free: SerpApi free plan (250 searches/month, cached repeats free) plus
Litterbox temporary hosting (no key, 1-hour expiry).

**Scope discipline:** one tool, two thin HTTP clients, one config block, one
secret. No thumbnails, no new UI, no scraping, no paid tier. Off unless the
user adds the config block.

---

## Feasibility — validated 2026-09-15 (live, before this plan)

| Step | Result |
|---|---|
| Litterbox upload (`time=1h`, no key) | OK, 1.7 s, served as `image/jpeg`, no robots.txt |
| Google Lens fetches the Litterbox URL | OK — results URL carried `vsdim=553,1024`, i.e. Google decoded our 960×1777 file |
| SerpApi `engine=google_lens`, `type=exact_matches` | HTTP 200, `Success`, **400 matches**, **18.3 s**, **391 KB** JSON |
| Top 8 as title/source/link | **~1.1 KB** |

Findings that shape the design:

- **SerpApi takes a public `url` only** — no upload, no base64. Hence Litterbox.
- **Litterbox does not validate content.** An HTML page named `.jpg` uploaded
  fine. Forge must sniff magic bytes before upload.
- **Raw response is 391 KB** — must never reach the model. Hard trim.
- **~20 s end to end** — needs a timeout and the caller's `abortSignal`.
- Match fields seen: `position, title, source, source_icon, link, thumbnail,
  actual_image_width, actual_image_height`, plus `date` (271/400) and
  `price`/`extracted_price` on shop listings. `thumbnail` is a
  `https://serpapi.com/searches/...` URL, not a data URI.

Sample match (shape reference for test fixtures):

```json
{ "position": 2, "title": "File:Tour Eiffel Wikimedia Commons.jpg",
  "source": "Wikimedia Commons",
  "link": "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg",
  "thumbnail": "https://serpapi.com/searches/.../images/...",
  "actual_image_width": 330, "actual_image_height": 550 }
```

---

## User-facing behaviour (decided)

1. User attaches an image in the sidebar or Telegram and asks.
2. Agent calls `image_search`. The tool picks the attachment from the
   conversation transcript — the user never pastes a path or URL.
3. Tool uploads to Litterbox (skipped if the input is already a public URL),
   calls SerpApi, trims, returns ~300–500 tokens of text.
4. Agent answers **in the chat the prompt came from** (sidebar or Telegram)
   with a short summary + links. Raw trimmed list is visible in the collapsed
   tool row.

**Upload confirmation gate — exists, default OFF.**
`image_search.confirm_upload: false`. When `true`, the tool asks before sending
a *local* image off the machine (screenshots can hold code, chats, secrets).
Public-URL searches never ask.

---

## Design

### Config — `image_search` block (`src/config/schema.ts`, `types.ts`)

```yaml
image_search:
  provider: serpapi_lens          # only value for now
  secret_key_name: serpapi         # SecretStorage key
  max_results: 8                   # trimmed matches returned to the model
  confirm_upload: false            # gate for local-image uploads
  timeout_ms: 60000
```

Zod: `provider: z.enum(['serpapi_lens'])`, `max_results` int 1–20,
`confirm_upload` boolean default false, `timeout_ms` int positive. No hidden
fallbacks — the defaults are the schema's, documented in
`config/config.example.yaml`.

### Registration — `src/tools/registerAllTools.ts`

Register only when the block exists, same as `web_search` (`:154`) and
`generate_image` (`:197`). A config without the block keeps the tool list —
and the KV prefix — unchanged. Permission tier `search`.

Note: flipping the block on mid-conversation changes the tool list, which
forces a full cold re-prefill on Qwen3.8 (~95 s at 70K). Enable once.

### Tool schema (strict, short description ≤ ~200 tokens)

```json
{
  "name": "image_search",
  "description": "Reverse image search (Google Lens). Finds where an image appears online. Uses the most recent image the user attached unless image_url is given.",
  "parameters": {
    "type": "object",
    "properties": {
      "attachment_index": { "type": "integer", "minimum": 1,
        "description": "1 = most recent attached image, 2 = the one before. Default 1." },
      "image_url": { "type": "string",
        "description": "Public http(s) image URL. Use instead of an attachment." },
      "type": { "type": "string",
        "enum": ["all", "exact_matches", "visual_matches", "products", "about_this_image"],
        "description": "exact_matches = same image elsewhere; visual_matches = similar. Default all." }
    },
    "additionalProperties": false
  }
}
```

`image_url` is a URL, not a blob: handler validates `^https?://` with Zod and
rejects anything else. Giving both `attachment_index` and `image_url` is an
error naming which one to drop.

### Attachment resolution — no new plumbing

`ToolHandlerContext.conversationMessages` (`src/tools/ToolRegistry.ts:42`)
already carries the transcript, and user messages carry
`attachments: ChatAttachmentRef[]` (`src/llm/types.ts:14`) with a
`relativePath`. The tool walks user messages newest-first, collects
`image/*` refs, picks `attachment_index`, and resolves the path with
`ChatAttachmentStore.resolve()` (`src/sidebar/ChatAttachmentStore.ts:81`,
which already enforces containment). The store is injected into the tool
factory — the tool does not construct its own.

**Verify first (step 0):** Telegram photos are stored in
`.forge/remote-inbox` by `RemoteAttachmentStore`. Confirm that the remote
admission path also runs `SendPipeline`'s `attachmentStore.save()`
(`src/sidebar/SendPipeline.ts:211`) so remote images land in
`conversationMessages[].attachments` too. If it does not, the fix is to make it
do so — not a second resolver in the tool.

No-image error string names the alternative: *"No image attached in this
conversation. Ask the user to attach one, or pass image_url."*

### New modules — `src/tools/imageSearch/` (mirrors `imageGeneration/`)

| File | Owns | ~LOC |
|---|---|---|
| `litterboxUpload.ts` | `uploadTemporaryImage(bytes, name, {signal, fetchImpl})` → URL. `POST https://litterbox.catbox.moe/resources/internals/api.php`, `reqtype=fileupload`, `time=1h`. Response must match `^https://litter\.catbox\.moe/\S+$` or throw with the body's first 200 chars. | ~60 |
| `serpApiLens.ts` | `searchLens(url, type, apiKey, {signal, fetchImpl})` → parsed matches. Surfaces SerpApi's JSON `error` field verbatim (quota exhausted, bad key). Parses defensively — every field optional. | ~90 |
| `imageSearchTool.ts` | Factory, schema, attachment resolution, magic-byte check, gate, trim/format, URL cache. | ~170 |

Seam: host vs provider vs tool — each can be swapped or tested alone.
`fetchImpl` injection follows `cloudImageBackend.ts`.

### Handler flow

1. Validate args. Read key from SecretStorage; missing ⇒ throw naming the
   command to set it.
2. Resolve source: `image_url` → use directly; else attachment → read bytes.
3. Local path only:
   - size ≤ `MAX_VIEW_IMAGE_BYTES` (`src/tools/imageTool.ts:10`, reuse).
   - `mimeFromHeader(bytes)` (`imageTool.ts`) must return an image type —
     never trust the extension (Litterbox finding).
   - `confirm_upload: true` ⇒ ask via the existing approval path; declined ⇒
     return *"User declined uploading the image; nothing was sent."* (a real
     answer, not `(cancelled)`).
   - URL cache hit (same `relativePath`, uploaded < 50 min ago) ⇒ reuse URL;
     else upload. In-memory `Map`, no persistence. Reusing the URL also lets
     SerpApi's free cache serve an identical repeat search.
4. `searchLens()` under `AbortSignal.any([context.abortSignal, timeout])`.
5. Trim and format (below). Return a string.

### Result format (hard cap 2,000 chars)

```
Google Lens exact_matches: 400 found, top 8 shown.
1. Eiffel Tower - Wikipedia — Wikipedia — <https://en.wikipedia.org/wiki/Eiffel_Tower> — 330x550
2. ... — Instagram — <...> — 2025-03-02
3. ... — eBay — <...> — $24.99
```

Per match: `title` (≤ 100 chars), `source`, `link`, then whichever of `date`,
`actual_image_width`x`height`, `price` exist. Never `thumbnail`,
`source_icon`, `search_metadata`. For `type: all`, include the section name
per group (`exact_matches`, `visual_matches`, …) and share the same cap.
Zero matches ⇒ *"Google Lens found no matches for this image."*

### Secret — `src/vscode/secretCommands.ts`

Extend the existing set-key flow with a SerpApi option; do not add a sibling
command module. Grep `forge.setCloudToken` / search-key command first and
reuse whichever owns "store a named provider key".

### Errors (surfaced, never swallowed)

| Case | Tool result |
|---|---|
| Key missing | throw: set it with the command name |
| SerpApi `error` (e.g. out of searches) | throw with SerpApi's message verbatim |
| SerpApi HTTP ≠ 200 | throw `HTTP <code>` + first 200 chars |
| Litterbox down / bad response | throw with status + body excerpt |
| Not an image by magic bytes | throw: "attachment is not an image (<detected>)" |
| Timeout | throw: "image search timed out after N s" |

Throwing from the handler is how `web_search` reports failure today; keep that.

---

## Rule updates in the same commit

- **CLAUDE.md → Architecture Rules, network line:** name Litterbox explicitly
  as the opt-in temporary image host used only by `image_search`, so it is
  sanctioned traffic rather than an unlisted endpoint.
- **`docs/OWNERS.md`:** rows for the three new modules.
- **`CHANGES.md`**, **`config/config.example.yaml`** (commented block).

---

## Steps

0. Verify the Telegram attachment path (above). Stop and report if it needs a fix.
1. Config schema + types + example block.
2. `litterboxUpload.ts` + `serpApiLens.ts` with unit tests (injected
   `fetchImpl`; fixture = 3 trimmed matches in the shape above, plus an
   `{ "error": "Your account has run out of searches." }` fixture).
3. `imageSearchTool.ts` + tests: newest-first attachment pick, index out of
   range, both args given, non-image bytes, gate on/off/declined, cache hit,
   trim cap, zero matches.
4. Registration + secret command + OWNERS/CLAUDE.md/CHANGES.
5. `npm run ci`, `npm run package`.
6. Live smoke (uses 3 of 250 searches): sidebar attachment, Telegram photo,
   public `image_url`. Check the session log's `tool` rows, not the rendered chat.

## Out of scope (later, if wanted)

- ~~Thumbnails~~ — done (see top).
- One Telegram album (`sendMediaGroup`) instead of separate photos.
- Deleting the Litterbox upload early (Litterbox has no delete API; it
  expires in 1 h).
- Skipping the model's own view of the attached image to save context.
- Other providers (TinEye API is paid; not planned).
