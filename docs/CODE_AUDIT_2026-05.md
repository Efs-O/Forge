# Forge — Code Audit (2026-05-31)

Scope: full `src/**` + `webview-ui/src/**` TypeScript audit against the rules in
`CLAUDE.md`. Reviewer: automated pass (Claude). 85 `.ts`/`.tsx` files.

**Note on bridge.yaml:** the hardcoded absolute model paths in `bridge.yaml`
(e.g. `N:/GEMMA GGUF UNSLOTH/...`) are **intentional** per the project owner and
are explicitly **out of scope** for this audit — not reported as findings.

---

## Summary

Overall the codebase is in good shape and broadly compliant with `CLAUDE.md`:
no `console.*` in `src` (logger used throughout), no `TODO`/`FIXME`/`HACK` debt
markers, every `any` is justified with an inline `eslint-disable` + rationale,
and no real hardcoded OS paths leak into source. The findings below are mostly
concentrated in the **new, still-uncommitted embedding/search code**.

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | High | Architecture | `EmbeddingBackend` is a 2nd `llama-server` spawn site | ✅ Fixed |
| 2 | High | Lifecycle | `EmbeddingBackend` child process is never disposed | ✅ Fixed |
| 3 | Medium | File size | `SidebarProvider.ts` (431) and `AgentLoop.ts` (406) exceed 350 LOC | Open |
| 4 | Medium | File size | `extension.ts` is at the limit and still accreting | Open |
| 5 | Low | Error handling | Silent `catch {}` in `AgentLoop.ts` | ✅ Fixed |
| 6 | Low | Robustness | Fragile `search:` substring check in config append | ✅ Fixed |

Findings 1, 2, 5, 6 were resolved on 2026-05-31 (see "Resolution" notes below).
Findings 3 and 4 (file-size splits) remain open.

Session fixes already applied (for context): GGUF scan hang-proofing (v0.12.2),
graceful global-config-failure handling in `activate()`, `.vscodeignore` excludes
stray HTML.

---

## 1. High — `EmbeddingBackend` is a second `llama-server` spawn site

`CLAUDE.md` Architecture Rules: *"`llama-server` lifecycle stays isolated in
`src/backend/DirectBackend.ts` (sole spawn site)"* and Hard Stops: *"No duplicate
implementations."*

`src/backend/EmbeddingBackend.ts` independently does:
- `spawn(binary, args, …)` (`EmbeddingBackend.ts:75`) — a parallel `llama-server`
  launch outside `DirectBackend`.
- `spawn('taskkill', ['/PID', …, '/T', '/F'])` (`EmbeddingBackend.ts:114`) plus
  `proc.kill()` fallbacks — a near-verbatim copy of the teardown logic in
  `DirectBackend.ts:225-228`.

This duplicates the exact process-management code `DirectBackend` owns and breaks
the single-spawn-site invariant.

**Recommendation:** extract the spawn + graceful-kill sequence into a shared
helper (e.g. `src/backend/llamaProcess.ts`, or reuse `execHelpers`) and have both
`DirectBackend` and `EmbeddingBackend` call it. Keeps one source of truth for how
Forge starts/stops a `llama-server`.

**Resolution (2026-05-31):** added `src/backend/llamaProcess.ts` exporting
`spawnLlamaServer()` and `killLlamaProcess()`. Both `DirectBackend` and
`EmbeddingBackend` now spawn and tear down through it; the duplicated kill block
is gone. Two running servers as before, one piece of launch/teardown code.

## 2. High — `EmbeddingBackend` child process is never disposed

`CLAUDE.md` TypeScript Rules: *"Dispose VS Code resources (…child processes) in
`deactivate()` and via `context.subscriptions.push(...)`."*

- `extension.ts:132` creates `const embeddingBackend = new EmbeddingBackend(config)`.
- It is passed into `IndexManager` but is **never** `context.subscriptions.push`-ed,
  and `embeddingBackend.stop()` (exists at `EmbeddingBackend.ts:92`) is never called.
- `deactivate()` (`extension.ts:377-379`) is empty.

If the embedding backend ever spawns its `llama-server`, that process **leaks** when
the window closes / extension deactivates.

**Recommendation:** make `EmbeddingBackend` implement `vscode.Disposable`
(`dispose()` → `stop()`) and `context.subscriptions.push(embeddingBackend)` at
creation — or ensure `IndexManager` is disposed and forwards disposal. Verify the
same for `IndexManager` (file watchers / debounce timers).

**Resolution (2026-05-31):** `EmbeddingBackend` now `implements vscode.Disposable`
with `dispose()` → `stop()` (and disposes its output channel), and
`extension.ts` registers it via `context.subscriptions.push(embeddingBackend)`.
The spawned embedding server is now killed on deactivate. `IndexManager` disposal
(watchers/timers) still worth a follow-up check.

## 3. Medium — Two owner files exceed the 350-LOC hard limit

`CLAUDE.md` File Size Limit: *350 LOC max per source file, no exceptions.*

- `src/sidebar/SidebarProvider.ts` — **431**
- `src/sidebar/AgentLoop.ts` — **406**

Both are canonical owners, so the fix is to split, not relocate logic elsewhere.

**Recommendation:**
- `SidebarProvider.ts` — extract webview message-bridge wiring (it already has a
  dedicated owner `messageBridge.ts`) and/or the command-ish handlers.
- `AgentLoop.ts` — extract the streaming/cancellation lifecycle bookkeeping
  (`cancelControllers`, `streamingSettledMap`) into a small helper module.

## 4. Medium — `extension.ts` is at the limit and still growing

`extension.ts` is ~370 lines and mixes activation, setup-mode, backend wiring,
file watchers, and a large block of inline `registerCommand` handlers
(`forge.setSearchApiKey` alone is ~50 lines writing YAML).

**Recommendation:** move the command handlers into `src/vscode/nativeCommands.ts`
(its existing owner) and keep `activate()` to wiring only. This also reduces the
risk of repeated growth past 350.

## 5. Low — Silent `catch {}` in `AgentLoop.ts`

`CLAUDE.md` No-Fallbacks: *"No silent error swallowing."*

`AgentLoop.ts:96` — `try { await this.activeBackends.get(id)?.stop(); } catch {}`
swallows backend-stop failures during cancel with no trace.

**Recommendation:** log at debug level (`log.debug('backend stop during cancel failed', err)`).
Acceptable to continue, but not silently.

**Resolution (2026-05-31):** the cancel-all `catch` now logs at debug level.

## 6. Low — Fragile `search:` detection when appending to config.yaml

`extension.ts:346` guards the search-block append with
`if (!existing.includes('search:'))`. A `search:` substring inside a comment or an
unrelated string would suppress a legitimate append (or vice-versa).

**Recommendation:** parse the YAML and check for a top-level `search` key, or match
an anchored line (`/^search:/m`) instead of a bare substring.

**Resolution (2026-05-31):** replaced the substring check with an anchored
`/^search:/m` test.

---

## Confirmed healthy (no action)

- **`any` usage:** 5 occurrences, each with `eslint-disable-next-line` + rationale
  (untyped `vscode.git` API, untyped `package.json`, schema-validated tool args).
- **Logging:** zero `console.*` in `src`; structured `logger` used throughout.
- **Debt markers:** no `TODO`/`FIXME`/`HACK`/`XXX`, no `@ts-ignore`.
- **Hardcoded paths:** none in source except example placeholders in
  `FirstRunWizard.ts` input boxes (`D:\models`, `/usr/local/bin/llama-server`).
- **Network surface:** new embedding/search code talks only to the local
  `llama_server.host` (`127.0.0.1`) — no new outbound endpoints introduced.

---

## Remaining work

Findings 1, 2, 5, 6 are resolved. Still open:

1. (#3) Split `SidebarProvider.ts` (431) and `AgentLoop.ts` (406) back under 350 LOC.
2. (#4) Move `extension.ts` inline command handlers into `nativeCommands.ts`.
3. Follow-up: verify `IndexManager` disposes its file watchers / debounce timers.
