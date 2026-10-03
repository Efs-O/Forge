# `send_file` + `render_html_to_image` — complete the image pipeline

Status: **approved** (2026-10-03). **Phase 1 implemented** 2026-10-03
(`2e9304d`..`9b4f18b` + the review remediations below). Phase 2 in progress.

## Phase 1 review remediations (codex, 2026-10-03)

Codex reviewed `74cbfb5..HEAD` and found two MUST-FIX items, both fixed:

1. **Screenshot conversation isolation.** A junction at the *conversation*
   directory (`screenshots/conv-a` → `screenshots/conv-b`) left the resolved
   path strictly inside the screenshot base, so the containment check handed
   conv-b's files to conv-a. `sendFileTool.resolveFilePath` now requires
   `realpath(convDir) === path.join(realBase, conversationId)` — a real direct
   child, not merely something inside the base. Covered by a `conv-a → conv-b`
   junction test, which fails without the guard (verified by removing it).
2. **Phase 1 not durably recorded.** This plan was untracked and still said
   "Not started", and the `sendFileTool.ts` `OWNERS.md` row was uncommitted.
   Both are now committed.

Also taken from that review: the `default` screenshot-dir guard is
now case-insensitive (the filesystem is on Windows/macOS); the caption length
check counts code points, not UTF-16 code units (`src/util/codePoints.ts`,
making it agree with `sendTelegramPhoto`'s trim and the schema's `maxLength`);
the delivery-chain test compares `fs.realpathSync.native` values and file
contents instead of basename-plus-existence; a workspace-child junction escape
is asserted in `SendFileTool.test.ts` (not only in the resolver's own tests);
and `subscribeHostToRemote`'s `imagePath → deliverHostImage` arm plus
`RemoteController.deliverHostImage` now have direct tests, so the production
subscription is no longer only mirrored by a shaped-like-it sink.

Follow-up 4 is resolved by
[`IMAGE_SEARCH_DELIVERY_BUDGET_PLAN.md`](IMAGE_SEARCH_DELIVERY_BUDGET_PLAN.md):
each saved thumbnail uses one shared per-turn file slot. A search can save more
thumbnails than the phone limit allows and report the withheld count.

## Problem

`generate_image` (Qwen/Grok) is the only tool that can put a file on the user's phone.
It renders a *photograph* from a text prompt. Two gaps:

1. **Text-heavy graphics** (posters, invites, cards, diagrams, infographics) are
   fundamentally broken by diffusion models — they garble text, especially non-Latin
   scripts. The birthday invite became "COARROUNER / DULHR."
2. **Any file produced by other means** (Pillow composites, browser screenshots,
   reports, PDFs, plan docs) stops at "saved to disk" and never reaches the phone.

This plan adds two tools to close both gaps:

- **`render_html_to_image`** — a third image *maker* (HTML/CSS/SVG → PNG), sitting
  beside Qwen and Grok in the `media` group. For anything with text or exact layout.
- **`send_file`** — a general *delivery* tool. For any file, made by any means.

Together they make the `media` group a complete image pipeline:

| Tool | Makes | Delivers to phone |
|---|---|---|
| `generate_image` | photographs (Qwen/Grok) | ✅ built-in |
| `render_html_to_image` | text-heavy graphics (HTML) | ✅ built-in |
| `view_image` | — (inspects) | — |
| `send_file` | — (delivers) | ✅ |

## What already exists (do not rebuild)

### Delivery chain

```
tool handler
  → UserNotificationService.deliverImage({conversationId, text, imagePath})
  → fanOut → remote sink → RemoteController.deliverHostImage
  → RemoteAgentProgress.deliverImage  // queues on state.tail, reach-gated
  → channel.sendPhoto → sendTelegramPhoto  // sendPhoto→sendDocument fallback
```

Fully built, tested, image-generic. Both new tools call `deliverImage` (3 lines).

### Browser/Playwright machinery

The browser tools (shipped 2026-09-30, `e69abf1`) already ship `playwright-core`
(external, +12.8 MB in the VSIX, lazy-loaded). `render_html_to_image` reuses the
same `chromium.launch({ channel })` to get a browser binary — no new dependency.

### Path resolution

`src/tools/imageTool.ts` (`resolveImagePath`): `resolveWorkspacePath` + `fs.realpath`
+ containment check. `send_file` mirrors it, plus one scoped allowance.

---

## Tool 1: `render_html_to_image`

### Schema

```
render_html_to_image {
  html?: string          // inline HTML (the full document or a fragment)
  path?: string          // workspace-relative .html file to render
  width?: integer        // viewport width in CSS px (default 1024)
  height?: integer       // viewport height in CSS px (default 1024)
  full_page?: boolean    // if true, height is auto (content height); default false
}
```

- Exactly one of `html` / `path` is required. **Refuse when both are given**
  (CLAUDE.md: prefer explicit over hidden fallback). Use a handler refusal.
- `full_page: true` is the poster case (tall birthday invite). The browser measures
  the content and the screenshot is `width × contentHeight`. **Cap the content
  height at 16384 px** — a runaway layout gives an enormous PNG, and Telegram's
  `sendPhoto` rejects width+height > 10000 or aspect ratio > 20 (the fallback to
  `sendDocument` handles it, but the user gets a file rather than a photo).
- `full_page: false` (default) clips to exactly `width × height`.
- **Slug source:** the output filename is `<timestamp>-<slug>.png`. The slug is
  the HTML `<title>` element (trimmed, lowercased, non-alphanumeric → `-`, max 40
  chars), or `'render'` if no `<title>`.

### Description (load-bearing routing hint)

> "Render an HTML/CSS/SVG page to a PNG image and send it to the remote chat watching
> this turn. Use for text-heavy graphics: posters, cards, invites, diagrams,
> infographics, or anything needing exact text, fonts, and layout. JavaScript and
> external resources are not supported — inline everything (system fonts, base64
> images). Use generate_image for photographs and painterly scenes."

### Rendering

- **Playwright import:** lazy-require `playwright-core` via the same pattern as
  `BrowserSessionManager.ts` (`getPlaywright()` at line 79: `require('playwright-core')`
  inside the function, not at module top). The 12.8 MB module must not load on
  every conversation. Either export `getPlaywright` from `BrowserSessionManager.ts`
  or duplicate the 3-line pattern in the new tool file.
- **Browser:** `chromium.launch({ channel: <browser.channel from config>, headless: true })`.
  **Always headless** (ignores `browser.headless` — this is a render engine, not a
  browser session). If the channel is absent, error naming the fix (same pattern as
  `browser_open` in `BrowserSessionManager.ts:155`).
- **Context:** `browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
  javaScriptEnabled: false })`. JS disabled at context creation — the HTML is inert,
  no timers, no DOM manipulation, no data access. Deterministic: same input → same
  pixels. Note: Playwright has no `page.setJavaScriptEnabled()`; the flag is set on
  the context.
- **Network blocked:** `context.route('**/*', route => route.abort())` — register
  on the **context**, not the page, before `setContent`. Plain abort-all: `data:`
  URLs never reach route handlers in Chromium (they are resolved internally), so
  no `data:` branch is needed. All external fetches are aborted. If the HTML
  references an external URL, it silently fails to load (broken image / fallback
  font) — the render still succeeds.
- **Chrome's own traffic:** `context.route` blocks the *page's* requests, not
  Chrome's own (component updater, variations, DNS prefetch for
  `<link rel="dns-prefetch">`/`preconnect`). Harden the launch with `args`:
  `--disable-background-networking`, `--disable-component-update`, `--no-pings`,
  and `--host-resolver-rules=MAP * ~NOTFOUND` so nothing resolves.
  - **No `EXCLUDE localhost`.** Playwright's `launch` drives Chrome over
    `--remote-debugging-pipe`, not a localhost socket, so nothing needs it. An
    exclusion would leave a hole to Forge's own control server on
    `127.0.0.1:8799` should a request ever slip past the route.
  - **No quotes inside the arg.** `args` is an array passed without a shell,
    so literal quotes would become part of the rule.
- **Owner decision (2026-10-03): APPROVED.** The tool is un-gated from
  `permissions.browser.enabled`. It is a render engine (headless, JS-disabled,
  network-blocked, per-call, 30 s timeout), not interactive browsing. The
  CLAUDE.md rule is amended in the same commit to cover the render tool's
  no-network, local-only use.
- **Input delivery:** if `html` is a string, `page.setContent(html)`. If `path`,
  read the file (workspace-relative, realpath-verified), `page.setContent(contents)`.
  No `file://` navigation — avoids origin-approval machinery entirely.
- **Screenshot:** `page.screenshot({ type: 'png', fullPage: full_page })`.
- **Cleanup:** `browser.close()` in a `finally` block. The browser is per-call
  (spawn, render, kill) — no persistent process, no idle timer.
- **Timeout:** 30 s total (launch + render + screenshot). Use `Promise.race`
  with a timer. **Critical:** if `chromium.launch` resolves *after* the timeout
  fires, the continuation must call `browser.close()` — otherwise the browser is
  orphaned. Same for the screenshot step.
- **Abort:** turn cancelled → listen to `context.abortSignal` and call
  `browser.close()`. "Pipe-close handles it" only covers death of the extension
  host, not a mid-turn abort while the host is alive.

### Output

- **Format:** PNG always (text-heavy content → sharper than JPEG).
- **Save:** reads `image_generation.output_dir` from config if the block is present,
  defaults to `generated-images/` if not (same default as the schema at
  `imageGenerationSchema.ts:95`). Named `<timestamp>-<slug>.png`.
  **Name deconfliction (added after the Codex review, 2026-10-03):** the stamp
  has one-second granularity, so two renders of the same `<title>` inside one
  second land on the same name. That is NOT cosmetic here: `deliverFile` hands
  the PATH to a queued task that reads the bytes later, so a second write to the
  same name replaces what the FIRST delivery is about to upload and both chats
  get the second image. The tool therefore reserves a name before rendering —
  an exclusive `wx` create of a `<name>.png.forge-claim` sidecar, so the claim
  holds against other extension hosts and other processes, not just this one —
  and releases it in a `finally` around every later step. A taken name moves to
  `-2`, `-3`, … . A sidecar left by a crashed host is deliberately NOT reclaimed:
  it blocks only its own second-stamped name, which will never be requested
  again, and a stat-then-delete reclaim can delete another process's fresh claim
  (Codex review, 2026-10-03). The `.png` itself is deliberately NOT pre-created:
  `beforeMutate` snapshots that path, and a checkpoint that saw an existing
  0-byte file would make Undo restore an empty PNG instead of deleting it.
  `generate_image` keeps
  its own naming (it writes synchronously and is approval-gated per call).
- **Checkpoint:** `context.beforeMutate([absolute])` before the write (same as
  `generate_image`), so Undo removes the file.
- **Atomic write:** write `<name>.png.tmp` in the same directory, then `fs.rename`
  it to the final name. `generate_image` does **not** do this; it calls
  `fs.writeFile(absolute, …)` directly (`generateImageTool.ts:170`). So this is
  new behaviour, not a copy. Never let a partial PNG reach `deliverImage`.
- **Path resolution:** resolve the output path, and the `path` input, with
  `resolveRealWorkspacePath` (`src/util/WorkspacePaths.ts`, realpath +
  containment), the canonical owner. `imageTool.ts`'s `resolveImagePath` is a
  private function (line 71), so the plan cannot call it.
- **Size cap:** 10 MB. Above that, refuse (a 10 MB PNG is already very large).
- **Max HTML input:** 10 MB. Guards against pathological input.
- **Mutation:** `mutation: { paths: () => [], showDiff: false }` on the tool
  definition (same as `generate_image`). The output path is minted inside the
  handler (`<timestamp>-<slug>.png`), so a `paths()` callback would produce a
  different timestamp and snapshot the wrong file. The handler calls
  `context.beforeMutate([absolute])` before the write, which is the actual
  checkpoint mechanism.

### Delivery

Baked in, exactly like `generate_image`:

```ts
const reached = await deps.notifications.deliverImage({
  ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
  text: `🖼 render_html: ${path.basename(outputPath)}`,
  imagePath: absolute,
});
```

Result text (note: "Queued", not "Sent" — `deliverImage` returns 1 when the send
is *queued* on `state.tail`, not when it has been delivered. The actual send runs
later and can still fail. `generate_image` currently says `Sent to N remote
chat(s).` (`generateImageTool.ts:186`) — the same overclaim. Phase 2 changes it
to "Queued" too, so the three tools agree):
- `Rendered <basename> (PNG, N bytes) at WxH. Queued for N remote chat(s).`
- `Rendered <basename> (PNG, N bytes) at WxH. No remote chat is watching this turn.`

### Gating

- **Permission:** `fetch` + `additionalPermissions: ['write']` — same as
  `generate_image`. It writes a PNG to the workspace AND sends to
  `api.telegram.org`. A profile with `fetch` off must not be able to push files
  out through the render tool.
- **Approval:** none. Local render, free, no GPU. Its only outbound traffic is
  the Telegram delivery. Same as local `generate_image` with
  `confirm_each: false`.
- **Per-turn cap:** shares the file-delivery budget with `send_file` (see
  below). With no approval, nothing else brakes a render loop, and a render
  takes a second or two, not 30 s.
- **Vision gate:** none. The model writes HTML, renders it, delivers it. It never
  has to *see* the page. Works on non-vision models.
- **`permissions.browser.enabled`:** NOT required. This is a render engine, not
  browsing. It uses `browser.channel` to find the binary (config dependency), but
  the permission gate is for *interactive browsing*, not rendering.
- **Advertise:** always (no config block needed). If `browser.channel` is
  misconfigured or the binary is missing, the tool errors at call time naming the
  fix (same pattern as `browser_open`).
- **Lazy group:** `media` (add to `NATIVE_GROUP_BY_TOOL` in `lazyToolGroups.ts`).

### Dependencies

- `playwright-core` 1.63.0 (already in `package.json` line 504, external in esbuild,
  shipped intact at `dist/node_modules/playwright-core`, lazy-loaded via
  `getPlaywright()` pattern).
- `UserNotificationService` (injected into the tool factory via deps, same as
  `generate_image`).
- `browser.channel` from config (default `chrome`). The tool reads this to find the
  browser binary but is NOT gated by `permissions.browser.enabled`.

---

## Tool 2: `send_file`

### Schema

```
send_file {
  path: string          // workspace-relative, or under ~/.forge/screenshots/<conversationId>/
  caption?: string      // optional, maxLength: 1024 (Telegram caption limit), default ""
}
```

### Description (load-bearing routing hint)

> "Send a file from the workspace (or this conversation's screenshot directory) to
> the remote chat watching this turn. Use for files produced by other means: Pillow
> composites, browser screenshots, reports, PDFs, markdown. render_html_to_image
> and generate_image deliver their own output automatically — use send_file for
> anything else. Send only files you created or the user asked for; the copy
> persists on Telegram's servers, so never send credentials, keys, or config."

The last sentence is the mitigation for the prompt-injection path recorded under
Open question 2 — the tool does not refuse secret files, so the description is
what stands between an injected page and a leaked `.env`.

### Path handling

Mirror `view_image` (`resolveWorkspacePath` + `fs.realpath` + containment), **plus**
one scoped allowance:

- **Workspace:** any file inside the workspace root (realpath containment).
- **Screenshot dir:** `~/.forge/screenshots/<this-conversationId>/` only. This is
  where `browser_screenshot` saves. The conversation id comes from
  `ToolHandlerContext.conversationId`. Realpath containment — no traversal.
  **Critical:** when `conversationId` is `undefined`, `browserTools.ts:28` falls
  back to `'default'` (a shared dir). `send_file` must **refuse** the screenshot
  dir entirely when `conversationId` is `undefined` — do not resolve to `'default'`.
  Also `fs.realpath` the screenshot dir itself (the home dir may be a junction).
- **Everything else:** refused, naming the fix ("path must be in the workspace or
  this conversation's screenshot directory").

This keeps the trust surface to one Forge-owned, per-conversation directory. The
model cannot read arbitrary home files through `send_file`.

### Size cap

- **50 MB** (Telegram `sendDocument` ceiling). Above that, refuse with the size named.
- **0 bytes:** refuse. Telegram rejects a 0-byte upload with a 400 on both
  `sendPhoto` and `sendDocument`. The failure would be async and invisible (reported
  through `report()`, never back to the tool). Check at call time.

### Delivery

```ts
const reached = await deps.notifications.deliverImage({
  ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
  text: caption,
  imagePath: absolute,
});
```

Result text ("Queued", not "Sent" — see `render_html_to_image` above):
- `Queued <basename> for N remote chat(s).`
- `No remote chat is watching this turn, so nothing was queued.`

### Gating

- **Permission:** `fetch` (outbound to `api.telegram.org`). No `write` — it reads,
  does not create.
- **Approval:** none. Benign, user-initiated send, no cost.
- **Per-turn cap:** 5 file deliveries per turn, shared by `send_file` and
  `render_html_to_image` (the same number as `NOTIFY_TURN_LIMIT`). `deliverImage`
  skips the `notify_user` budget because its doc comment
  (`UserNotificationService.ts:164-170`) assumes every image passed a per-call
  approval. Neither new tool has one.
  - **The budget lives in `UserNotificationService`, not in a tool closure.** A
    closure counter has no reset path: `resetTurn` is a method on the service,
    called at turn start from `extension.ts:253`, and tools get no turn hook.
    A closure counter would therefore leak across turns and silently mute the
    tool for the rest of the session. That is the exact failure `resetTurn`'s
    comment describes.
  - **Implementation:** add `deliverFile(event)`, which charges a per-conversation
    file counter and returns a refusal when it is spent. Clear that counter in the
    existing `resetTurn`. `generate_image` keeps the unbudgeted `deliverImage`,
    since it has per-call approval.
  - Update the `deliverImage` doc comment to say why it alone is unbudgeted.
- **Vision gate:** none. You can send a file without the model seeing it.
- **Advertise:** always.
- **Lazy group:** `media`.

### The `TelegramPhoto.ts` tweak (Phase 3)

Today a small non-image file makes a wasted `sendPhoto` call that 400s, then retries
as `sendDocument`. Add: if the extension is not an image extension, skip `sendPhoto`
and go straight to `sendDocument`. Two lines; the photo path is untouched.

---

## Routing hints (cross-cutting, load-bearing)

The tool descriptions form the routing table. Without them, the model defaults to
Qwen for everything.

- **`render_html_to_image`:** "Use for text-heavy graphics… Use generate_image for
  photographs."
- **`generate_image`:** add one sentence: "For text-heavy graphics with exact layout
  (posters, cards, diagrams), use render_html_to_image instead — diffusion models
  garble text."
- **`send_file`:** "render_html_to_image and generate_image deliver their own output
  automatically — use send_file for anything else."

---

## Files touched

| File | Change |
|---|---|
| `src/tools/renderHtmlToImageTool.ts` | **new** — schema, path/string input, output naming + unique-claim, `beforeMutate`, atomic save, deliver |
| `src/tools/renderHtml/renderEngine.ts` | **new** — Playwright render (headless, JS disabled at context, `context.route` abort-all, hardened launch args), full_page height pre-measure, timeout/abort browser cleanup; split out of the tool file to stay under the 500-line gate |
| `src/sidebar/UserNotificationService.ts` | `deliverFile` with the shared per-turn file budget, cleared in `resetTurn`; `deliverImage` doc comment updated (Phase 1) |
| `src/tools/sendFileTool.ts` | **new** — schema, path resolution (workspace + screenshot-dir), size cap, deliver |
| `src/tools/browser/BrowserSessionManager.ts` | export `getPlaywright()` (currently private at line 79) so the render tool can reuse the lazy-require without duplicating the 12.8 MB import pattern |
| `src/tools/registerAllTools.ts` | register both tools next to `makeGenerateImageTool` |
| `src/tools/lazyToolGroups.ts` | add `render_html_to_image` and `send_file` to the `media` group |
| `src/remote/TelegramPhoto.ts` | non-image → straight `sendDocument` (Phase 3) |
| `src/tools/imageGeneration/generateImageTool.ts` | add one sentence to the description (routing hint); result `Sent to` → `Queued for` (Phase 2) |
| `test/unit/RenderHtmlToImageTool.test.ts` | **new** — input validation, path resolution, fake render, delivery, `beforeMutate` |
| `test/support/renderHtmlHarness.ts` + `renderHtmlRig.ts` | **new** — shared fake Playwright + deterministic deps for the two render suites |
| `test/integration/RenderHtmlLive.test.ts` | **new** — real headless Chrome: geometry, `full_page`, zero-hit network block, no `file://` read |
| `test/unit/SendFileTool.test.ts` | **new** — path resolution, size cap, result text |
| `test/unit/RemoteImageDelivery.test.ts` | extend: non-image → `sendDocument` directly |
| `docs/OWNERS.md` | rows for the two new modules |
| `CHANGES.md` | entry |

`RemoteController`, `RemoteAgentProgress` and `TelegramOutbound` are
**untouched**: both tools reuse them as-is. `UserNotificationService` gains
only the budgeted `deliverFile`.

---

## Phases

### Phase 1 — `send_file` (general delivery)

- New tool + registration + lazy-group entry + tests.
- `UserNotificationService.deliverFile` + the shared per-turn budget (+ tests).
- `docs/OWNERS.md` row for `sendFileTool.ts` (CLAUDE.md: add the row with the module).
- Unblocks: "send me the file I made by any means" (Pillow, screenshots, PDFs,
  **plan docs**, reports).
- No `TelegramPhoto.ts` change (images already work end-to-end; non-images get the
  wasted `sendPhoto` 400 but still succeed via fallback).

**Gate:** `npm run ci` green.

### Phase 2 — `render_html_to_image` (HTML maker)

- New tool + registration + lazy-group entry + tests.
- `docs/OWNERS.md` rows for `renderHtmlToImageTool.ts` and `renderHtml/renderEngine.ts`.
- `test/unit/RenderHtmlClaimAbort.test.ts` — Codex-review regressions for the
  name reservation (cross-process `wx` claim, release on every exit, and a
  sidecar left by a dead host being left alone rather than reclaimed) and the
  abort-listener reference identity.
- `generate_image` result wording `Sent to` → `Queued for`.
- Playwright render: headless, JS disabled at context, network blocked (context
  route, abort-all), Chrome launch flags, `setContent`, `screenshot`, save, deliver.
- **Routing hint in `generate_image` description** (moved here from Phase 3: the
  Phase 2 live smoke depends on the model choosing `render_html_to_image` over
  `generate_image`).
- Unblocks: "make a text-heavy graphic and send it in one call."

**Gate:** `npm run ci` green. A live smoke: write a simple HTML poster →
`render_html_to_image` → PNG arrives in the Telegram chat.

### Phase 3 — Polish

- `TelegramPhoto.ts` non-image early-exit (2 lines) + tests.
- Docs: a short section in `docs/BROWSER_DESKTOP_TOOLS.md` or a new
  `docs/IMAGE_PIPELINE.md` pointing at the HTML → render → send pipeline.
- `CHANGES.md` entry.

**Gate:** `npm run ci` green.

---

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Rendered PNG (`generated-images/`) | `render_html_to_image` handler, after `beforeMutate`, via `writeFileAtomicSync` | Undo (turn checkpoint), or user deletes | n/a | Write `<name>.png.tmp`, then rename on success. This is new behaviour: `generate_image` writes directly. A crash leaves at most a stray `.tmp`, never a partial `.png` | Inert on disk; user-owned. A stray `.tmp` from a crash stays until the user deletes it (accepted: rare and visible) | None |
| Name reservation (`<name>.png.forge-claim`, sidecar) | `fs.writeFile(claim, '', { flag: 'wx' })` — exclusive create, handle opened and closed by the call itself — BEFORE the render, so the claim holds across processes and VS Code windows | Deleted in the `finally` around every post-claim step (success, render error, `checkPng` refusal, abort, throwing `beforeMutate`, rejected write) | n/a | The sidecar is one exclusive create with no content, so there is no torn state; a crash leaves the file | Left in place, by design: it blocks only its own `<stamp>-<slug>` name, and the stamp carries the second, so that name is never requested again. A stat-then-delete reclaim would race another process's fresh claim (Codex review) | None — the leftover is accepted litter, like the atomic writer's stray `.tmp`; both live in gitignored `generated-images/` |
| Per-turn file budget (in-memory counter in `UserNotificationService`) | First `deliverFile` in a turn | Cleared by `resetTurn` at turn START (`extension.ts:253`), so a cancelled or thrown turn cannot leak it | n/a | In-memory: nothing to tear | Lost with the host. It starts at 0, which is correct | Per turn |
| Queued send (`state.tail` task) | `deliverImage` enqueues the task | Task runs and completes (or fails) | n/a | Extension host crash: the task is lost; the file is on disk but not sent. The user can re-ask | Same as above | None (runs immediately behind the narration) |
| File being sent (workspace or screenshot) | Created by the maker (not by `send_file`/`render_html_to_image`) | Maker's lifecycle | n/a | **Seam:** `sendTelegramPhoto` reads the file at *send time* (inside the queued task), not at call time. An Undo, edit, or delete between the tool's return and the actual send changes what gets sent. Mitigation: stat + size-check at call time; the send-time read is a known, accepted risk (documented, not hidden) | n/a | n/a |
| Playwright browser process (transient) | `render_html_to_image` handler, per call | `browser.close()` in `finally` after screenshot | n/a | `Promise.race` timeout: the continuation closes the browser if `chromium.launch` resolves after the timeout fires. Abort: listen to `context.abortSignal` and call `browser.close()` | Extension host crash: Playwright pipe-close kills the child (verified in browser tools Phase 1). A hard kill orphans the process; the next `render_html_to_image` call does not reap it (no owner record) — acceptable: the process is headless, no GPU, no VRAM, and exits when the pipe closes | None (lives for the duration of one render, ≤ 30 s) |
| `~/.forge/screenshots/<conv>/` (read-only) | Browser tools (their ledger) | Browser tools (their ledger) | n/a | n/a | n/a | n/a |

**CI-enforced rows:**
- **Writes:** the render tool writes only through `beforeMutate`'d paths. A unit
  test asserts `beforeMutate` is called with the output path before any write,
  and that the final `.png` appears only via rename from `.tmp`.
- **Reservation:** `test/unit/RenderHtmlClaimAbort.test.ts` pins the whole
  ledger row — a foreign sidecar forces `-2`, a successful render leaves no
  sidecar, a failed render/checkpoint/write releases the base name, and a
  sidecar left by a dead host is neither deleted nor preempted.
- **Abort listener:** the same file asserts the handler passed to
  `addEventListener` is the identical reference passed to
  `removeEventListener`, on both the success and the abort path.
- **Budget:** a unit test spends the file budget in one turn, calls `resetTurn`,
  and asserts the next `deliverFile` succeeds. This pins the "no leak across
  turns" invariant.

No new config fields, no new persistent processes, no new directories.

---

## Open questions

1. **Multiple files / albums.** "Send me all the images in this folder" → loop
   `send_file` (separate messages). Telegram's album API (multiple photos in one
   message) is a follow-up.
2. **Secret file refusal.** Telegram uploads persist on a third-party cloud. Consider
   refusing obvious secret files in `send_file`: `.env*`, `*.pem`, `*.key`,
   `.forge/config.yaml`, `id_*`. The recipient is the owner, but the copy persists
   on Telegram's servers. A prompt-injected page could talk the model into "sending
   the user" a secret. **Decided 2026-10-03: no pattern-based refusal in v1** — a
   denylist is easy to bypass (`id_rsa.txt`) and easy to false-positive on, so it
   buys little. Instead the `send_file` description now carries the instruction
   ("Send only files you created or the user asked for…"), and an acceptance
   criterion pins that sentence. A hard refusal stays a follow-up if the soft
   guard proves insufficient.
3. **Rename `deliverImage` / `imagePath`.** The chain is image-named but
   file-generic. Leaving the names avoids churn in four files. Cosmetic follow-up.
4. **Resolved in the image-search delivery budget plan (0.16.78).** Each saved
   thumbnail charges one shared per-turn file slot. The result keeps every
   saved thumbnail visible in the sidebar and reports when the phone limit
   withholds a photo. `generate_image` also uses that limit when its selected
   backend has `confirm_each: false`.

---

## Follow-up (not in this plan)

### `render_html_to_gif` — animated HTML → GIF → Telegram

JS *is* the point here: CSS animations (flickering candles, pulsing neon,
transitioning colors) run in the browser, and the tool captures a sequence of
frames.

Pipeline:
1. Launch headless Chrome, JS **enabled**, network blocked.
2. `page.setContent(html)`.
3. Loop: `page.screenshot()` → wait `frameInterval` ms → repeat for `frameCount`
   frames (default 30, interval 100 ms = 3 s loop).
4. Stitch frames into a GIF (ffmpeg, already on the machine, or `gif-encoder` npm).
5. Save `.gif`, deliver via `deliverImage` (Telegram supports animated GIFs ≤ 50 MB).

Complexities (why it's separate):
- File size: 30 frames × 1024×1024 PNG → 5–20 MB GIF. Needs quality/size tuning.
- Timing: CSS animation duration must be known or measured. `animation-iteration-count`
  must be finite for the capture window.
- JS enabled: the security argument flips — the HTML *can* run code. Mitigation:
  network still blocked, no DOM access to the page (sandboxed `setContent`),
  timeout still applies.
- Different permission profile: JS-enabled rendering is closer to "browsing" than
  "painting." Might warrant `permissions.browser.enabled` after all.

**Not in this plan. Separate plan when needed.**

### Image generation for approved contacts (family)

The contacts system is deliberately tool-free (a safety firewall: contacts get a
bounded Q&A bot, no tools, no files, no workspace). The owner's use case is
**family** (wife, kids) who want to generate images for fun — not customers.

Design sketch (separate plan, after this one ships):

- **Per-contact capability flag.** `RemoteContactRecord` gains
  `canGenerateImages: boolean` (default `false`). The owner grants it per contact:
  `/contact allow-image <name>` (and `/contact deny-image <name>` to revoke).
  This is a *per-contact* permission, not a global toggle — only the family
  members you name get it.
- **Flow:** a contact with the flag asks for an image → the contact model
  generates it (local Qwen, free, no billing exposure) → the image is sent
  directly to the contact. **No per-image approval.** The one-time
  `/contact allow-image <name>` grant *is* the permission — after that,
  the contact generates freely. This is family entertainment, not a
  security boundary; the owner is not going to approve every "a cat in
  a spacesuit."
- **The gate is the flag, not a confirmation loop.** `/contact allow-image`
  is the on; `/contact deny-image` is the off. Between those two, the
  contact generates without interruption.
- **Cost/VRAM:** local Qwen only (no Grok billing from a contact). The render
  uses the same 3060 VRAM gate as the owner's `generate_image` — if the 3060 is
  busy with owner work, the contact gets a "Forge is busy" notice, consistent
  with the existing contact capacity policy.
- **Workspace isolation:** a contact's render lands in a contact-scoped output
  dir, not the owner's `generated-images/`. Contact traffic never enters an
  owner conversation (existing invariant, preserved).
- **Not a flag on the existing tool.** The contact path is a separate,
  tool-free pipeline (`TelegramContactService`). This adds a *narrow* image
  capability to that pipeline, gated by the per-contact flag alone (the
  one-time owner grant, no per-image confirmation). It does not loosen the general "contacts have no tools" rule —
  it adds one specific, owner-approved capability.

**Not in this plan. Separate plan, dependent on this one (reuses `generate_image`
local backend + `deliverImage` chain).**

---

## Acceptance criteria

Each maps to a test or a named validation step.

### `render_html_to_image`

**Input validation**
- [x] `html` string accepted; `path` to a workspace `.html` file accepted; neither → error. → unit
      (`RenderHtmlToImageTool.test.ts`: "reads html from a workspace-relative path",
      "refuses when neither is given", "treats whitespace-only html as absent").
- [x] **Both `html` and `path` given → refused** (no hidden fallback). → unit
      ("refuses both html and path, naming the absence of a fallback").
- [x] HTML over 10 MB → refused with size named. → unit
      ("refuses html over 10 MB and names the size").
- [x] `path` outside workspace → refused. → unit ("refuses a path outside the workspace").
- [x] `width`/`height` below 1 or above 8192 → refused. → unit
      (`it.each` over 0/8193/-5 plus "refuses a non-integer viewport").

**Rendering**
- [x] Browser launched headless, JS disabled at context (`javaScriptEnabled: false`), network blocked via `context.route` (not `page.route`). → unit (mock Playwright:
      "disables JavaScript on the context, not the page", "blocks the network on the
      context, before any content is set") and live (`RenderHtmlLive.test.ts`).
- [x] Chrome launch flags: `--disable-background-networking`, `--disable-component-update`, `--no-pings`, `--host-resolver-rules=MAP * ~NOTFOUND` exactly: no `EXCLUDE localhost`, no embedded quotes. → unit
      ("launches headless with the exact hardened args and no localhost hole" asserts
      the array with `toEqual`, so an extra or reordered flag fails it).
- [x] `full_page: true` → screenshot height = content height, **capped at 16384 px**. → live (`RenderHtmlLive.test.ts`, 3000 px content height) + unit for the cap.
- [x] `full_page: false` (default) → screenshot is exactly `width × height`. → live (`RenderHtmlLive.test.ts`).
- [x] 30 s timeout → browser killed, error reported. **If `chromium.launch` resolves after the timeout, the continuation closes the browser.** → unit
      ("closes a browser that launches AFTER the timeout fires", using a real 50 ms
      deadline and a launch gate, not fake timers).
- [x] Abort mid-render → `context.abortSignal` triggers `browser.close()`, no orphan process. → unit (mock: "closes the browser and returns at once when the turn is
      aborted mid-render", "returns at once when the turn is aborted during a stalled
      launch", "refuses an already-aborted turn before spawning anything").
- [x] Output PNG ≤ 10 MB. → unit ("refuses a PNG over 10 MB and names its size").
- [x] Output filename slug: from `<title>` (trimmed, lowercased, non-alphanumeric → `-`, max 40 chars), or `'render'` if no `<title>`. → unit
      ("names the file from the <title> slug, falling back to \"render\"", 5 cases in
      `RenderHtmlOutputDelivery.test.ts`).

**Delivery**
- [x] With a watching chat: result is `Rendered <name> (PNG, N bytes) at WxH. Queued for 1 remote chat(s).` → unit ("reports Queued with the size and dimensions,
      never Sent"; also asserts the string never contains `Sent to`).
- [x] No chat bound: `No remote chat is watching this turn.` → unit ("says no chat is
      watching when the delivery reaches nobody", fake returning `chats: 0`).
- [x] `beforeMutate` called with the output path before the write. → unit (CI-enforced
      row: "checkpoints the output path before the write" orders `beforeMutate` before
      the atomic write and names the exact basename).
- [x] Write is atomic: bytes go to `<name>.png.tmp`, then are renamed. A failure between the two leaves no `.png`. → unit (CI-enforced row: "writes through the atomic
      owner, never exposing a partial .png" asserts the final name did NOT exist during
      the write; "leaves no temp file behind and writes the exact bytes" checks the
      directory afterwards. The atomic writer itself has `AtomicWrite.test.ts`).
- [x] Render counts against the shared per-turn file budget; the 6th delivery in a turn (any mix of `send_file` + `render_html_to_image`) is refused with the reason
      named. → unit ("keeps the PNG and names the refusal when the shared budget is
      spent", plus `UserNotification.test.ts` "shares one counter across every budgeted
      delivery").

**Gating**
- [x] In the `media` lazy group. → unit (lazy-group membership: `LazyToolGroups.test.ts`
      "registers the rare native and MCP groups with their tool families").
- [x] Not vision-gated (advertised on a non-vision model). → unit (same test asserts
      both tools are hidden before and visible after `activateLazyGroup` for
      `isVisionModel` true AND false).
- [x] Permission is `fetch` + `additionalPermissions: ['write']`; a profile with `fetch` disabled refuses it. → unit (`RegisterAllTools.test.ts`
      "advertises render_html_to_image on fetch+write, never on the browser
      permission" checks fetch-off, write-off, and browser-instead).
- [x] NOT gated by `permissions.browser.enabled`. → unit (`fetch`+`browser` alone does
      NOT advertise it, and `fetch`+`write` does without `browser`).

**Live smoke (Phase 2, recorded in PR)**
- [x] Write a simple HTML poster (neon text on dark background) → `render_html_to_image` → PNG saved. **Verified from a real bound-chat turn on this machine, 2026-10-03, on 0.16.77 after Reload Window:** `20261003-073651-xronia-polla-neon.png`, **900×532**, 173,030 bytes, result `Queued for 1 remote chat(s).` Inspected by eye: Greek lettering correct ("Χρόνια Πολλά!", accents and final sigma intact), cyan and magenta glows present, height is the content height (532) rather than the 400 px viewport.
- [ ] …→ Telegram photo arrives on the phone. **Awaiting the user's confirmation** — the harness can prove the queue accepted it, not the handset render it.
- [x] `full_page: true` with a tall layout (birthday invite shape) → correct aspect ratio. → live (`RenderHtmlLive.test.ts`, 3000 px content height).
- [x] HTML with `<img src="https://...">` → image is blocked (broken icon), render still succeeds. → live.
- [x] HTML referencing `http://127.0.0.1:8799/...` and `file:///C:/...` (in `<img>`, `<iframe>`, CSS `@import`) → nothing loads; a local test server records zero hits. → live.

### `send_file`

**Path resolution**
- [x] Workspace-relative path resolves and is sent. → unit (`SendFileTool.test.ts`
      "resolves and queues a workspace-relative path", fake notifications sink).
- [x] Path under `~/.forge/screenshots/<this-conversationId>/` allowed. → unit
      ("allows a path in this conversation screenshot directory").
- [x] Path outside workspace and outside screenshot dir → refused, naming the fix. → unit
      ("refuses paths outside both roots and names the allowed locations").
- [x] Path in a *different* conversation's screenshot dir → refused. → unit
      ("refuses another conversation screenshot directory").
- [x] **`conversationId` is `undefined` → screenshot dir is refused entirely** (no
      fallback to `'default'`). → unit ("does not fall back to the shared default
      screenshot directory without a conversation", plus the `it.each` over
      `Default`/`DEFAULT` and the `it.each` over `../../x`, `other/conv`, `default`
      conversation ids).
- [x] Directory or missing path → refused. → unit ("refuses missing paths and directories").
- [x] File over 50 MB → refused with size named. → unit ("refuses files over 50 MB and
      reports their actual size"; "accepts a file exactly 50 MB" pins the boundary).
- [x] **0-byte file → refused** (Telegram rejects empty uploads). → unit
      ("refuses a zero-byte file").

**Delivery**
- [x] With a watching chat: `Queued <name> for 1 remote chat(s).` → unit
      ("reports queued rather than sent when a chat is watching").
- [x] No chat bound: `No remote chat is watching this turn…` → unit
      ("reports when no remote chat is watching").
- [x] The send rides `state.tail` behind a preceding narration. → integration-shaped
      (`RemoteImageDelivery.test.ts` "send_file through the remote delivery chain":
      "queues the file behind the narration that preceded it").

**Gating**
- [x] In the `media` lazy group. → unit (`LazyToolGroups.test.ts`).
- [x] Not vision-gated. → unit (same test, both `isVisionModel` states).
- [x] Description contains "Send only files you created or the user asked for" — the
      soft guard against a prompt-injected secret exfiltration (Open question 2).
      → unit (`SendFileTool.test.ts` "includes the safety routing text in the definition").
- [x] Permission is `fetch`; a profile with `fetch` disabled refuses it. → unit
      (`SendFileTool.test.ts` "uses fetch permission without additional permissions" and
      `RegisterAllTools.test.ts` "advertises send_file only with the fetch permission").
- [x] **Per-turn cap: the 6th file delivery in a turn is refused**, counting both tools (cap of 5, the same number as `NOTIFY_TURN_LIMIT`). The budget lives in `UserNotificationService.deliverFile`, not in a tool closure. → unit
      (`UserNotification.test.ts` "queues up to the limit and refuses the next one,
      naming the reason" + "accepts exactly the limit under concurrent calls"; on the
      tool side `SendFileTool.test.ts` "refuses the sixth delivery in a turn using the
      shared service budget").
- [x] **Budget does not leak across turns:** spend it, call `resetTurn`, and the next `deliverFile` succeeds. → unit (CI-enforced row: `UserNotification.test.ts`
      "does not leak the file budget across turns"; `SendFileTool.test.ts` "resets the
      shared file budget for the next turn").
- [x] `generate_image` still uses unbudgeted `deliverImage` (it has per-call approval). → unit (`UserNotification.test.ts` "leaves deliverImage unbudgeted").

### `TelegramPhoto.ts` tweak (Phase 3)

- [x] A `.md` / `.txt` / `.pdf` goes straight to `sendDocument` (no `sendPhoto` attempt). → unit (`RemoteImageDelivery.test.ts` "goes straight to a document for a
      non-image extension, never calling sendPhoto").
- [x] An image ≤ 10 MB still uses `sendPhoto`. → unit (existing case, unchanged:
      "sends a photo when Telegram accepts it").
- [x] An image > 10 MB still falls back to `sendDocument`. → unit (existing case,
      unchanged: "goes straight to a document above the photo size limit").
- [x] A non-400 failure (401) still throws, not a document retry. → unit (existing case,
      unchanged: "throws on a non-400 failure instead of retrying as a document").

### Cross-cutting

- [x] `generate_image` description includes the routing hint ("use render_html_to_image for text-heavy graphics"). → unit (`GenerateImageTool.test.ts`
      "routes text-heavy graphics to render_html_to_image"). **Phase 2, not Phase 3** (the live smoke depends on it).
- [x] `generate_image` result says `Queued for N remote chat(s).`, not `Sent to`. → unit
      (`GenerateImageTool.test.ts` "saves with the returned format, snapshots before
      writing, and delivers remotely" asserts `Queued for 1 remote chat(s).`).
- [x] Owner decision on the `permissions.browser.enabled` un-gating: **approved** (2026-10-03). Recorded above.
- [x] CLAUDE.md rule amended to cover the render tool's local-only Chrome use. → the network rule in `CLAUDE.md` (Architecture Rules) now names `render_html_to_image` as the sanctioned exception to the browser gate: `setContent` only, headless system channel, JS disabled, context route abort-all plus `--host-resolver-rules=MAP * ~NOTFOUND`, so no `permissions.browser.enabled` and no per-origin approval.
- [x] `docs/OWNERS.md` has rows for both new modules. → checked (rows for
      `src/tools/sendFileTool.ts` and `src/tools/renderHtmlToImageTool.ts`).
- [x] `npm run ci` passes. Measured on this machine 2026-10-03: **exit 0, 3919 passed /
      40 skipped (3959), 385 files**, plus `build` and `check:bundle`. No `.ts` file in
      the gate's scope (`src`, `webview-ui`) passes 500 lines. **Both new modules and all
      five of their suites are under 500** (tool 374, sendFile 145, harness 171, rig 86,
      suites 402 / 232 / 66 / 186); `max-lines` runs only on `src` and `webview-ui`, and
      the pre-existing long test files are out of that scope.
- [x] `CHANGES.md` entry present. → 0.16.77 section.

### Live smoke (Phase 3, recorded in PR)

- [x] **The plan-doc use case (tool side):** `send_file` on `docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md` from a real bound-chat turn, 2026-10-03 on 0.16.77. Result: `Queued SEND_FILE_AND_RENDER_HTML_PLAN.md for 1 remote chat(s).` — which exercises the `TelegramPhoto` non-image early-exit (straight to `sendDocument`, no `sendPhoto` attempt).
- [ ] …→ the .md arrives as an openable document on the phone. **Awaiting the user's confirmation**, same reason as above.
- [x] **Shared budget, live from one turn (2026-10-03):** 5 deliveries queued across BOTH tools (1 poster + 3 renders + 1 `send_file`), and the 6th was refused with `the per-turn file delivery limit is already spent (0 left). Nothing was rendered.` Checked on disk afterwards: no 6th PNG and no `.forge-claim` residue, so the early check really did skip the browser, the write and the Undo entry.
- [x] **Path refusal, live:** `send_file` on `C:\Windows\win.ini` → `path must be in the workspace or this conversation's screenshot directory.`
- [x] **The HTML pipeline end-to-end:** a Greek birthday invite with neon glow rendered through real Chrome with `full_page: true`. Measured on this machine (2026-10-03, Chrome): `20261003-024738-render.png`, **900×514**, 109,077 bytes, non-blank (pixel-variance assertion), and the rendered PNG inspected by eye — Greek lettering correct ("Χρόνια Πολλά!", accents and final sigma intact), cyan and magenta glows present, height is the content height rather than the 400 px viewport. The Telegram leg of this row is the same one above: pending a phone-side check.

### Real-browser integration (replaces the two `→ integration` rows above)

`test/integration/RenderHtmlLive.test.ts` runs real headless Chrome and skips
with a reason where no browser is installed. Measured on this machine
(2026-10-03, Chrome): 4/4 pass.

- [x] Poster renders; default screenshot is exactly `width × height`. → live.
- [x] `full_page: true` → height = content height (3000 px), under the 16384 cap. → live.
- [x] `<img>`, `<iframe>` and CSS `@import` at a **real listening local server**:
  the render succeeds and the server records **zero hits**. → live.
- [x] `file://` `<img>` at a real red SVG on disk renders **byte-identical** to
  the same page pointing at a missing file — so nothing on disk is readable. → live.

### Codex review remediations (2026-10-03, MUST-FIX)

- [x] Same-title renders inside one second get different paths (`-2`), so a
  queued upload is never replaced. Asserted by reading each delivered path AFTER
  both renders. → unit.
- [x] A `full_page` page taller than the cap is refused BEFORE Chrome rasterises
  it. Asserted by order: `evaluate` ran once, `screenshot` zero times. The cap is
  measured on the document (`scrollHeight` — works under `javaScriptEnabled:false`,
  measured by probe 2026-10-03), not on the returned PNG. `checkPng` remains as a
  backstop. → unit.
- [x] An abort during a stalled launch returns promptly (< 1 s) instead of waiting
  out the 30 s deadline, and still closes a launch that resolves late. → unit.
- [x] An HTML file that grows past the cap between `stat` and `readFile` is
  refused by the post-read byte length. → unit (`RenderHtmlInputSizeRace.test.ts`).
- [x] Registration gate confirmed by review: `fetch` + `additionalPermissions:
  ['write']`, NOT `permissions.browser.enabled`. → unit (`RegisterAllTools.test.ts`).

### Claude verification remediations (2026-10-03)

Two MUST-FIX, seven NOTEs. All resolved except the two rows that can only be
checked on the phone after install, and the CI-has-no-Chrome limitation recorded
below.

- [x] **MUST-FIX: acceptance rows unticked.** Every row now names the test that
      covers it (test file + test name), instead of a bare `- [ ]`.
- [x] **MUST-FIX: a test file over 500 lines.** `RenderHtmlToImageTool.test.ts`
      was 508. Split at a real seam: input/rendering/cleanup stays there, output
      naming + atomicity + delivery moved to `RenderHtmlOutputDelivery.test.ts`
      (the only half that mocks the atomic writer). 348 / 200 lines.
      Note `lint` covers only `src` and `webview-ui`, so `max-lines` never runs
      on `test/` — the split is deliberate, not CI-enforced.
- [x] NOTE: the budget was checked only at `deliverFile`, so the 6th call in a
      turn launched Chrome, wrote a PNG and added an Undo entry before refusing.
      `remainingFileDeliveries()` is now consulted before the claim and the
      render. → unit ("refuses a spent file budget BEFORE launching a browser or
      writing anything", asserting zero launches, no delivery and no output
      directory; "renders normally while the budget still has room" pins
      `remaining: 1` and an absent probe).
- [x] NOTE: an abort after the screenshot could still queue a send. One abort
      check now sits immediately before the write, and the engine's `finally`
      close is an await — so the abort window is real and covered. A second check
      after the write would be unreachable (the write and the `deliverFile` call
      are synchronous back-to-back), so it was not added. → unit ("writes and
      sends nothing when the turn aborts after the screenshot returns", using a
      `closeGate` on the fake).
- [x] NOTE: the launch-error regex had a bare `launch` alternative, so any
      message containing that word was mislabelled "could not be launched" and
      sent the user to change `browser.channel`. Alternative dropped. → unit
      ("does not relabel a mid-render failure that merely contains the word
      'launch'").
- [x] NOTE: two hardcoded config fallbacks (`'chrome'`, `'generated-images'`)
      violated the no-literal-config rule. Now imported as `DEFAULT_BROWSER_CHANNEL`
      and `DEFAULT_IMAGE_OUTPUT_DIR` from the schema modules.
- [x] NOTE: throwaway probe script staged. `scripts/measure-probe.js` deleted.
      `scripts/llama_sglang_watch.py` is unrelated to this branch and is NOT
      staged — files are staged by name.
- [x] NOTE: `deliverFile` refusal still handled after the render (budget spent
      between the early check and the send) → unit ("keeps the PNG and names the
      refusal when the shared budget is spent").
- [x] NOTE: the write is synchronous (`writeFileAtomicSync`), which blocks the
      extension host for up to 10 MB plus an fsync. Accepted deliberately: the
      atomic-write owner exposes no async variant, and hand-rolling one would
      duplicate the fsync and the Windows EPERM/EBUSY rename-retry it already
      implements. The 10 MB PNG cap bounds the stall.
- [ ] **LIMITATION, not a defect: `npm run ci` verifies no real rendering.**
      `RenderHtmlLive.test.ts` skips cleanly where no browser is installed, so a
      CI runner without Chrome passes with zero real renders. The size and
      full-page rows are therefore verified by the local live run (4/4 on this
      machine, 2026-10-03) plus the 900×514 poster smoke — not by CI. Left as a
      known limitation rather than installing Chrome on the runners.
