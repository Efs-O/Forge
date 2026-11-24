# strata-monitor — vendored code

Everything in this folder is copied from **Strata** (https://github.com/Niko1221/Strata,
MIT License), commit `afcf3746a0613eb5c21c422ba0ca864ba08fb15b`, taken from
`serve/web/` on 2026-11-24. It stays **JavaScript and CSS**: nothing here is converted
to TypeScript or React, so upstream fixes can be read across line by line.

| File | Source | What it is |
| --- | --- | --- |
| `monitor.js` | `serve/web/app.js` | The Monitor page: the card grid, drag order, GPU picker, sparklines, context gauge, request table, conversation cache. |
| `monitor.css` | `serve/web/app.css` | Only the rules the Monitor markup and the cards it builds need. |
| `components.css` | `serve/web/components.css` | Verbatim. The Strata UI kit (`st-card`, `st-badge`, `st-table`, `st-btn`, `st-progress`, `st-gauge`, `st-metric`). |
| `tokens.css` | `serve/web/tokens.css` | Verbatim except the two font URLs (below). Design tokens, light and dark. |
| `sprite.svg` | `serve/web/sprite.svg` | Only the ten symbols this page draws. Inlined into the panel's HTML by `src/monitor/monitorHtml.ts`. |
| `fonts/` | `serve/web/fonts/` | Outfit variable woff2 + `OFL.txt` (SIL Open Font License 1.1). |
| `LICENSE` | `LICENSE` | Strata's MIT text. |

`fonts/OFL.txt` covers the fonts; `LICENSE` covers the code and CSS. Both ship next to
the files they apply to.

## Every change from the original

`monitor.js` — the code is verbatim except for these, each also marked `// Forge:` at
its place in the file:

1. **Data comes from the host, not `fetch`.** Strata's `poll()` (`GET /metrics`, the
   401/API-key path, the retry counter, the load/unload hold `metricsHold`/`metricsAgree`
   and the MCP tick) is replaced by a `message` listener for
   `{type:'monitorMetrics', metrics}` that calls the same `render(m)` path, plus one
   `{type:'ready'}` post at startup so the host sends the first reading. `lastMetrics`,
   `reqShowAll` and `reqClearedAfter` — the bookkeeping the render and the buttons read —
   are kept.
2. **`store` persists through the webview, not `localStorage`.** Same keys
   (`monitor.cardOrder`, `monitor.hiddenCards`, `monitor.gpu`), same `get`/`set` shape,
   backed by `acquireVsCodeApi().getState()`/`setState()`, which VS Code keeps for the
   panel. `Reset layout`'s two `localStorage.removeItem` calls became `store.set(key, null)`.
3. **Icons resolve in-document.** `SPRITE` is `""`, so `icon()` emits
   `<use href="#i-…">` against the sprite inlined in the HTML — an external `<use href>`
   across the webview origin is unreliable.
4. **No chat, tabs, MCP, load/unload, API key or toasts.** `render(m)` keeps only the
   Monitor branch (`renderMonitor`, `renderConvCache`); the header pill (`setPill`, `tr`,
   `modelButton`), `imageLive`/`imageBusy`/`busy`/`modelOp` and the MCP card are not
   copied. In `renderMonitor` the state pills and the state sentence therefore follow the
   engine's own `live.state` alone, with no page-local "Loading"/"Unloading" guess — this
   panel cannot start or stop the model.
5. **`Clear` stays client-side.** Strata also POSTs `metrics/reset` and re-polls; that
   server call is gone. The button keeps Strata's `reqClearedAfter` cutoff, which hides
   the rows already shown in this view.
6. **Hide-when-absent** (added for the llama.cpp engine, so a card with no source is
   hidden instead of showing dashes): `gpu` hides when util, mem, temp and power are all
   absent; `vram` when both mem figures are absent; `temp` when `gpu_temp` is absent;
   `power` when power and its limit are absent; `pcie` when no generation and no in/out
   rate is present; `cpu` when cpu%, cpu power and the thread count are all absent; `disk`
   when there is no reading and `hardware_static.psutil` is false. Strata already hides
   `all-power`, `cpu-temp`, `forge`, `ups` and `speculation` by the same mechanism.
   Nothing is ever shown as a made-up zero.

`monitor.css` — the rules that made Strata's `.view--monitor` the scroll area are applied
to `.monitor`, because this panel has no tab strip; `.monitor-credit` is new. The chat,
images, About, MCP, drawer and settings rules were not copied.

`tokens.css` — `url("../fonts/…")` became `url("fonts/…")` for the vendored layout.

`sprite.svg` — trimmed to the ten symbols used (`gpu`, `cpu`, `disk`, `thermometer`,
`bolt`, `link`, `clock`, `gauge`, `layers`, `copy`). The `forge` and `close` icons are
inline in `icon()` upstream, so they are not needed here.
