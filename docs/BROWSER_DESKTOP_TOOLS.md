# Browser and desktop tools

Forge's browser and desktop tools are disabled by default. Enable only the
capabilities you intend to use in your Forge configuration:

```yaml
permissions:
  browser:
    enabled: true
  desktop:
    enabled: true
    # Optional: allow control of the ordinary VS Code `code` process. Off by
    # default; see "Controlling VS Code" below.
    allow_vscode: false

browser:
  channel: chrome # chrome, msedge, or chromium
  headless: false
  allowed_origins:
    - https://example.com
```

`permissions.browser.enabled` and `permissions.desktop.enabled` are separate
switches. Omitting either setting, or setting it to `false`, denies that tool
family. The top-level `browser:` block selects the browser channel, whether it
runs headlessly, and optional configured allowed origins.

## Browser sessions

Browser tools launch the configured system browser channel. `chrome` and
`msedge` use Chrome or Microsoft Edge installed on your computer. Forge starts
a separate browser process with a fresh, ephemeral profile: it never attaches
to your existing Chrome instance, reads your normal profile, or accesses your
open tabs, saved passwords, cookies, or history.

Forge does not download a browser automatically. The `chromium` channel is for
a manually installed/downloaded Chromium build; install and configure that
yourself before selecting it. If the selected channel is unavailable, Forge
reports the problem rather than silently switching to a different browser.

## Screenshots, coordinates, and DPI

`browser_screenshot` and `desktop_capture` report the image they actually
returned. Their text includes the saved image's dimensions and its
`coord_space`, for example:

```text
Screenshot of tab "t1" (example.com), 1280x720 px, coord_space=image_px.
```

Use the reported coordinate space when giving coordinate arguments:

- `image_px` means coordinates are pixels in the returned screenshot.
- `norm_1000` means coordinates use a normalized 0–1000 grid.

Desktop input is ultimately converted to **physical display pixels**. Capture
metadata includes the capture size, DPI scale, and origin so Forge can map the
reported screenshot coordinates into the correct physical screen location,
including multi-monitor layouts. Do not assume that a screenshot's displayed
size, logical DPI-scaled size, and physical-pixel size are identical.

Desktop coordinate actions require the `capture_id` returned by
`desktop_capture`; there is no implicit "current screen" target.

### Browser element targets and action latency

`browser_inspect` returns numbered interactive elements with bounding boxes and
a re-selectable selector. Those numbers are bound to the last inspection of that
tab and to the exact DOM node it showed, not to a re-count:

- `browser_click`, `browser_type`, and `browser_hover` with an `index` act on
  that same node. Before acting, Forge re-checks that it is still attached,
  visible, and unchanged in role and text. If the page changed underneath you —
  including a page-script mutation with no navigation, or an identical sibling
  inserted before the target — Forge refuses and tells you to inspect again
  rather than acting on whatever now occupies that number.
- A main-frame navigation, a closed tab, or a closed browser drops the
  inspection for that tab, so an index from a previous page cannot resolve
  against a same-URL coincidence.
- `browser_type` uses `fill` on the node itself and reports a clear refusal when
  the target is not editable, instead of typing at whatever a click happened to
  hit.

Coordinate arguments to `browser_click`, `browser_hover`, `browser_scroll`, and
`browser_drag` must be inside the viewport. Forge refuses a point outside it
before dispatching anything, and names the point and the viewport size — a
coordinate `browser_click` outside the viewport used to report success while
doing nothing.

Selector and index actions are bounded at **5 seconds** each. A selector that
matches nothing, or an element that never becomes actionable, fails in about
five seconds with the tool, action, and target named, instead of waiting
Playwright's default 30 seconds. Navigation keeps its own 30-second timeout, and
a timed-out action is never retried automatically and never reported as success.

`browser_press` sends keys to the page or to a selector inside it. It does not
operate browser chrome, and it does not open or drive DevTools —
`browser_inspect` is the supported way to inspect a page.

## Approvals and action safety

Browser and desktop controls use different structural approval gates:

- **Browser origin approval:** The first navigation or input action on each new
  origin asks for approval once per browser session. This applies even when
  page content tells the agent to navigate, type, or submit something.
- **Desktop target-window approval:** Focusing or capturing a desktop window
  asks permission to control that specific target. The approval binds to its
  HWND and process ID. Before every desktop input, Forge verifies that the
  approved window is still foreground and that the input point is within it.
  If that check fails, capture or focus the intended window again.

Forge refuses desktop control of the secure desktop or UAC prompts and the
taskbar, and of every editor except the ordinary VS Code process. System key
chords such as `win+*`, `alt+f4`, and `ctrl+alt+*` are never automatically
approved.

### Controlling VS Code

By default Forge refuses to control VS Code at all, because the agent runs
inside that editor and could otherwise type into its own chat input. If you want
it to drive VS Code deliberately, set both switches:

```yaml
permissions:
  desktop:
    enabled: true
    allow_vscode: true
```

What that opt-in does and does not allow:

- It matches the **process name** `code` / `code.exe` only. It never matches a
  window title, never the `Chrome_WidgetWin_1` window class, and never a fork —
  `Code - Insiders`, Cursor, Windsurf, VSCodium, and `devenv` stay refused no
  matter what you set.
- Every one of the six input tools — `desktop_move_mouse`, `desktop_click`,
  `desktop_drag`, `desktop_scroll`, `desktop_type`, `desktop_press` — asks for
  an explicit confirmation **on each call** when its target is a VS Code window,
  naming that window and the action. Approving the window with
  `desktop_focus_window` or `desktop_capture` is not a substitute, and neither
  is the tool being normally auto-approved. A consequential click or a system
  chord keeps its own stronger warning alongside the VS Code one.
- The policy is re-read before every input, including an input that arrives
  through a `capture_id` taken earlier. Turning `allow_vscode` back off drops
  the VS Code approval and that window's captures immediately, without touching
  approvals or captures for any other window. Re-enabling it does not resurrect
  the old approval: focus or capture the window again to bind a new one.

A manual smoke test of this path should use a disposable VS Code window and
harmless text — never the live Forge chat input, and never a command that
reloads the extension host.

Some browser and desktop input tools also accept `consequential: true`. This
marks an action such as submitting a form, purchasing, sending a message, or
deleting data as potentially consequential and requests an additional dangerous
action confirmation. It is a helpful hint, not the security boundary: the
origin and target-window gates are the controls that enforce where an action
can occur.

## Visible background GUI launches

`exec_command` normally starts a background process with no window. Add
`show_window: true` when the point of launching it is to put a GUI on screen and
then drive it with the desktop tools:

```json
{ "command": "notepad.exe", "args": [], "background": true, "show_window": true }
```

- It requires `background: true` and Windows, and it must be a real boolean. A
  request that violates either is refused before anything is spawned.
- Console helpers keep the existing hidden default; the flag is never inferred
  from the program name.
- It changes visibility only. It grants no desktop target approval — focusing or
  capturing the window is still what asks for that.
- The execution ID tracks the process Forge started, not any window or child GUI
  app it opens. A launcher such as `write.exe` can report `completed` while its
  GUI stays open, and `stop` will not close that GUI. The tool result says this
  whenever a visible launch is used.

Desktop text input is UTF-8 end to end. Text sent to `desktop_type` is decoded
explicitly by the desktop driver, so accents, Greek, CJK, and emoji arrive as the
characters you sent rather than as code-page mojibake, and a request containing
invalid UTF-8 is refused instead of being typed as replacement characters.

## Limitations and screenshot storage

- Desktop tools are available only on Windows. On other platforms Forge reports
  that desktop tools are unsupported instead of attempting a partial action.
- With a vision-capable cloud model, capturing a monitor requires an explicit
  `monitor` argument and an approval that names the cloud provider. Window
  capture follows the normal target-window approval flow.
- `desktop_capture` with `monitor: N` captures exactly **one** display: index 0
  is the primary, and higher indices are the other displays in a deterministic
  order (physical left, then top, then device name), re-enumerated per request.
  An index past the last display is refused with the available range; Forge does
  not quietly widen the capture to the whole virtual desktop instead. The result
  names the display it took (index, count, and Win32 device name) and reports
  the physical captured region separately from the returned image size, so a
  downscaled image is never mistaken for the captured area. Monitor captures are
  read-only — a coordinate action needs a window capture.
- Screenshots are stored under
  `~/.forge/screenshots/<conversation-id>/`, outside the workspace. This keeps
  potentially sensitive desktop captures out of project directories and source
  control.
