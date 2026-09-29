# Browser & Windows Desktop-Use Tools for Forge

**Status:** plan (pending Claude evaluation)
**Target model for live demos:** the already-loaded vision model (Qwen3.8-27B + mmproj, the
live Forge backend). **Holo4 is deliberately NOT loaded** for any test or demo — it OOMs
alongside the resident 27B. No new model is loaded; the live agent (Forge itself) is the
vision model that sees the screenshots.

---

## 1. Goal

Add two families of native Forge tools that let a vision-capable model operate a browser and
the Windows desktop, in an explicit screenshot → act → screenshot loop:

- **Browser tools** (Playwright / CDP): open/navigate, list/select tabs, screenshot
  (viewport or full page), inspect page elements, click, type, scroll, hover, drag, press keys.
  Element-based actions when possible; screenshot-coordinate actions also supported.
- **Windows desktop tools**: list windows, focus a window, capture a window or screen, move
  mouse, click / double-click / right-click, drag, scroll, type text, press keys.

Screenshots are returned **directly to the model as image tool results** via Forge's existing
multimodal path (`MultimodalToolResult` → `ContentPart` `image_url` data-URL) — not merely a
file path. Coordinate actions are **DPI-aware** and name the exact screenshot / window / tab
their coordinates refer to. Browser and desktop sessions are **explicit** — Forge never
silently attaches to the user's personal Chrome tabs.

## 2. Scope & non-goals

**In scope**
- New `browser` + `desktop` tool families, registered through Forge's existing native
  tool-calling **and** fallback mechanisms.
- New deny-by-default `permissions.browser` / `permissions.desktop` config blocks.
- Vision-gated screenshot tools (advertised only when the active model has `mmproj_path`).
- Reuse of Forge's permission + confirmation gate for consequential actions.
- Focused tests (unit + deterministic integration) and documentation.
- One live browser loop and one live desktop loop, driven by the resident vision model.

**Non-goals (kept out to bound the change)**
- No arbitrary-JS `browser_evaluate` / console tool (too powerful; not requested).
- No multi-monitor tiling math, no touch/pen, no accessibility-tree export beyond a simple
  interactive-element list.
- No change to any existing tool's behavior or to any existing model entry (Holo4 config
  stays byte-identical).
- No native C++ input driver in v1 (a PowerShell P/Invoke driver is the validated primary;
  a native `SendInput` driver is a documented future swap — see §9).

## 3. Architecture to reuse (verified in this repo)

| Concern | Where | What we reuse |
|---|---|---|
| Tool catalog | `src/tools/ToolRegistry.ts`, `src/tools/registerAllTools.ts` | `RegisteredTool` shape (`permission`, `approval`, `autoApprove`, `advertise`, `describe`); conditional-registration pattern (delegation / image_generation). |
| Permissions | `src/tools/PermissionResolver.ts` | `resolveToolPermissions(config)` → `Set<ToolPermission>`; deny-by-default groups; `LEGACY_PERMISSIONS` (we do **not** add the new tiers here, so they stay off by default). |
| Confirmation gate | `src/sidebar/ToolDispatch.ts` | `needsConfirm = approval() !== undefined \|\| (!autoApprove && tier ∈ {write,delete,terminal,headless,git-write})` → `requestApproval(name, detail, isDangerous, convId, signal)`. |
| Multimodal result | `src/tools/ToolRegistry.ts` (`MultimodalToolResult`), `src/tools/imageTool.ts` (`view_image`) | Return `{ text, content: [text, image_url(data:...)] }`; `ToolDispatch` ships `result.content` to the model. |
| Webview image display | `src/sidebar/toolResultView.ts` (`generate_image` / `image_search`) | The webview has no image-bytes field; it parses a **saved path** out of the result text and renders a thumbnail. We reuse that text-parsing contract. |
| Vision gate | `src/sidebar/ModelTurn.ts` (`VISION_ONLY_TOOLS` + `unavailableTools`), `src/config/ConfigResolver.ts` (`deriveStaticCapabilities`) | Both halves of the gate must list the same tools; `vision` is derived from `mmproj_path`. |
| Native + fallback | `src/tools/FallbackToolPrompt.ts` | `buildFallbackToolInstructions(tools)` builds the catalog from the same `ToolDefinition[]`, so registering a proper definition covers **both** native and fallback automatically. |
| Cleanup hook | `src/extension.ts` (`deactivate()`) | Close the Playwright browser on window close so no Chromium is orphaned. |

**Facts that constrain the design**
- The live backend is `qwen38-27b-dflash2-ud-q6k-vision` (mmproj on CUDA2) — vision-capable,
  already resident. Loading Holo4 (another 27B) would OOM the three GPUs.
- `ToolResultMsg` (webview) carries `text` only — no base64. So the model gets the image
  inline, and the webview thumbnail comes from a saved path parsed out of the text.
- No `playwright` or native-input dependency exists in `package.json` yet.


## 4. Design

### 4.1 Permission model

Add two new `ToolPermission` tiers, **deny-by-default**:

- `browser` — grants the browser tool family.
- `desktop` — grants the desktop tool family.

Changes (all additive; existing configs and tiers untouched):
1. `src/tools/ToolRegistry.ts`: extend the `ToolPermission` union with `'browser' | 'desktop'`.
2. `src/config/schema.ts` — `PermissionsSchema` (line 206): add two optional sub-objects, matching the
   existing domain-group shape (`fs`/`net`/`exec`/`git`/`agents`):
   - `browser: z.object({ enabled: z.boolean().default(false), headless: z.boolean().default(false), user_data_dir: z.string().optional() }).optional()`
   - `desktop: z.object({ enabled: z.boolean().default(false) }).optional()`
   `browser.user_data_dir` defaults to a fresh temp dir (never the user's Chrome profile).
3. `src/tools/PermissionResolver.ts`:
   - `if (configured.browser?.enabled ?? false) allowed.add('browser');`
   - `if (configured.desktop?.enabled ?? false) allowed.add('desktop');`
   - Add `['browser', (p) => p.browser?.enabled]` and `['desktop', (p) => p.desktop?.enabled]` to
     `DENY_BY_DEFAULT` so an omitted-but-present `permissions` block reports them as suppressed
     (consistent with `exec.terminal` etc.).
   - **Do not** add them to `LEGACY_PERMISSIONS` → a config with no `permissions` block gets
     neither, so nothing is advertised to existing users.

Effect: with the default config, `ToolRegistry.definitions(allowed)` filters the whole family
out (not advertised, refused at dispatch). Setting `permissions.browser: true` turns the family
on. This is the "explicit sessions / don't touch my Chrome" guarantee at the permission layer.

### 4.2 Tool catalog

Every tool: `permission: 'browser'` or `'desktop'`; observation/low-consequence actions are
`autoApprove: true` (no per-call prompt); consequential actions carry a `consequential` flag
driven through `approval()` (§4.6). Screenshot tools are vision-gated (§4.4).

**Browser** (Playwright, isolated Chromium — §4.5)

| Tool | Args (key ones) | Returns | Confirm |
|---|---|---|---|
| `browser_open` | `url?`, `headless?` | session ready + first tab id | no (autoApprove) |
| `browser_close` | — | closed | no |
| `browser_navigate` | `url`, `tab_id?` | final url + title | no |
| `browser_tabs` | — | list of `{id,title,url,active}` | no |
| `browser_select_tab` | `tab_id` | active tab | no |
| `browser_new_tab` | `url?` | new tab id | no |
| `browser_close_tab` | `tab_id` | closed | no |
| `browser_screenshot` | `tab_id?`, `full_page?` | **MultimodalToolResult** (image) + saved path | no (autoApprove) · **vision-gated** |
| `browser_inspect` | `tab_id?`, `selector?`, `max?` | numbered interactive elements `{index,role,text,selector,bbox}` | no (autoApprove) |
| `browser_click` | `tab_id?`, `selector?` \| `index?` \| `x?`,`y?`, `consequential?` | what was clicked | **if consequential** |
| `browser_type` | `tab_id?`, `selector?` \| `index?`, `text`, `consequential?` | typed into | **if consequential** |
| `browser_press` | `tab_id?`, `key`, `selector?`, `consequential?` | pressed | **if consequential** |
| `browser_scroll` | `tab_id?`, `selector?` \| `x?`,`y?`, `delta_x?`,`delta_y?` | scrolled | no |
| `browser_hover` | `tab_id?`, `selector?` \| `index?` \| `x?`,`y?` | hovered | no |
| `browser_drag` | `tab_id?`, `from_*`, `to_*` (selector/index/coords) | dragged | no |

**Session:** v1 runs **one** browser session (the `BrowserSessionManager` is a singleton — one
Chromium process, many tabs). `browser_open` when one exists returns the existing session; no
`session_id` param is needed. This is still "explicit": you `browser_open` to start and
`browser_close` to end, and it is never the user's Chrome.

**Element-based first:** `selector` or `index` (from `browser_inspect`). Coordinate fallback:
`x`,`y` in **viewport CSS pixels** of the named tab. The result text always names the tab
(title + url) and the target (selector/index or `x,y`) so the coordinate frame is unambiguous.
Coordinate actions are valid against a **viewport** screenshot, where the screenshot pixel space
equals the Playwright mouse space (both CSS px). A **full-page** screenshot has a different (taller)
pixel space, so use element-based actions there.

**`browser_inspect`** is a heuristic interactive-element selector (`a`, `button`, `input`, `select`,
`[role]`, `[onclick]`, …) with `getBoundingClientRect` bboxes — a numbered list to target, **not** the
full accessibility tree (a non-goal).

**Desktop** (PowerShell SendInput/GDI driver — §4.5, §9)

| Tool | Args (key ones) | Returns | Confirm |
|---|---|---|---|
| `desktop_capture` | `window_title?` \| `monitor?` | **MultimodalToolResult** (image) + `capture_id`, pixel size, DPI scale, mapping | no (autoApprove) · **vision-gated** |
| `desktop_windows` | — | list of `{id,title,rect}` | no |
| `desktop_focus_window` | `window_title?` \| `window_id?` | focused window | no |
| `desktop_move_mouse` | `x`,`y`,`capture_id` | moved to (image px) | no |
| `desktop_click` | `x`,`y`,`button?`,`clicks?`,`capture_id`,`consequential?` | clicked | **if consequential** |
| `desktop_drag` | `from_x`,`from_y`,`to_x`,`to_y`,`capture_id` | dragged | no |
| `desktop_scroll` | `x`,`y`,`delta_x?`,`delta_y?`,`capture_id` | scrolled | no |
| `desktop_type` | `text`,`consequential?` | typed | **if consequential** |
| `desktop_press` | `keys` (e.g. `ctrl+c`, `enter`) | pressed | no |

Desktop coordinate actions **require** a `capture_id` (no implicit "current screen") — the
capture is the explicit session/frame, satisfying "keep desktop sessions explicit" and
"identify which screenshot the coordinates refer to."

### 4.3 Multimodal screenshot path (model gets the image, not a path)

`browser_screenshot` / `desktop_capture` return:
```
{
  text: `Screenshot of tab "t1" (example.com), 1280×720 CSS px. Saved to .forge/screenshots/<conv>/<ts>.png (view_image can open it).`,
  content: [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,<...>' } }
  ]
}
```
- **Model:** receives the inline base64 image via the existing `view_image`/`view_video`
  content path (proven by `test/unit/ImageTool.test.ts`, `VideoTool.test.ts`). This is the
  primary requirement.
- **Webview:** renders a thumbnail by parsing the saved path out of the text — a new
  `screenshotPath(toolName, result)` helper in `toolResultView.ts` mirroring
  `generatedImagePath`, plus a thumbnail row in the webview tool-result view. Secondary /
  nice-to-have; the model path does not depend on it.
- Screenshots are saved under `.forge/screenshots/<conversationId>/<ts>.png` (durable — see
  ledger §8) and size-capped like `view_image` (≤ 10 MB; full-page shots are JPEG-encoded to
  stay small).
- **Image retention:** like all image parts, screenshots are aged out of the model context after the
  model's `image_retention_turns` (the resident model sets 2) via `ageOutImageParts`. The
  screenshot → act → screenshot loop is immediate (each action sees the fresh screenshot), so this is
  fine for the loop; a screenshot from several turns ago may already be evicted. Noted so the loop is
  not accidentally built on a stale image.

### 4.4 Vision gating (advertise screenshot tools only when the model can see)

Mirror the existing two-half gate in `src/sidebar/ModelTurn.ts`:
- Add `browser_screenshot` and `desktop_capture` to `VISION_ONLY_TOOLS`.
- Add matching entries to the `unavailableTools` refusal map (with a `visionUnavailableMessage`
  -style reason naming the model and telling it to switch to a vision model).
- The non-screenshot action tools are **not** vision-gated (per the requirement: only
  screenshot tools are). A non-vision model with `permissions.browser: true` can still act
  (blind); the live demos use a vision model.

### 4.5 Explicit, isolated sessions

- **Browser:** `browser_open` launches Playwright's **own Chromium** with a **fresh
  `BrowserContext`** (its own temp `--user-data-dir` under the Forge cache dir). It is a
  separate process with its own profile — **never the user's Chrome profile, never attached to
  existing tabs.** Headed by default; `headless: true` (or a config flag) for tests. `browser_close`
  and `deactivate()` both close it.
- **Desktop:** the "session" is the **capture reference frame**. Each `desktop_capture` returns a
  `capture_id` binding a pixel space (window/monitor, size, DPI scale, origin offset). Coordinate
  actions reference that `capture_id`; there is no implicit global screen.

### 4.6 Consequential-action confirmation (reuse the existing gate)

`browser_click/type/press`, `desktop_click/type` take `consequential?: boolean` (default
`false`). Their `approval()` returns `{ dangerous: true, detail: "<what will happen>" }` when
`consequential` is true → `ToolDispatch` calls `requestApproval` → the user confirms or declines.
Tool descriptions instruct the model to set `consequential: true` when the action **submits a
form, makes a purchase, sends a message, or deletes data**.

**Honest limitation (reported, not papered over):** Forge cannot infer from a bare click that it
is a purchase; the model must self-identify, and page content is untrusted. The confirmation is a
best-effort + user-in-the-loop backstop, not a guarantee. See §9.

### 4.7 Untrusted page content & no credential exposure

- Browser tool results are framed as **untrusted page data, not instructions** (stated in the
  tool descriptions and the family's system-prompt note). A page saying "click Buy" is data; the
  consequential-confirmation gate (§4.6) is what stops a blind auto-click on it.
- The isolated profile has **no saved passwords / cookies / history** by default; no tool reads
  the user's real browser profile. `browser_open` never points `user_data_dir` at the user's
  Chrome profile.

### 4.8 Registration & native + fallback

- New factories: `src/tools/browser/*.ts`, `src/tools/desktop/*.ts`; a `BrowserSessionManager`
  (owns the Playwright browser/contexts/tabs, singleton) and a `DesktopDriver` (PowerShell
  impl) created once and passed to the factories (the `PowerControl` pattern).
- Registered in `registerAllTools.ts` (which already receives `getConfig`, `workspaceState`).
  Registered unconditionally; **permission** (`browser`/`desktop`) filters advertisement +
  dispatch, and **vision** filters the two screenshot tools. If Playwright's browser binary is
  missing, `browser_open` returns a clear one-line "run `npx playwright install chromium`"
  error rather than crashing.
- Because each tool carries a real `ToolDefinition`, `buildFallbackToolInstructions` covers the
  fallback (fenced-JSON) path with no extra work — native and fallback both work from the same
  registration.


## 5. Phases

**Phase 0 — Foundation**
- Add `browser`/`desktop` to the `ToolPermission` union; add the `browser`/`desktop` sub-objects to
  `PermissionsSchema` (`src/config/schema.ts`); resolve them (deny-by-default) in `PermissionResolver`
  + `DENY_BY_DEFAULT`.
- Add `playwright-core` to `package.json` dependencies (small; browsers stay in the OS cache, not the
  VSIX).
- Add a `screenshotPath()` helper to `toolResultView.ts` (webview thumbnail contract).
- Add the two screenshot tool names to `VISION_ONLY_TOOLS` + the `unavailableTools` map in `ModelTurn.ts`.
- Scaffolding: `BrowserSessionManager`, `DesktopDriver` interface + PowerShell impl, `registerAllTools`
  wiring. No tool is advertised until its family's permission is on.
- **Gate:** `npm run type-check` + `npm test` green; a config without the new block advertises **zero**
  new tools (regression guard for "preserve existing tools").

**Phase 1 — Browser tools**
- Playwright isolated-Chromium session manager (fresh context, headed default, headless flag;
  singleton session). Thread `ToolHandlerContext.abortSignal` into `browser_open` (launching Chromium
  takes seconds) so a cancelled turn does not leave a half-launched browser.
- Finalize the Chromium install trigger (extension-spawned `npx playwright install chromium` vs. a
  documented manual step) and report it.
- Implement all browser tools (§4.2). Screenshot returns `MultimodalToolResult`.
- **Gate:** deterministic integration test — `browser_open` → `browser_screenshot` (assert multimodal
  content shape) → `browser_click` (a known element) → `browser_screenshot` (assert the DOM/state changed).

**Phase 2 — Desktop tools**
- PowerShell P/Invoke `DesktopDriver`: `SendInput` (move/click/drag/scroll/type/press) + GDI screen/window
  capture + DPI scale query. DPI-aware coordinate mapping (image px → physical → virtual screen).
- Implement all desktop tools (§4.2). `desktop_capture` returns `MultimodalToolResult` + `capture_id`.
- **Gate:** deterministic integration test — `desktop_capture` (assert image + capture_id + mapping) →
  `desktop_click`/`desktop_type` into a controlled target (e.g. a Notepad window) → `desktop_capture`
  (assert the change). Plus a pure unit test for the DPI/coordinate transform (no real mouse).

**Phase 3 — Focused tests**
- Unit: permission resolution (new tiers on/off/legacy), vision-gate both halves list the same tools,
  `screenshotPath` parsing, DPI/coordinate transform, consequential `approval()` → `dangerous`.
- Integration (deterministic, no LLM, no real mouse where avoidable): the two loops above; refusal paths
  (permission off, vision off, Playwright missing, dead session handle). The **browser** loop needs
  Chromium: it runs where Chromium is present (this machine) and **skips with a clear message** where it
  is not (CI without a browser install) — like `test/live`. The **unit** tests (permissions, vision gate,
  multimodal shape, DPI transform, consequential approval) run everywhere.
- **No Holo4 in any test.** Live-model tests (if any) use the resident model only, and are `test/live`
  (skipped by default).

**Phase 4 — Documentation**
- `README`/`docs` section: how to enable (`permissions.browser`/`desktop: true`), first-use Playwright
  install, the coordinate/DPI contract, the consequential-confirmation behavior, and the limitations.
- Update `CHANGES.md` (release source of truth) — not `CHANGELOG.md` (generated).

**Phase 5 — Live browser loop (me, the resident vision model)**
- I drive it live: `browser_open` (headed Chromium) → `browser_screenshot` (I see it) → `browser_click`
  (I pick the target from what I see) → `browser_screenshot` (I verify the change). Real browser, isolated
  profile, my own reasoning — no Holo4.

**Phase 6 — Live desktop loop (me, the resident vision model, real mouse)**
- I drive it live on a **controlled target** (e.g. a Notepad window I open): `desktop_capture` (I see it)
  → `desktop_click`/`desktop_type` (real mouse/keyboard on the real screen) → `desktop_capture` (I verify).
  Done deliberately and last; the user is present (they asked for live). I act **only** on the controlled
  target and do not click anywhere else on the real screen without explicit confirmation.

**Phase 7 — Limitations report**
- Report, not claim: Playwright first-use download, the PowerShell driver's per-action latency, DPI
  edge cases actually observed, and the consequential-detection limitation. Anything not verified on this
  machine is marked unverified.

## 6. Job split (me vs Copilot) — to be finalized with Claude

Proposed default (Claude is the supervisor and decides the split):
- **Me (Forge, primary implementer):** all architecture-touching code — permission tiers, config schema,
  the `ModelTurn` vision gate, `ToolDispatch`/registration wiring, the `BrowserSessionManager`, the
  multimodal screenshot path, and the live demos (I am the vision model that must see the screenshots).
- **Copilot (helper, via `ask_live_session`/`tell_live_session`):** well-bounded, self-contained pieces —
  e.g. the PowerShell `DesktopDriver` P/Invoke body, the `toolResultView` `screenshotPath` helper +
  webview thumbnail row, and the unit-test scaffolding — handed as focused tasks with the files named.
- **Claude (supervisor, all phases):** evaluates the plan, reviews each phase's diff, and signs off before
  the next phase. I check in per phase via `ask_live_session` (decision) / `tell_live_session` (progress).

## 7. Durable state written by this feature

- Playwright Chromium **process** + its fresh profile dir (temp `--user-data-dir`).
- **Screenshot files** under `.forge/screenshots/<conversationId>/`.
- **Config fields** `permissions.browser` / `permissions.desktop` (and any `browser.*`/`desktop.*` knobs).
- **Playwright browser binary** (one-time `npx playwright install chromium` cache) — an install artifact,
  not per-run state.
- The desktop driver writes **no** durable state of its own (mouse/keyboard state is the OS's); only the
  screenshots it captures are durable.

## 8. State × lifecycle ledger

Every durable artifact × what happens across its lifecycle. An empty cell is an unwritten bug.

| Artifact | Create | Delete | Pause / Disable | Crash mid-write | Owner-process death | TTL / Expiry |
|---|---|---|---|---|---|---|
| Playwright Chromium process (isolated profile) | `browser_open` spawns it as a child of the extension host | `browser_close` → `browser.close()`; also `deactivate()` | `permissions.browser: false` → family not advertised/dispatchable; an already-open browser is closed on next `browser_close`/`deactivate` (not force-killed mid-call) | A tool call against a dead browser throws → handler returns "session expired; call `browser_open` again"; no partial tab/profile state is left marked valid | `deactivate()` closes the child. If the host is hard-killed (no `deactivate`), the Chromium child is orphaned → **mitigation:** launch with a short-lived watchdog that exits the browser if the parent PID disappears; on next `browser_open`, a stale handle is detected and reported, not reused | No TTL while open; closed explicitly or on deactivate |
| Fresh profile dir (`--user-data-dir`) | Created by Playwright under the Forge cache dir at `browser_open` | Removed on `browser_close`/`deactivate` (best-effort; Playwright temp contexts are disposable) | n/a (lives with the process) | Left on disk if the process dies hard → swept on next `browser_open` (stale temp dirs older than the session are deleted) | Orphaned on hard kill → same stale-temp sweep on next `browser_open` | Swept when stale (no live session references it) |
| Screenshot files (`.forge/screenshots/<conv>/`) | Written by `browser_screenshot`/`desktop_capture` (atomic temp→rename, like other Forge file writes) | User deletes, or a retention sweep (see TTL) | n/a | Atomic write → no torn PNG; a failed write leaves no partial file (temp is unlinked) | Files are inert on disk; survive host death (fine — they're just images) | Retention: reuse the existing attachment/retention convention (`remote.attachments.retain_days`-style) or a `screenshots.retain_days` knob; default = keep for the session, sweep on a documented interval |
| Config fields `permissions.browser`/`desktop` | User edits `.forge/config.yaml` (or a future UI) | User removes them (reverts to deny-by-default) | Setting `false` disables the family (the normal "off") | n/a (config is never written back by code — established workspace fact) | n/a (file on disk) | n/a |
| Playwright browser binary (install cache) | One-time `npx playwright install chromium` on first `browser_open` if absent | User removes the cache dir (forces re-download) | n/a | A failed/partial download → Playwright re-verifies the revision on next launch and re-downloads if the hash/revision is missing | Survives host death (it's a cache) | Pinned to the Playwright version's expected revision; re-fetched if mismatched |

**No durable state** is written by the desktop input path itself (mouse/keyboard are OS state); only the
captured screenshots are durable, covered above.

## 9. Known limitations & platform notes (reported, not claimed)

- **Playwright packaging & first-use download:** the extension depends on **`playwright-core`**
  (small — the driver only, no browsers) so the VSIX stays small; the Chromium **browser** is a
  one-time install into the OS cache (`~/.cache/ms-playwright`, ~150 MB) via `npx playwright install
  chromium`, triggered by the extension on first `browser_open` if the revision is missing (or run
  manually once). The browser is never bundled in the VSIX. Reported at first `browser_open` if
  missing. (Exact install trigger — extension-spawned vs. manual — is finalized in Phase 1.)
- **Desktop driver = PowerShell P/Invoke (v1):** zero native build/packaging risk and validated on this
  machine, but each input event spawns a PowerShell process (tens of ms). Fine for an agent-driven
  loop (the model's think-time dwarfs it); **not** smooth for rapid drags. A native `SendInput` driver is
  the documented swap-in behind the `DesktopDriver` interface — not built or claimed in v1.
- **DPI awareness & window capture:** capture is taken at the screen's pixel space and the scale
  factor is queried; image px → virtual-screen mapping is computed per capture. v1 captures the full
  screen/monitor; a **named window** is captured by cropping the screen to its `GetWindowRect` rect
  (a `PrintWindow` path for occluded windows is a documented enhancement, not in v1). Multi-monitor /
  mixed-DPI edge cases are validated in Phase 2 and reported as observed, not assumed.
- **Consequential-action detection is best-effort:** the model self-flags `consequential`; Forge cannot
  prove a click is a purchase. The confirmation gate is a backstop. Page content is untrusted.
- **Holo4 OOM:** Holo4 is **not** used in any test or demo (it OOMs beside the resident 27B). The live
  demos run on the resident Qwen3.8-27B vision model. Whether Holo4 specifically emits the right
  coordinate space / tool calls is **unverified** and out of scope for the live demos.
- **llama.cpp / model capability:** the tools return real screenshots and accept coordinates, but whether a
  given VLM reliably reads the coordinate space and emits correct tool calls is a model-capability question
  Forge cannot guarantee. The deterministic tests prove the **mechanics**; the live loop proves the
  resident model can drive it.

## 10. Acceptance criteria

Each maps to a test or a named validation step. "Verified" requires code-path evidence.

**Permissions & gating**
- [ ] A config with no `permissions` block advertises **zero** browser/desktop tools (legacy unchanged). → unit: `PermissionResolver` + `ToolRegistry.definitions`.
- [ ] `permissions.browser: true` advertises the browser family; `false`/absent hides it and refuses dispatch. → unit.
- [ ] `permissions.desktop: true`/`false` behaves the same for the desktop family. → unit.
- [ ] `browser_screenshot`/`desktop_capture` are advertised **only** when the active model has `mmproj_path`; on a non-vision model they are withheld **and** refused at dispatch with a reason naming the model. → unit (both `VISION_ONLY_TOOLS` and `unavailableTools` halves agree) + `ModelTurn` test.
- [ ] A disabled tool cannot be invoked via the fallback (fenced-JSON) path either. → integration (fallback dispatch refused).

**Multimodal path**
- [ ] `browser_screenshot`/`desktop_capture` return `MultimodalToolResult` whose `content` is `[text, image_url(data:…)]` (the model receives the image inline, not just a path). → unit (mirror `ImageTool.test.ts`).
- [ ] The webview thumbnail path parses the saved screenshot path from the result text. → unit (`screenshotPath`).

**Browser loop (deterministic, no LLM)** — verified locally where Chromium is present; skip-with-message in CI without it.
- [ ] `browser_open` → `browser_screenshot` → `browser_click`(known element) → `browser_screenshot` yields a changed page state (DOM/URL/text). → integration (headless Chromium).
- [ ] Element-based and coordinate-based clicks both hit the intended target. → integration.
- [ ] A dead session handle returns "session expired; call `browser_open` again" (no crash, no stale reuse). → integration.

**Desktop loop (deterministic)**
- [ ] `desktop_capture` returns an image + `capture_id` + pixel size + DPI scale + mapping. → integration (real capture) / unit (mapping only).
- [ ] The image-px → virtual-screen transform is correct at 100% and 150% scale. → unit (pure function, no mouse).
- [ ] `desktop_capture` → `desktop_click`/`desktop_type` into a controlled window → `desktop_capture` shows the change. → integration (real, controlled target).

**Consequential confirmation**
- [ ] Setting `consequential: true` on `browser_click`/`desktop_click`/`browser_type`/`desktop_type` routes through `requestApproval` with `dangerous: true`; declining returns "User declined". → unit/integration (mirror the existing approval test).

**Live demos (Phase 5/6, resident vision model, no Holo4)**
- [ ] Browser: screenshot → click → screenshot, driven by the resident model, with the model visibly reading the screenshots and verifying the change. → live run, reported.
- [ ] Desktop: window screenshot → mouse action → screenshot, driven by the resident model on a controlled target, real mouse. → live run, reported.

**Non-regression**
- [ ] Existing tools and model configs are byte-identical / behavior-unchanged; `npm run type-check`, `npm run lint`, `npm test` green after the last change. → full gate.
