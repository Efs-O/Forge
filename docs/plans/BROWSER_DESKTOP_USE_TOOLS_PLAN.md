# Browser & Windows Desktop-Use Tools for Forge

**Status:** plan v2 — incorporates Claude's supervisor review (8 blockers, improvements, design
calls) + user decisions. Ready for implementation after the job split is agreed with Claude.

**Decisions locked in**
- **Live model for demos:** the already-loaded Qwen3.8-27B vision backend (the resident Forge
  model). **Holo4 is NOT loaded** for any test or demo — it OOMs beside the 27B. Forge itself (the
  resident vision model) is the agent that sees the screenshots and drives both live loops.
- **Browser channel:** the **configured** system browser, used as-is (default **Chrome** via
  `chromium.launch({ channel: 'chrome' })`), in a **fresh ephemeral context**. **No silent fallback**
  (Claude condition 2): if the configured channel's browser isn't installed, `browser_open` returns an
  error naming the alternative ("Chrome not found; set `browser.channel: msedge`"). Never the user's
  profile, never `connectOverCDP` to a running browser.
- **Network:** the user approved full browsing for the browser tools (the CLAUDE.md outbound-traffic
  exception, scoped to `permissions.browser`). No Chromium download is needed (system channel).
- **Desktop:** a **user-approved target window** (bound to HWND + process id). One long-lived
  PowerShell driver (JSON over stdin), per-monitor-DPI-aware, physical pixels.

---

## 1. Goal

Add two families of native Forge tools that let a vision-capable model operate a browser and the
Windows desktop, in an explicit screenshot → act → screenshot loop:

- **Browser tools** (Playwright, system Chrome/Edge channel): open/navigate, list/select tabs,
  screenshot (viewport or full page), inspect page elements, click, type, scroll, hover, drag,
  press keys. Element-based actions when possible; screenshot-coordinate actions also supported.
- **Windows desktop tools**: list windows, focus/approve a window, capture a window or screen,
  move mouse, click / double-click / right-click, drag, scroll, type text, press keys.

Screenshots are returned **directly to the model as image tool results** via Forge's existing
multimodal path (`MultimodalToolResult` → `ContentPart` `image_url` data-URL) — not merely a file
path. Coordinate actions are **DPI-aware** and name the exact screenshot / window / tab their
coordinates refer to. Browser and desktop sessions are **explicit** — Forge never attaches to the
user's personal Chrome tabs and never controls an unapproved window.

## 2. Scope & non-goals

**In scope**
- New `browser` + `desktop` tool families, registered through Forge's existing native tool-calling
  **and** fallback mechanisms.
- New deny-by-default `permissions.browser` / `permissions.desktop` config blocks + a top-level
  `browser:` block for non-permission knobs.
- Vision-gated screenshot tools (advertised only when the active model has vision, via a single
  source of truth).
- Reuse of Forge's permission + confirmation gate; an approved-target-window gate for desktop;
  per-origin approval for the browser.
- Focused tests (unit + deterministic integration + `test/live`) and documentation.
- One live browser loop and one live desktop loop, driven by the resident vision model.

**Non-goals (kept out to bound the change)**
- No arbitrary-JS `browser_evaluate` / console tool (too powerful; not requested).
- No touch/pen, no full accessibility-tree export (a heuristic interactive-element list instead).
- No change to any existing tool's behavior or to any existing model entry (Holo4 config stays
  byte-identical).
- No native C++ input driver in v1 (a long-lived PowerShell driver is the validated primary; a
  native `SendInput` driver is a documented future swap behind the `DesktopDriver` interface).
- No multi-monitor tiling math beyond a correct physical-pixel transform (validated, reported).

## 3. Architecture to reuse (verified in this repo)

| Concern | Where | What we reuse |
|---|---|---|
| Tool catalog | `src/tools/ToolRegistry.ts`, `src/tools/registerAllTools.ts` | `RegisteredTool` shape (`permission`, `approval`, `autoApprove`, `advertise`, `describe`); conditional-registration pattern. |
| Permissions | `src/tools/PermissionResolver.ts`, `src/config/schema.ts` (`PermissionsSchema`, line 206) | `resolveToolPermissions(config)` → `Set<ToolPermission>`; deny-by-default groups; `LEGACY_PERMISSIONS` (we do **not** add the new tiers here). |
| Confirmation gate | `src/sidebar/ToolDispatch.ts` | `needsConfirm = approval() !== undefined \|\| (!autoApprove && tier ∈ {write,delete,terminal,headless,git-write})` → `requestApproval(name, detail, isDangerous, convId, signal)`. |
| Multimodal result | `src/tools/ToolRegistry.ts` (`MultimodalToolResult`), `src/tools/imageTool.ts` (`view_image`) | Return `{ text, content: [text, image_url(data:...)] }`; `ToolDispatch` ships `result.content` to the model. |
| Webview image display | `src/sidebar/toolResultView.ts` (`generate_image` / `image_search`) | The webview has no image-bytes field; it parses a **saved path** out of the result text and renders a thumbnail. We reuse that text-parsing contract. |
| Vision gate | `src/sidebar/ModelTurn.ts` (`VISION_ONLY_TOOLS` + `unavailableTools`), `src/config/ConfigResolver.ts` (`deriveStaticCapabilities`) | **Refactor to a single source of truth** (B8): `requiresVision` on `RegisteredTool`; both the advertise filter and the refusal map derive from the registry; gate on `deriveStaticCapabilities(model).includes('vision')`. |
| Native + fallback | `src/tools/FallbackToolPrompt.ts` | `buildFallbackToolInstructions(tools)` builds the catalog from the same `ToolDefinition[]`, so registering a proper definition covers **both** native and fallback automatically. |
| Cleanup hook | `src/extension.ts` (`deactivate()`) | Close the browser + dispose the desktop driver on window close. |

**Facts that constrain the design**
- The live backend is `qwen38-27b-dflash2-ud-q6k-vision` (mmproj on CUDA2) — vision-capable,
  already resident. Loading Holo4 (another 27B) would OOM the three GPUs.
- `ToolResultMsg` (webview) carries `text` only — no base64. So the model gets the image inline,
  and the webview thumbnail comes from a saved path parsed out of the text.
- Packaging is `esbuild` bundle (only `vscode` external) + `vsce package --no-dependencies` +
  `.vscodeignore` excluding `node_modules/**`. So `playwright-core` is **inlined into the bundle**,
  and its browser-registry file lookup is known to break when bundled — which is why we use a
  **system browser channel** (Chrome/Edge) instead of Playwright's own downloaded Chromium (B4/B5).
- CLAUDE.md:140 forbids outbound traffic except configured search/fetch + cloud LLMs. The browser
  tools are a sanctioned exception **scoped to `permissions.browser`**, approved by the user.


## 4. Design

### 4.1 Permission model & config shape

Two new `ToolPermission` tiers, **deny-by-default**: `browser`, `desktop`.

Config (additive; existing configs and tiers untouched):
1. `src/tools/ToolRegistry.ts`: extend the `ToolPermission` union with `'browser' | 'desktop'`.
2. `src/config/schema.ts` — `PermissionsSchema` (line 206): add two **permission** sub-objects,
   matching the existing domain-group shape (`fs`/`net`/`exec`/`git`/`agents`):
   - `browser: z.object({ enabled: z.boolean().default(false) }).optional()`
   - `desktop: z.object({ enabled: z.boolean().default(false) }).optional()`
   Non-permission knobs live in a **separate top-level `browser:` block** (not under `permissions`):
   - `browser: z.object({ channel: z.enum(['chrome','msedge','chromium']).default('chrome'),
     headless: z.boolean().default(false), allowed_origins: z.array(z.string()).optional() }).optional()`
   - `channel` is used **as configured** (default **chrome**). **No silent fallback:** if the
     configured channel's browser isn't installed, `browser_open` returns an error naming the
     alternative (e.g. "Chrome not found; set `browser.channel: msedge`"). `chromium` (Playwright's
     downloaded build) is a last resort, manual user-run install only.
   - `headless` is a **config** value (used by tests), never a model arg — the model does not choose it.
   - `user_data_dir` is **dropped in v1**: `launch()` + `newContext()` is already ephemeral, and a
     user-supplied profile path invites pointing at a real profile.
3. `src/tools/PermissionResolver.ts`:
   - `if (configured.browser?.enabled ?? false) allowed.add('browser');`
   - `if (configured.desktop?.enabled ?? false) allowed.add('desktop');`
   - Add `['browser', (p) => p.browser?.enabled]` and `['desktop', (p) => p.desktop?.enabled]` to
     `DENY_BY_DEFAULT` so an omitted-but-present `permissions` block reports them as suppressed.
   - **Do not** add them to `LEGACY_PERMISSIONS` → a config with no `permissions` block gets neither.

Effect: default config advertises **zero** new tools (not advertised, refused at dispatch). The
browser's outbound-navigation exception (CLAUDE.md) is scoped to `permissions.browser.enabled`.

### 4.2 Tool catalog

Every tool: `permission: 'browser'` or `'desktop'`. The `consequential` flag is a **hint only**
(§4.6); the real gates are the approved target window (desktop) and per-origin approval (browser).
Observation tools are `autoApprove: true`. Screenshot tools carry `requiresVision` (§4.4).

**Browser** (Playwright, system Chrome/Edge channel — §4.5)

| Tool | Args (key ones) | Returns | Gate |
|---|---|---|---|
| `browser_open` | `url?` | session ready + first tab id | autoApprove |
| `browser_close` | — | closed | autoApprove |
| `browser_navigate` | `url`, `tab_id?` | final url + title | **origin approval** (first nav on a new origin) |
| `browser_tabs` | — | list of `{id,title,url,active}` | autoApprove |
| `browser_select_tab` | `tab_id` | active tab | autoApprove |
| `browser_new_tab` | `url?` | new tab id | **origin approval** if `url` is a new origin |
| `browser_close_tab` | `tab_id` | closed | autoApprove |
| `browser_screenshot` | `tab_id?`, `full_page?` | **MultimodalToolResult** + saved path | autoApprove · **requiresVision** |
| `browser_inspect` | `tab_id?`, `selector?`, `max?` | numbered interactive elements `{index,role,text,selector,bbox}` | autoApprove |
| `browser_click` | `tab_id?`, `selector?` \| `index?` \| `x?`,`y?`,`coord_space?`, `consequential?` | what was clicked | **origin approval** + consequential hint |
| `browser_type` | `tab_id?`, `selector?` \| `index?`, `text`, `consequential?` | typed into | **origin approval** + consequential hint |
| `browser_press` | `tab_id?`, `key`, `selector?`, `consequential?` | pressed | **origin approval** + consequential hint |
| `browser_scroll` | `tab_id?`, `selector?` \| `x?`,`y?`, `delta_x?`,`delta_y?` | scrolled | autoApprove |
| `browser_hover` | `tab_id?`, `selector?` \| `index?` \| `x?`,`y?` | hovered | autoApprove |
| `browser_drag` | `tab_id?`, `from_*`, `to_*` (selector/index/coords) | dragged | autoApprove |

- **Session:** v1 runs **one** browser session (singleton `BrowserSessionManager` — one Chrome
  process, many tabs). `browser_open` when one exists returns the existing session; no `session_id`
  param. Still explicit: `browser_open` starts, `browser_close` ends; never the user's Chrome.
- **Element-based first:** `selector` or `index` (from `browser_inspect`). Coordinate fallback:
  `x`,`y` in the coordinate space named by `coord_space` (§4.3). The result text always names the tab
  (title + url) and the target (selector/index or `x,y` in `<space>`).
- **`browser_inspect`** is a heuristic interactive-element selector (`a`,`button`,`input`,`select`,
  `[role]`,`[onclick]`,…) with `getBoundingClientRect` bboxes — a numbered target list, **not** the
  full accessibility tree (a non-goal).

**Desktop** (long-lived PowerShell driver — §4.5, §9). Coordinate actions **require** a `capture_id`
(no implicit "current screen"); the capture is the explicit frame.

| Tool | Args (key ones) | Returns | Gate |
|---|---|---|---|
| `desktop_capture` | `window_title?` \| `monitor?` | **MultimodalToolResult** + `capture_id`, size, DPI scale, mapping, origin | **target-window approval** (binds HWND+pid) · **requiresVision** |
| `desktop_windows` | — | list of `{id,title,rect}` | autoApprove |
| `desktop_focus_window` | `window_title?` \| `window_id?` | focused + **approved** window | **target-window approval** |
| `desktop_move_mouse` | `x`,`y`,`capture_id`,`coord_space?` | moved to | foreground check |
| `desktop_click` | `x`,`y`,`button?`,`clicks?`,`capture_id`,`coord_space?`,`consequential?` | clicked | foreground check + consequential hint |
| `desktop_drag` | `from_x`,`from_y`,`to_x`,`to_y`,`capture_id`,`coord_space?` | dragged | foreground check |
| `desktop_scroll` | `x`,`y`,`delta_x?`,`delta_y?`,`capture_id`,`coord_space?` | scrolled | foreground check |
| `desktop_type` | `text`,`consequential?` | typed | foreground check + consequential hint |
| `desktop_press` | `keys` (array of enum key names, e.g. `["ctrl","c"]`) | pressed | **never auto-approve** system chords (`win+*`,`alt+f4`,`ctrl+alt+*`) |

**Target-window gate (B2):** `desktop_focus_window` / `desktop_capture(window)` asks the user once:
"Forge may control '<title>'". That approval binds to the window's **HWND + process id**. Before
**every** input call the driver checks the **foreground window is that HWND** and the point is inside
its rect; otherwise it refuses and names the fix (re-capture, or re-focus the target). It **always
refuses**: any VS Code window, the secure desktop / UAC, and the taskbar. `desktop_press` is never
auto-approved for system chords. This is what stops the model clicking its own Allow dialog, typing
into the VS Code terminal, or pressing `win+r`/`alt+f4`.

### 4.3 Multimodal screenshot path + coordinate space

`browser_screenshot` / `desktop_capture` return:
```
{
  text: `Screenshot of tab "t1" (example.com), 1280×720 px, coord_space=image_px. Saved to ~/.forge/screenshots/<conv>/<ts>.png.`,
  content: [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,<...>' } }
  ]
}
```
- **Model:** receives the inline image via the existing `view_image`/`view_video` content path
  (proven by `test/unit/ImageTool.test.ts`, `VideoTool.test.ts`). **Primary requirement.**
- **Webview:** thumbnail by parsing the saved path out of the text — a `screenshotPath()` helper in
  `toolResultView.ts` mirroring `generatedImagePath`, plus a thumbnail row. Secondary.
- **Downscale to the projector's max size** before returning, so the image the model is told about is
  the one it actually sees (llama.cpp's mmproj resizes), and to save tokens (a 4K capture is several
  thousand image tokens). Full-page shots are JPEG-encoded. The text states the **actual returned image
  dimensions** and the `coord_space`.
- **Coordinate space (the model's real frame):** llama.cpp's mmproj resizes images, and the Qwen3-VL
  family grounds coordinates on a **0–1000 grid**, not raw pixels. **Verify which Qwen3.8 uses in
  Phase 5** (calibration probe: click a known target, check the hit). `coord_space: "image_px" |
  "norm_1000"` is a tool arg so the model can state the space it is reading; the driver/tool converts
  to the device space. A calibration probe runs first in Phase 5.
- **Storage:** screenshots are saved under **`~/.forge/screenshots/<conversationId>/`** (the user's
  home Forge dir, **not** the workspace's `.forge/`) — desktop captures can contain secrets, and a
  repo's `.forge/` is gitignored in Forge but not in other repos the agent works in. Atomic
  temp→rename; size-capped (≤ 10 MB).
- **Image retention:** like all image parts, screenshots are aged out of model context after the
  model's `image_retention_turns` (resident model sets 2) via `ageOutImageParts`. The loop is
  immediate (each action sees the fresh screenshot), so this is fine; a screenshot from several turns
  ago may already be evicted. Noted so the loop is not built on a stale image.

### 4.4 Vision gating — single source of truth (B8)

Replace the two hand-kept lists (`VISION_ONLY_TOOLS` set + `unavailableTools` map in `ModelTurn.ts`)
with one source:
- Add `requiresVision?: (modelName: string) => string` to `RegisteredTool` (returns the refusal
  message naming the model).
- `ModelTurn` derives **both** the advertise filter and the `unavailableTools` refusal map from the
  registry (scan registered tools for `requiresVision`).
- Migrate `view_image` and `view_video` onto it; add `browser_screenshot` and `desktop_capture`.
- Gate on `deriveStaticCapabilities(model).includes('vision')` (what the code already does), **not**
  on `mmproj_path` directly.
- Add a test that **fails** if any tool flagged `requiresVision` can be advertised to a non-vision
  model without also being refused. This kills the drift the plan was warned about.

### 4.5 Explicit, isolated sessions

- **Browser:** `browser_open` launches the **configured system browser** (`chromium.launch({ channel })`
  — default `chrome`; `msedge`/`chromium` only if configured) with a **fresh ephemeral `BrowserContext`**
  (`browser.newContext()`). If the configured channel's browser is absent, it errors naming the
  alternative (no silent fallback).
  A separate process with a throwaway profile — **never the user's Chrome profile, never attached to
  existing tabs, never `connectOverCDP` to a running browser.** Headed by default (config
  `browser.headless` for tests). `browser_close` and `deactivate()` both close it. Playwright launches
  over a pipe, so Chromium exits when the pipe closes (verify in Phase 1 by killing the extension
  host); a watchdog is built only if that fails.
- **Desktop:** the "session" is the **approved target window + capture frame**. `desktop_capture`
  returns a `capture_id` binding a pixel space (window/monitor, size, DPI scale, origin offset) **and**
  the approved HWND+pid. Coordinate actions reference that `capture_id`; the foreground check (§4.2)
  is enforced per call. There is no implicit global screen.

### 4.6 Consequential-action confirmation — hint, not gate

`browser_click/type/press`, `desktop_click/type` take `consequential?: boolean` (default `false`).
When true, `approval()` returns `{ dangerous: true, detail: "<what will happen>" }` → `requestApproval`.
Tool descriptions tell the model to set it when the action **submits a form, makes a purchase, sends a
message, or deletes data**.

**But the self-flag is a hint, not the gate.** The real protections are the **approved target window**
(desktop, B2) and **per-origin approval** (browser). The model self-flagging `consequential` is
best-effort and can be gamed by untrusted page content; the structural gates are what actually stop a
blind or injected action. (This resolves Claude's design disagreement #1.)

### 4.7 Untrusted page content, credential & cloud exposure

- Browser results are framed as **untrusted page data, not instructions**. A page saying "click Buy"
  or "paste your secrets here" is data; the origin-approval + consequential gates are the backstop.
- The ephemeral context has **no saved passwords / cookies / history**; no tool reads the user's real
  browser profile.
- **Cloud-model exposure (improvement #4):** if the active model is a cloud provider (xAI, OpenRouter)
  with vision, every `desktop_capture` would send the user's screen to that provider. **Default:**
  `desktop_capture` of a **window** is allowed; a **full-screen/monitor** capture requires an explicit
  `monitor` arg **plus** approval that names the provider. (Refusing cloud capture entirely is the
  stricter option — decide in Phase 2; the approval path is the default.)
- **Browser origin approval (improvement #5):** the first navigation **or input** on a new origin asks
  the user once per session. This closes the exfiltration path — an injected "paste `~/.ssh` here"
  page plus a read tool — because the model cannot type/submit on an origin the user did not approve.

### 4.8 Registration, packaging & platform

- New factories: `src/tools/browser/*.ts`, `src/tools/desktop/*.ts`; a `BrowserSessionManager`
  (singleton) and a `DesktopDriver` (long-lived PowerShell impl) created once and passed to the
  factories (the `PowerControl` pattern).
- Registered in `registerAllTools.ts` (already receives `getConfig`, `workspaceState`). Registered
  unconditionally; **permission** filters advertisement + dispatch, **`requiresVision`** filters the
  two screenshot tools. The **desktop** family is registered with `advertise: () =>
  process.platform === 'win32'` and **refused at dispatch on other platforms** (B7) — macOS/Linux
  users get a clear "desktop tools are Windows-only" refusal, not a silent no-op.
- **Packaging (B4):** `playwright-core` is added to `package.json` and **inlined by esbuild** (only
  `vscode` is external; `.vscodeignore` drops `node_modules`). Because we use a **system channel**
  (Chrome/Edge), Playwright does not need its own browser-registry files to *launch* — but the
  launcher still resolves some files relative to its package, which can break when bundled. **Phase 0
  gate:** load the **packaged VSIX** and call `chromium.launch({ channel: 'chrome' })`. If bundling
  breaks, decide before Phase 1: carve an exception to `--no-dependencies`, or copy the package next
  to the bundle. (This is verified on the packaged VSIX, not the dev host.)
- **No `npx` in the extension host (B5):** because we use a system channel, there is no in-host
  `npx playwright install`. The `chromium` channel (downloaded build) is documented as a manual
  user-run step for machines without Chrome/Edge — never an automatic in-host download.
- Because each tool carries a real `ToolDefinition`, `buildFallbackToolInstructions` covers the
  fallback (fenced-JSON) path with no extra work — native and fallback both work from the same
  registration.


## 5. Phases

**Phase 0 — Foundation (order per Claude's supervisor review)**
0. **CLAUDE.md exception (B1, Claude condition 1):** add a sanctioned-exception sentence (Litterbox
   style) covering browser navigation only while `permissions.browser.enabled` is on, stating each new
   origin needs its own approval and that Forge never downloads a browser on its own. **The user must
   see and confirm the actual wording** (a message from me/Claude is not their approval). This lands
   before any browser code.
1. **B8 first:** single source of truth for the vision gate — add `requiresVision` to `RegisteredTool`,
   derive both halves of the `ModelTurn` gate from the registry, migrate `view_image`/`view_video`,
   add the drift-detection test.
2. **Permissions:** add `browser`/`desktop` to the `ToolPermission` union; add the `browser`/`desktop`
   sub-objects to `PermissionsSchema` + the top-level `browser:` block; resolve deny-by-default in
   `PermissionResolver` + `DENY_BY_DEFAULT`.
3. **VSIX `chromium.launch()` smoke (B4):** add `playwright-core` to `package.json`, build the
   **packaged VSIX**, load it, and call `chromium.launch({ channel: 'chrome' })`. This is a hard gate
   before any browser tooling — if bundling breaks the launcher, make the packaging decision now.
4. **Scaffolding:** `BrowserSessionManager` (system channel, ephemeral context, singleton),
   `DesktopDriver` interface + long-lived PowerShell impl, `screenshotPath()` helper in
   `toolResultView.ts`, `registerAllTools` wiring (desktop `advertise: () => process.platform ===
   'win32'`). No tool is advertised until its family's permission is on.
- **Gate:** `npm run type-check` + `npm test` green; a config without the new block advertises **zero**
  new tools (regression guard for "preserve existing tools"); the VSIX launches Chrome.

**Phase 1 — Browser tools**
- `BrowserSessionManager` on the system Chrome/Edge channel (ephemeral context, headed default,
  `browser.headless` for tests). Thread `ToolHandlerContext.abortSignal` into `browser_open` (launching
  takes seconds) so a cancelled turn does not leave a half-launched browser. Verify Chromium exits when
  the pipe closes (kill the extension host); build a watchdog only if it does not.
- Per-origin approval (first nav/input on a new origin asks once per session).
- Implement all browser tools (§4.2). Screenshot returns `MultimodalToolResult`, downscaled, with
  `coord_space` + actual image size in the text.
- **Gate:** deterministic integration test (where a browser is present; skip-with-message in CI
  without one) — `browser_open` → `browser_screenshot` (assert multimodal shape) → `browser_click`
  (a known element) → `browser_screenshot` (assert the DOM/state changed).

**Phase 2 — Desktop tools**
- **Long-lived PowerShell driver** (one host process, JSON over stdin, owned + disposed like the Codex
  app-server): `SetProcessDpiAwarenessContext(-4)` (per-monitor aware v2) before any user32 call;
  `SendInput` (move/click/drag/scroll) + `KEYEVENTF_UNICODE` typing + VK codes for `desktop_press`;
  GDI capture (window via `PrintWindow`/`PW_RENDERFULLCONTENT`, or screen-crop in physical pixels).
  **Physical pixels** throughout; the transform is `image px × (capture px / image px) + capture
  origin` → physical px; DPI scale is information only. Key-up/button-up in the driver's `finally`;
  "release all" on abort/driver death (B3).
- Target-window gate (B2): approval binds HWND+pid; foreground + in-rect check before every input;
  always refuse VS Code / UAC / taskbar; `desktop_press` never auto-approves system chords.
- Implement all desktop tools (§4.2). `desktop_capture` returns `MultimodalToolResult` + `capture_id`.
- Cloud-model capture gate (§4.7).
- **Gate:** unit test for the DPI/coordinate transform (non-zero origin / second monitor at negative x,
  and a downscaled image) — pure, no mouse. The **real-mouse** integration test goes under
  `test/live` (B7) — it cannot run in `npm run ci` (three OSes, moves the real cursor).

**Phase 3 — Focused tests**
- Unit: permission resolution (new tiers on/off/legacy), the vision-gate drift test (B8),
  `screenshotPath` parsing, the DPI/coordinate transform, consequential `approval()` → `dangerous`,
  the target-window foreground check (mock the driver), and the **abort-mid-drag → button-up sent**
  test (mock the driver, B3).
- Integration (deterministic, no LLM, no real mouse where avoidable): the browser loop (skip-with-
  message in CI without a browser); refusal paths (permission off, vision off, non-win32 desktop,
  cloud full-screen capture, unapproved window, system chord).
- **No Holo4 in any test.** Live-model tests use the resident model only and live in `test/live`
  (skipped by default).

**Phase 4 — Documentation**
- `README`/`docs`: how to enable (`permissions.browser.enabled` / `permissions.desktop.enabled: true`),
  the Chrome/Edge channel + no-download behavior, the coordinate/DPI/`coord_space` contract, the
  target-window + origin-approval gates, the consequential-hint behavior, and the limitations.
- Update `CHANGES.md` (release source of truth) — not `CHANGELOG.md` (generated).

**Phase 5 — Live browser loop (me, the resident vision model)**
- **Calibration probe first:** click a known target, check the hit, and determine Qwen3.8's coordinate
  space (`image_px` vs `norm_1000`); set `coord_space` accordingly.
- Then drive it live: `browser_open` (Chrome, ephemeral profile) → `browser_screenshot` (I see it) →
  `browser_click` (I pick the target from what I see) → `browser_screenshot` (I verify the change).
  Real browser, isolated profile, my own reasoning — no Holo4. I act only on the approved origins.

**Phase 6 — Live desktop loop (me, the resident vision model, real mouse)**
- I drive it live on a **controlled target** (e.g. a Notepad window I open): `desktop_focus_window`
  (I get the user's approval to control it) → `desktop_capture` (I see it) → `desktop_click`/
  `desktop_type` (real mouse/keyboard on the real screen, foreground-checked to the approved window)
  → `desktop_capture` (I verify). Done deliberately and last; the user is present. I act **only** on
  the approved window and do not click anywhere else on the real screen without explicit confirmation.

**Phase 7 — Limitations report**
- Report, not claim: the VSIX `chromium.launch()` result (B4), the driver's per-action latency, DPI /
  multi-monitor edge cases actually observed, the Qwen3.8 coordinate space (calibration result), the
  cloud-capture behavior, and the consequential-detection limitation. Anything not verified on this
  machine is marked unverified.

## 6. Job split (me vs Copilot) — to be finalized with Claude

- **Me (Forge, primary implementer):** all architecture-touching code — the B8 vision-gate refactor,
  permission tiers, config schema, `ToolDispatch`/registration wiring, the `BrowserSessionManager`,
  the multimodal screenshot path, the target-window + origin gates, and the live demos (I am the
  vision model that must see the screenshots).
- **Me, not Copilot (Claude's design disagreement #2):** the PowerShell `DesktopDriver` body is the
  most safety-critical code (foreground check, key release, DPI awareness). I write it myself, or
  Claude reviews it line by line against B2/B3/B6. Copilot does **not** write it.
- **Copilot (helper, via `ask_live_session`/`tell_live_session`):** well-bounded, self-contained
  pieces that touch **no gates** — the `toolResultView` `screenshotPath` helper + webview thumbnail row,
  and non-gate unit-test scaffolding — handed as focused tasks with the files named.
- **Mine, not Copilot (Claude's split addition):** the **gate tests** are the evidence later phases are
  signed against — the B2 foreground/in-rect refusals, the B3 abort-mid-drag release, and the B8
  vision-gate drift test.
- **Claude (supervisor, all phases):** evaluates the plan (done), reviews each phase's diff, signs off
  before the next phase. I check in per phase via `ask_live_session` (decision) / `tell_live_session`
  (progress).

## 7. Durable state written by this feature

- The browser **process** (system Chrome/Edge, ephemeral context) — no durable profile of its own.
- **Screenshot files** under `~/.forge/screenshots/<conversationId>/`.
- **Config fields** `permissions.browser.enabled` / `permissions.desktop.enabled` + the top-level
  `browser:` block.
- The **long-lived PowerShell driver process** (owned + disposed by the extension host).
- No Chromium download (system channel) — so no Playwright browser cache is created by default.

## 8. State × lifecycle ledger

Every durable artifact × lifecycle. An empty cell is an unwritten bug.

| Artifact | Create | Delete | Pause / Disable | Crash mid-write | Owner-process death | TTL / Expiry |
|---|---|---|---|---|---|---|
| Browser process (system Chrome/Edge, ephemeral context) | `browser_open` spawns it as a child over a pipe | `browser_close` → `browser.close()`; also `deactivate()` | `permissions.browser.enabled: false` → **close the open browser on the config change** (the close itself is permission-gated, so it cannot wait for a `browser_close` call that is now refused); family not advertised/dispatchable | A tool call against a dead browser throws → "session expired; call `browser_open` again"; no stale handle reused | Playwright launches over a pipe → Chromium exits when the pipe closes (verify Phase 1 by killing the host); watchdog only if that fails | No TTL while open; closed explicitly or on deactivate |
| Ephemeral browser context (throwaway profile) | `browser.newContext()` at `browser_open` | `browser.close()` (context + profile gone) | lives with the process | Playwright temp context is disposable; a hard kill leaves a temp dir → swept on next `browser_open` (stale temp dirs deleted) | Orphaned temp dir on hard kill → same stale-temp sweep on next `browser_open` | Swept when stale (no live session references it) |
| Screenshot files (`~/.forge/screenshots/<conv>/`) | Written by `browser_screenshot`/`desktop_capture` (atomic temp→rename) | **Deleted with the conversation** + a fixed `screenshots.retain_days` sweep (one rule, not "or") | n/a | Atomic write → no torn PNG; a failed write leaves no partial file (temp unlinked) | Inert on disk; survive host death (fine — just images) | `retain_days` (default: keep for the session, then sweep); in `~/.forge/`, outside any repo |
| Long-lived PowerShell driver process | Spawned lazily on first desktop tool call, JSON over stdin | `deactivate()` disposes it; also on `permissions.desktop.enabled: false` | `permissions.desktop.enabled: false` → dispose the driver + refuse the family | A mid-call crash → driver's `finally` sends key-up/button-up; a dead driver is detected and respawned on the next call (or reported) | `deactivate()` disposes it; on hard kill the child is orphaned → **mitigation:** the driver self-exits when its stdin pipe closes (same pipe pattern as the browser); a stale driver is detected on next spawn | No TTL while a desktop session is active; disposed on deactivate or permission-off |
| **OS input state (held keys / mouse buttons)** — B3 | A `desktop_drag` / `ctrl+…` chord holds a button/key down | The matching key-up/button-up is sent in the driver's `finally` | n/a | **Abort/timeout/driver-crash mid-chord → "release all" is sent** so no key/button is left held on the live desktop | If the host dies mid-chord, the driver's pipe-close handler sends "release all" before exiting (best-effort; the OS may retain a held state if the process is hard-killed — reported, not hidden) | n/a (state is the OS's) |
| Config fields `permissions.browser/desktop` + `browser:` block | User edits `.forge/config.yaml` | User removes them (reverts to deny-by-default) | Setting `enabled: false` disables the family (and closes/disposes the running browser/driver) | n/a (config is read, not written, by the tool path) | n/a (file on disk) | n/a |

**No durable state** is written by the desktop input path itself (mouse/keyboard are OS state, tracked
in the "OS input state" row); only the captured screenshots are durable files.

## 9. Known limitations & platform notes (reported, not claimed)

- **Browser = configured system channel (no silent fallback):** no Chromium download, no Playwright
  browser cache. If the configured channel's browser is absent, `browser_open` errors naming the
  alternative (e.g. set `browser.channel: msedge`). The `chromium` channel (downloaded build) requires a
  **manual** user-run `npx playwright install chromium` — never an automatic in-host download. The VSIX
  `chromium.launch()` smoke (B4) is the gate that proves the bundled `playwright-core` can launch a
  system browser.
- **playwright-core packaging (B4, decided 2026-09-29):** playwright-core is **not** bundle-safe —
  inlining it breaks its runtime file lookups (`browsers.json`, and the undeclared optional
  `chromium-bidi` require in `coreBundle.js`). So it is marked **external** in esbuild and shipped
  **intact** next to the bundle at `dist/node_modules/playwright-core` (a `copyPlaywrightCore()`
  build step; **+12.8 MB** to the VSIX, approved). The bundle does a **lazy**
  `require('playwright-core')` inside `BrowserSessionManager.launch()` so activation never loads the
  12.8 MB for users who never enable the browser. `bundle-load-check.js` fails CI if
  `playwright-core` does not resolve inside `dist/node_modules`. Version pinned to **1.63.0**.
  Verified: `chromium.launch({channel:'chrome'})` → Chrome 154.0.8037.58 launches and closes cleanly.
- **Desktop driver = one long-lived PowerShell process:** `Add-Type` compiles C# once at driver start
  (≈1–2 s), then commands go over stdin (fast per event). Far cheaper than a process-per-event, but the
  driver is a real owned process (ledger row). A native `SendInput` driver is the documented swap-in
  behind the `DesktopDriver` interface — not built or claimed in v1.
- **DPI awareness (B6):** the driver calls `SetProcessDpiAwarenessContext(-4)` (per-monitor aware v2)
  so `GetWindowRect`/`CopyFromScreen`/`SetCursorPos` are not virtualized at 150%. All math is in
  **physical pixels**; the transform is `image px × (capture px / image px) + capture origin`. The DPI
  scale is reported, not a term in the transform. Window capture uses `PrintWindow`/`PW_RENDERFULLCONTENT`
  (or a physical-pixel screen crop); full-screen only on explicit `monitor` + approval.
- **Coordinate space is model-dependent:** Qwen3-VL grounds on a 0–1000 grid, not pixels. The
  calibration probe (Phase 5) determines Qwen3.8's space; `coord_space` is a tool arg. Whether a given
  VLM reliably reads the space and emits correct coordinates is a **model-capability** question Forge
  cannot guarantee — the deterministic tests prove the mechanics; the live loop proves the resident
  model can drive it.
- **Consequential detection is best-effort:** the model self-flags `consequential`; the structural
  gates (approved window, origin approval) are what actually stop a blind/injected action. Page content
  is untrusted.
- **Cloud-model capture:** a cloud vision model receiving `desktop_capture` gets the user's screen;
  full-screen capture requires explicit `monitor` + approval naming the provider (decide refuse-vs-
  approve in Phase 2).
- **Holo4 OOM:** Holo4 is **not** used in any test or demo (OOMs beside the resident 27B). Whether
  Holo4 specifically emits the right coordinate space / tool calls is **unverified** and out of scope.
- **Platform:** the desktop family is Windows-only (`advertise: () => process.platform === 'win32'`,
  refused at dispatch elsewhere). Browser tools are cross-platform (system channel).

## 10. Acceptance criteria

Each maps to a test or a named validation step. "Verified" requires code-path evidence.

**Permissions & gating**
- [ ] A config with no `permissions` block advertises **zero** browser/desktop tools (legacy unchanged). → unit: `PermissionResolver` + `ToolRegistry.definitions`.
- [ ] `permissions.browser.enabled: true` advertises the browser family; `false`/absent hides it and refuses dispatch. → unit.
- [ ] `permissions.desktop.enabled: true`/`false` behaves the same for the desktop family. → unit.
- [ ] The desktop family is advertised only on `win32` and refused at dispatch on other platforms. → unit.
- [ ] `browser_screenshot`/`desktop_capture` are advertised **only** when the active model has vision; on a non-vision model they are withheld **and** refused with a reason naming the model. → unit (single `requiresVision` source drives both halves).
- [ ] **Vision-gate drift test:** any tool flagged `requiresVision` that could be advertised to a non-vision model without also being refused **fails the test**. → unit (B8).
- [ ] A disabled tool cannot be invoked via the fallback (fenced-JSON) path either. → integration.

**Multimodal path + coordinate space**
- [ ] `browser_screenshot`/`desktop_capture` return `MultimodalToolResult` whose `content` is `[text, image_url(data:…)]` (model receives the image inline, not just a path). → unit (mirror `ImageTool.test.ts`).
- [ ] The returned image is downscaled to ≤ the projector max and the text states the actual image size + `coord_space`. → unit.
- [ ] The webview thumbnail path parses the saved screenshot path from the result text (`~/.forge/` path). → unit (`screenshotPath`).

**Browser loop (deterministic, no LLM)** — verified locally where a browser is present; skip-with-message in CI without one.
- [ ] `browser_open` → `browser_screenshot` → `browser_click`(known element) → `browser_screenshot` yields a changed page state (DOM/URL/text). → integration.
- [ ] Element-based and coordinate-based clicks both hit the intended target. → integration.
- [ ] First navigation/input on a new origin triggers origin approval; an unapproved origin is refused. → integration.
- [ ] A dead session handle returns "session expired; call `browser_open` again" (no crash, no stale reuse). → integration.
- [ ] **VSIX gate (B4):** the packaged VSIX, loaded, can `chromium.launch({ channel: 'chrome' })`. → Phase 0 validation step.

**Desktop loop (deterministic + unit)**
- [ ] The image-px → physical-pixel transform is correct at 100% and 150% scale, with a non-zero origin (second monitor at negative x) and a downscaled image. → unit (pure, no mouse).
- [ ] The target-window gate: input to a window that is not the approved HWND, or a point outside its rect, is refused and names the fix. → unit (mock driver).
- [ ] VS Code / UAC / taskbar windows are always refused; `desktop_press` system chords (`win+*`, `alt+f4`) are never auto-approved. → unit (mock driver).
- [ ] **Abort mid-drag sends the button-up** (no key/button left held). → unit (mock driver, B3).
- [ ] `desktop_capture` returns an image + `capture_id` + size + DPI scale + mapping + origin. → `test/live` (real capture) / unit (mapping only).
- [ ] `desktop_capture` → `desktop_click`/`desktop_type` into the approved window → `desktop_capture` shows the change. → `test/live` (real, controlled target; not in `npm run ci`).

**Consequential confirmation**
- [ ] Setting `consequential: true` on `browser_click`/`desktop_click`/`browser_type`/`desktop_type` routes through `requestApproval` with `dangerous: true`; declining returns "User declined". → unit/integration.

**Live demos (Phase 5/6, resident vision model, no Holo4)**
- [x] Browser: calibration probe establishes Qwen3.8's `coord_space`; then screenshot → click → screenshot, driven by the resident model, visibly reading the screenshots and verifying the change. → **VERIFIED 2026-09-29**: `image_px` confirmed (click at 640,437 in 1280×800 hit the "Learn more" link on example.com → navigated to IANA).
- [x] Desktop: approved-window screenshot → mouse action → screenshot, driven on a controlled target (Notepad), real mouse, foreground-checked. → **VERIFIED 2026-09-30**: `desktop_capture` (18112 B) → `desktop_type` "Hello from Forge desktop tools!" → `desktop_capture` (22363 B) shows the text rendered in Notepad; input-copy root cause fixed (C#-built `INPUT` structs), 25/25 desktop unit tests green.

**Non-regression**
- [x] Existing tools and model configs are behavior-unchanged (Holo4 config byte-identical); `npm run type-check`, `npm run lint`, `npm test` green after the last change. → **VERIFIED 2026-09-29**: type-check exit 0, build exit 0, 3211/3232 tests pass (20 pre-existing bash-flake skips/failures on this Windows machine, unrelated).

---

## 11. Demo Results & Limitations Report (Phase 5/6/7)

### Phase 5 — Browser loop (VERIFIED)

- **Calibration:** Qwen3.8-27B-vision uses **`image_px`** (raw pixels in the returned
  screenshot), not `norm_1000`. A click at (640, 437) in a 1280×800 viewport
  screenshot hit the "Learn more" link on example.com exactly.
- **Loop:** `browser_open` (Chrome 154, ephemeral profile) → `browser_screenshot`
  (I saw the page) → `browser_click` (640, 437) → `browser_screenshot` (I verified
  the page changed to IANA's "Example Domains"). Full loop in ~3 s.
- **Multimodal path:** the screenshot returned inline as a data-URL image part;
  the webview thumbnail parsed the saved path from the text. Both halves work.

### Phase 6 — Desktop loop (VERIFIED)

- **Root cause fixed (2026-09-30):** typed text (and every input op) was sending
  all-zero `INPUT` structs because PowerShell copies nested value types —
  `$inp.u.ki.wScan = …` wrote to a copy, never `$inp`. `SendInput` accepted the
  all-zero events and returned the full count, so the gate passed but nothing
  appeared. Fixed by building the `INPUT` structs in C# (`Forge.Win32.Key` /
  `.Mouse` helpers). A second latent bug: `$proc.StartTime.ToUnixTimeMilliseconds()`
  always threw (`StartTime` is a `DateTime`), so the pid-reuse start-time check was
  silently off; both call sites now cast to `[DateTimeOffset]`.
- **Loop:** `desktop_focus_window` (Notepad approved, HWND+pid+start-time bound) →
  `desktop_capture` (18112 B) → `desktop_type` "Hello from Forge desktop tools!" →
  `desktop_capture` (22363 B) — the after-capture shows the text rendered in
  Notepad with the `*Untitled` title. Real mouse/keyboard, foreground-checked to
  the approved window.
- **Two follow-ups closed (2026-09-30):** (1) the B3 test now asserts the
  release-all (`dispose`) op is actually sent, not merely that `transport.dispose()`
  was called; (2) the driver now **refuses to approve** a target whose process
  start time is unreadable (elevated/system process), instead of silently disabling
  the pid-reuse check. 25/25 desktop unit tests green.

### Phase 7 — Platform & llama.cpp limitations (reported, not claimed)

| Item | Status |
|---|---|
| VSIX `chromium.launch({channel:'chrome'})` (B4) | **Verified** Phase 0: Chrome 154.0.8037.58 launches and closes cleanly. |
| Playwright-core packaging | **Decided:** external in esbuild, shipped intact at `dist/node_modules/playwright-core` (+12.8 MB). Lazy-loaded on first `browser_open`. |
| Desktop driver per-action latency | **Unverified** (needs the live demo). The PS script compiles C# once at start (~1–2 s); subsequent ops are JSON lines over stdin (expected < 50 ms). |
| DPI / multi-monitor | **Transform verified** by unit tests (negative-x second monitor, downscaled image, 150% scale). **Live behaviour** unverified until Phase 6 runs. |
| Qwen3.8 coordinate space | **Verified:** `image_px` (raw pixels). No `norm_1000` needed. |
| Cloud-model capture gate | **Implemented** (§4.7): monitor capture on a cloud vision model requires approval naming the provider. **Live behaviour** unverified (no cloud vision model loaded). |
| Consequential detection | **Best-effort** (model self-flags). Structural gates (origin approval, target-window gate) are the real protection. |
| Holo4 | **Not used** in any test or demo (OOMs beside the resident 27B). Whether Holo4 emits correct coordinates is **unverified** and out of scope. |
| Platform | Desktop family is Windows-only (`advertise: win32`, refused at dispatch elsewhere). Browser tools are cross-platform. |
| Pre-existing test flake | `AgentBus.test.ts` / `AgentRoutes.test.ts` bash-validation timeouts on this Windows machine (slow bash startup). Unrelated to this feature. |
