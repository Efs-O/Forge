# Browser and desktop tools

Forge's browser and desktop tools are disabled by default. Enable only the
capabilities you intend to use in your Forge configuration:

```yaml
permissions:
  browser:
    enabled: true
  desktop:
    enabled: true

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

Forge always refuses desktop control of VS Code windows, the secure desktop or
UAC prompts, and the taskbar. System key chords such as `win+*`, `alt+f4`, and
`ctrl+alt+*` are never automatically approved.

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
- With a vision-capable cloud model, capturing an entire monitor requires an
  explicit `monitor` argument and an approval that names the cloud provider.
  Window capture follows the normal target-window approval flow.
- Screenshots are stored under
  `~/.forge/screenshots/<conversation-id>/`, outside the workspace. This keeps
  potentially sensitive desktop captures out of project directories and source
  control.
