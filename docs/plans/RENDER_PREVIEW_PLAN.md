# `render_html_to_image` preview mode — let the agent see the page it wrote (2026-10-07)

## Problem

A bench build of a single-file three.js scene shipped with every voxel white.
The cause was one line: the voxel builder kept a shared white material from an
abandoned per-instance-colour design. The agent verified the build twice, both
times by counting (`colour groups for SOLID: 94`, `visible meshes: 176`) in
Node. Both counts were correct; nothing ever looked at a pixel. One screenshot
would have shown a white scene.

Forge has a renderer, but it cannot show such a page:

- `render_html_to_image` runs with JavaScript disabled and every request
  blocked. A canvas/WebGL page renders blank.
- Its description says "JavaScript and external resources are not supported",
  so a model with a JS page correctly concludes the tool does not apply.
- It sits in the lazy `media` group. Across every bench session the model loaded
  `files` 6 times, `agents` once, `media` never. The group menu shows tool names
  only, and nothing in the name says "check my page".
- It requires `permissions.net.fetch`; the bench config has it off, so the tool
  was not even advertised there.
- Every render is delivered to the remote chat. A preview loop would push
  each iteration to the user's phone and spend the per-turn file budget.

The browser tool family can render such a page, but it is off by default and
asks for approval per origin, so it cannot serve unattended runs, and it is the
wrong weight for "show me what I just wrote".

## Measured before planning (2026-10-07)

Probe: headless system Chrome, HTML passed via `setContent` (no `file://`
origin), JavaScript on, requests allowed only to `cdn.jsdelivr.net`,
`cdnjs.cloudflare.com`, `unpkg.com` — enforced both by a context route and by
`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE <host>…`. Four single-file
three.js scenes, 6 s settle time.

| | Default GPU path | Software (`--use-angle=swiftshader`) |
|---|---|---|
| WebGL renderer | ANGLE D3D11 on the real GPU | SwiftShader |
| Wall time incl. 6 s settle | 6.3–6.9 s | 9.5–17.3 s |
| Page errors | none | none |

- Headless Chrome picks the real GPU by default; SwiftShader is the fallback on
  a GPU-less machine and still renders.
- The white-scene build is unmistakably white in the preview.
- Hostile page, scripts on: `https://example.com`, `http://127.0.0.1:8799`
  (Forge's own control server) and `file:///C:/Windows/win.ini` were all
  blocked; a fetch to the allowlisted CDN succeeded, as intended.
- Found during implementation (second probe, same day): the context route
  does not see WebRTC. A page's `RTCPeerConnection` with
  `stun:127.0.0.1:<port>` delivered 5 UDP datagrams to a loopback socket.
  `--webrtc-ip-handling-policy=disable_non_proxied_udp` brought it to 0 (two
  runs each). WebSocket, EventSource and `sendBeacon` to `127.0.0.1` and
  `localhost` opened 0 TCP connections with or without the flag.

## Decision

Extend `render_html_to_image`; no new tool. One owner for HTML rendering
(`docs/OWNERS.md`), one schema in the tool list, the launch/abort/timeout
machinery reused.

### Schema

Add one enum, keep everything else:

```
mode: "image" | "preview"   (default "image")
wait_ms: integer            (preview only; default 3000, 0–15000)
```

- **`image`** — today's behaviour, byte for byte: JS off, all requests blocked,
  PNG saved under `generated-images/`, delivered to the remote chat, file budget
  spent. Its existing hardening tests are not touched.
- **`preview`** — for checking a page the agent wrote:
  - `path` only (a workspace `.html` file); `html` is refused, so the preview
    shows the file on disk, not a re-typed copy of it.
  - JavaScript on.
  - Requests: `GET` over `https:` to the allowlisted script CDNs only
    (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`). Everything else
    aborts at the context route, and DNS for every other host is mapped to
    NOTFOUND as the second wall. Still `setContent`, never navigation, so no
    `file://` origin and no disk reads. Relative assets (`./tex.png`) therefore
    do not load — stated in the description.
  - Waits `wait_ms` after `load`, then screenshots the viewport.
  - **Nothing saved, nothing delivered, no file budget.** The result goes to the
    model only.
  - Result: text — page errors and console errors (first 10, truncated), the
    hosts it blocked, viewport size, elapsed time — plus the PNG as an
    `image_url` content part when the active model has vision. A non-vision
    model still gets the error list, which is the part that catches a boot
    crash. No pixel heuristics in the result text: a "colour count" invites the
    model to reason about a number instead of looking.

The allowlist is a constant in `renderEngine.ts`, not config: it is a security
boundary, and a config field would make "allow everything" one edit away.

### Gating

- Permission: unchanged, `fetch` + `write`. Preview mode's only outbound
  traffic is CDN script `GET`s, which is fetch-class traffic. (The `write`
  requirement stays because the tool is one definition; preview writes nothing.)
- No approval: same as today. The allowlist plus DNS mapping is what makes that
  safe, and it is what the new tests pin.
- No vision gate on the tool; the handler omits the image part for a non-vision
  model. If `ToolContext` has no vision flag today, add one from the same source
  `ToolRegistry`'s `requiresVision` gate uses — do not re-derive it.

### Advertising

- Move `render_html_to_image` out of the lazy `media` group into the eager set,
  with a comment in `lazyToolGroups.ts` like the `delete_file` / `git_read`
  ones. Rationale: the "10+ calls" promotion rule cannot promote a tool that was
  hidden and described as not applying; its zero is a measurement of the hiding.
  Cost: ~300 schema tokens per turn, and one cold re-prefill when the tool list
  changes at upgrade.
- Description gains one routing line: use `mode: "preview"` to check that a
  page you wrote (canvas, WebGL, three.js, animation) actually renders before
  you call it done. The "JavaScript not supported" sentence is scoped to
  `image` mode.
- `send_file`'s description says it requires the `media` group; it still does.
  `generateImageTool`'s pointer to `render_html_to_image` stays valid.

### Residual risk (stated, not hidden)

With scripts on, a page can encode data in a request path to an allowlisted
CDN (`cdn.jsdelivr.net/npm/<data>`), which lands in that CDN's logs. The page is
one the agent wrote, and the agent's shell already reaches the network more
directly, so this adds no capability the agent lacks — but CLAUDE.md's network
section must say "preview mode may fetch scripts from these three CDNs", not
"reaches neither the network nor the local disk".

## Files touched

| File | Change |
|---|---|
| `src/tools/renderHtml/renderEngine.ts` | shared launch/abort/timeout helper; `renderPreview`: JS on, allowlist route, DNS rules with `EXCLUDE`s, WebRTC UDP policy, settle wait, collect page/console errors and blocked hosts |
| `src/tools/renderHtml/previewMode.ts` (new) | preview branch: input checks, result text, vision-gated image part; no save, no delivery |
| `src/tools/renderHtml/htmlInput.ts` (new) | size cap, file read, viewport bounds — moved out of the tool so both modes share them |
| `src/tools/renderHtmlToImageTool.ts` | `mode` / `wait_ms` schema, mode dispatch, description |
| `src/tools/lazyToolGroups.ts` | remove from `media`, comment |
| `CLAUDE.md` | network section: preview-mode exception |
| `test/unit/RenderHtmlToImageTool.test.ts` | preview args/route/no-delivery/no-write cases; image-mode cases unchanged |
| `test/integration/RenderHtmlLive.test.ts` | real-Chrome preview cases (below) |
| `test/unit/LazyToolGroups.test.ts` | membership update |

The preview branch would have pushed `renderHtmlToImageTool.ts` past 450
lines, so it split on the seam named here before implementation: "deliver a
saved PNG" (the tool file) versus "return a preview" (`previewMode.ts`), with
the input checks both use in `htmlInput.ts`. Two `docs/OWNERS.md` rows added.
The tool file stays at ~375 lines because image mode's policy (name claim,
atomic write, delivery) is one concern.

## Phases

1. Engine + tool preview branch + unit and live tests.
2. Eager advertising + description + CLAUDE.md.
3. Bench: rerun the pagoda task, with two config changes applied to **both**
   harnesses so neither gains a capability the other lacks:
   - **Web fetch on.** Preview requires `net.fetch`; the bench had fetch off
     for Forge and `webfetch: deny` for the compared harness. Both are opened
     together.
   - **Vision declared.** The bench's `strata` entry lists
     `[tool-call, long-context]`, so Forge's vision gate refuses images even
     though Strata runs a vision encoder (the user's main config already lists
     `vision`). Add `vision` to the Forge bench entry and the matching image
     input modality to the compared harness's model entry. Verify with one
     image request to Strata while it is idle before the run.
   Evidence the demand is real: the 0.16.90 baseline run, unprompted, wrote a
   Node software rasteriser (`_preview.js`, zlib PNG of its own voxel data),
   loaded the `media` group and called `view_image` on the result — refused,
   because the bench model entry declares no vision.
   Record whether preview was called and what it changed. One run is an
   anecdote; three reruns before any claim.

## Out of scope

- Preview of multi-file pages with relative assets.
- Animated capture (GIF/video) — already a separate follow-up in
  `SEND_FILE_AND_RENDER_HTML_PLAN.md`.
- Interaction (clicking the page's buttons). That is the browser tool family.
- Prompt-template lines telling the model to preview. The description carries
  it; a template line costs every turn, visual or not.

## State × lifecycle ledger

Preview mode adds no durable state: it saves no PNG, takes no name
reservation, queues no delivery and spends no file budget. The `image` mode rows
in `SEND_FILE_AND_RENDER_HTML_PLAN.md` are unchanged. The one artifact preview
creates is transient:

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Headless browser process (preview call) | `render_html_to_image` handler, per call | `browser.close()` in the existing `finally` | n/a — nothing to pause; the call is one render | Nothing is written; a crash mid-render leaves no file | Playwright pipe close ends the child, as for `image` mode; a hard kill can orphan it, accepted as in the existing ledger | Bounded by the existing render timeout, which must cover `wait_ms` + load (15 s max wait) |
| Preview result (text + image part) | Returned from the handler into the turn | Ends with the conversation/compaction like any tool result | n/a | n/a — in memory | Lost with the host, like any in-flight tool result | None |

**CI-enforced row:** a unit test calls preview mode and asserts zero
`beforeMutate` calls, zero filesystem writes under the output dir, zero
`deliverImage`/`deliverFile` calls, and an unchanged file budget. A later change
that starts saving or sending previews fails it.

## Acceptance criteria

- `mode` omitted or `"image"`: every existing render test passes unchanged,
  including the exact hardened-args assertion with no `EXCLUDE`.
- Preview launch args are the hardened args with the resolver rule replaced by
  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE cdn.jsdelivr.net, EXCLUDE cdnjs.cloudflare.com, EXCLUDE unpkg.com`,
  plus `--webrtc-ip-handling-policy=disable_non_proxied_udp`, with no
  `localhost` and no quote characters.
- Preview refuses `html` input and names `path` as the fix.
- Live (real Chrome), preview mode:
  - a page whose script requests a local test server (fetch, img, WebSocket,
    EventSource, beacon, WebRTC STUN) records **zero TCP connections and zero
    UDP datagrams**;
  - a page fetching `file://` loads nothing;
  - a page importing `three` from `cdn.jsdelivr.net` renders a non-blank WebGL
    canvas (skips with a reason when offline, never fails silently);
  - a page that throws at boot returns the error text in the result.
- Preview with a non-vision model returns text only; with a vision model, text
  plus one PNG content part.
- The no-durable-state test above passes.
- `render_html_to_image` is advertised without `load_tool_group`; `media` no
  longer lists it.
- CLAUDE.md's network section describes the preview exception and its residual
  risk.
- `npm run ci` and `npm run package` green.
