# Forge — Open Issues

## 1. Chat scroll resets to top when agent stops

**Symptom:** After the agent finishes a turn, the sidebar chat scrolls back to the
first message in the session.

**Root cause:** `SESSION_SYNC` fires after every agent turn. The reducer rebuilds
every message with a new random ID (`mkId()`). React sees all-new keys → unmounts
and remounts the entire message list → browser resets `scrollTop` to 0 → the
`onScroll` handler marks `userScrolledUp = true` → auto-scroll-to-bottom skips →
user is stuck at the top.

**Fix applied:** `webview-ui/src/reducer.ts` — `SESSION_SYNC` now reuses the
existing message ID when role + position match, so React reconciles in-place
instead of rebuilding the DOM.

---

## 3. Keep llama-server alive when adopting window closes

**Observation:** When Window 1 (the spawner) closes, it kills the llama-server even if
Window 2 (which adopted it) is still running. Window 2 loses the backend mid-session.
In practice this is acceptable — models reload in ~15s and the next prompt auto-restarts.

**Possible fix:** Track `adopted = true` when a window reuses an existing server instead
of spawning. In `stop()`, skip `stopLlamaServer()` if `adopted === true`. The spawner
window would still kill the server on close, but at least adopted windows never cause a
double-kill. A full reference-counted solution (lock file) is possible but adds crash
edge cases not worth the complexity yet.

**Status:** Not yet fixed. Monitor in practice — if model reload on window close becomes
annoying, implement the `adopted` flag first.

---

## 2. Sessions are not scoped to the workspace

**Symptom:** Opening any workspace shows chats from all other workspaces
(e.g. opening Forge shows sessions from Gemma4Kids, etc.).

**Root cause:** `extension.ts` passes `context.globalState` (shared across all
workspaces) to `SidebarProvider` as its session store. A previous migration
intentionally moved sessions from `workspaceState` → `globalState`, making them
global.

**Fix applied:** `extension.ts` now passes `context.workspaceState` to
`SidebarProvider`. A one-time migration (v2) seeds each workspace's `workspaceState`
from `globalState` on first activation so no existing history is lost.
