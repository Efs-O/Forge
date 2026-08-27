# Config Overhaul + Model Manager Plan

Status: APPROVED — all questions (Q1–Q8) decided; ready for implementation.
Coordinator: Claude (Fable), worker: Claude Sonnet. Date: 2026-07-18

## 0. Problem statement (user's words, condensed)

1. `config.yaml` logic is bloated, complicated, hard to maintain/update
   (real file today: 732 lines, ~40 model entries, heavy copy-paste).
2. Auto-scan exists in Forge but user has no visibility into whether/how it works.
3. Local agents struggle to identify workers ("use gemma4" fails to resolve).
4. Wanted: shared "boards" of settings (tools, ctx, tool-call budgets…) applied
   to model groups, user-adjustable.
5. Wanted: a simple/elegant UI to manage the model zoo — scan a chosen dir,
   tabs for every param (provider, name, size, category, location, ctx,
   thinking, comments…), model path, delete-from-config and delete-from-disk
   (both with confirmation), fast keyboard nav (arrows/PgUp/PgDn/Del), autosave.
   Must stay readable/compatible for the Forge extension AND the Relay
   extension, exactly as before.
6. Wanted: Claude Code and Codex usable in Forge via the existing
   subscriptions — NOT via API key.

## 1. Current-state audit (grounded in code)

- Config: single `config.yaml` (workspace `.forge/` → global storage fallback),
  Zod-validated ([schema.ts](src/config/schema.ts)), file-watcher hot reload
  ([ConfigLoader.ts](src/config/ConfigLoader.ts)). Layering already exists:
  `defaults` < model fields < `profiles` (`model@profile`), plus `aliases`.
- Bloat source: the layering is per-REQUEST only. Spawn facts (`spawn:` block)
  and sampling blocks are duplicated verbatim across every llama.cpp entry
  (identical 8-line spawn + 7-line sampling blocks × 12 models), and every
  Ollama entry repeats endpoint/think/reasoning_effort/sampling.
- Auto-scan: [GgufScanner.ts](src/backend/GgufScanner.ts) — bounded scan
  (depth 5, 50 results, 8 s deadline) of `model_dirs` + HF caches on all
  drives. It works, but is only invoked by
  [FirstRunWizard.ts](src/sidebar/FirstRunWizard.ts) /
  [AddModelWizard.ts](src/sidebar/AddModelWizard.ts) — invisible day-to-day.
  Family hints cover qwen3/gemma4/llama/mistral/phi only; no quant/size
  metadata beyond bytes.
- Worker identification: [eligibility.ts](src/delegation/eligibility.ts) and
  `resolveRequestModel` accept ONLY exact configured names or exact alias keys.
  "gemma4" matches nothing (real names: `gemma4-26b-a4b-it-iq3s`,
  `gemma4:26b`, …). `list_worker_models` exists but small local models often
  skip it or still guess wrong afterwards.
- Claude/Codex today: `claude-via-gateway` points at a placeholder URL
  (dead entry, cannot work); `codex` is `provider: openai` + API key —
  neither uses a subscription.
- Relay compatibility: Relay does NOT parse config.yaml. It talks to Forge's
  control server (`:8799`, `GET /models` etc. —
  [forgeControlDiscovery.ts](../forge-relay/src/forgeControlDiscovery.ts)).
  → Contract to preserve is the control API + the config file path/semantics,
  not the YAML's internal shape. This gives us freedom.

## 2. Design (decisions applied)

### 2.1 Schema v2 — `groups` (the "boards") — DECIDED (Q1)

New optional top-level `groups:` — static membership bundles, orthogonal to
request-time `profiles` (both layers kept):

```yaml
groups:
  llamacpp-gemma:            # spawn + sampling shared by all local gemmas
    spawn: { n_batch: 512, type_k: 8, type_v: 8, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, stop: "<end_of_turn>" }
  ollama-local:
    provider: ollama
    endpoint: "http://127.0.0.1:11434"
    think: true
    reasoning_effort: medium
    sampling: { max_tokens: 131072 }
  workers:                   # the "board" idea
    tools: [read_file, list_directory, search_code, write_file, replace_in_file]
    tool_call_limits: { run_terminal: 0, web_search: 2 }   # NEW enforcement
    num_ctx: 131072
    max_output_tokens: 8192
    think: false
```

- Model entry gains `group: <name>` (or `groups: [a, b]`, merged in order).
- Precedence: `defaults` < group(s) < model fields < profile. Purely additive —
  a config with no `groups` behaves byte-identically to today.
- NEW runtime features carried by groups (and per-model overrides):
  - `tools:` allowlist (subset of registered tool names) — filters what is
    advertised/callable for that model. Enforced in ToolRegistry advertisement
    + dispatch.
  - `tool_call_limits:` per-tool max invocations per turn — enforced in
    AgentLoop/WorkerLoop. DECIDED (Q2): exceeding a budget returns a
    structured "budget spent, wrap up" tool result; never hard-fails the turn.
- Expected effect on the real config: ~732 → ~250 lines with zero behavior
  change (measured target; migration script must prove it via resolved-config
  diff).

### 2.2 Model identity & worker resolution fix

Root cause is exact-match resolution + long quant-suffixed names. Three-part fix:

1. `short_name:` (and keep `aliases`) per model, editable in the UI —
   e.g. `short_name: gemma4` on the preferred 26B entry.
2. Deterministic fuzzy resolver in `ConfigResolver` (single owner), used by
   chat picker, delegation, workers, and control server alike:
   exact name → alias → short_name → case-insensitive → unique
   prefix/substring. Ambiguous → structured error listing candidates
   (never guess between two matches).
3. Prompt-side: inject a compact catalog line into the coordinator system
   prompt when `delegate` permission is on ("Available workers: gemma4 →
   gemma4-26b-a4b-it-iq3s, qwen-worker → …") so small models don't need the
   `list_worker_models` round-trip at all. Keep the tool for long catalogs.

### 2.3 Model Zoo Manager UI

PRIMARY PURPOSE: lifecycle control of the model zoo, not param editing.
Today: ~40 configured models, ~5 actually used; trying a new model means
hand-editing YAML, then hunting HF snapshot paths to reclaim disk. The UI's
front page is the try/test/keep-or-purge loop and disk hygiene; the param
editor is a secondary detail drawer.

DECIDED (Q3): the UI is an HTML page hosted as a VS Code webview panel inside
Forge (`Forge: Model Manager` command, editor-area tab). A webview IS an HTML
page (same HTML/CSS/JS, full design freedom); standard extension feature, no
Marketplace issue. A browser-standalone page could not touch config.yaml,
disk, or the running backend — inside Forge it gets all three via the typed
message bridge, and reuses ConfigLoader/Writer/Zod/scanner (no second
codebase to drift).

DATA MODEL (user requirement — "database style"): the UI is a STATELESS VIEW
over config.yaml. On every open it reads the yaml fresh and populates all
fields; every edit validates (Zod) then writes back to the same file; if the
file changes on disk while open (hand edit, another window), the UI
live-reloads via the existing watcher. The UI stores no model data of its own
— only ephemeral UI state, plus usage timestamps in `.forge/state.json`.

The core lifecycle loop (each step one action):
1. Acquire — "Add model" via dir scan of user-downloaded GGUFs (Q8 decided:
   no in-UI downloads; scan-only, no new outbound traffic).
2. Register — config entry auto-generated from family detection + matching
   group (new qwen → qwen board: ChatML, top_k 20, standard spawn block).
   Zero YAML typing; testable seconds after download.
3. Test — "Load & try" from the list row: sets active_model, shows load
   status, size, VRAM estimate inline.
4. Verdict — Keep (tag/comment optional) or Purge = remove config entry AND
   delete gguf + sibling mmproj + emptied snapshot dir, single typed
   confirmation, refuses while the model is loaded. No path hunting.

Zoo hygiene (the 40-models problem):
- List sortable by size-on-disk and last-used; total-footprint header;
  "unused 30+ days" filter. Requires NEW lightweight usage tracking
  (last_used per model, stored in `.forge/state.json`, not in config.yaml —
  keeps config semantic, avoids watcher churn on every request).
- Dead-entry detection (config rows whose gguf_path vanished) and orphan
  detection (GGUFs on disk under model_dirs referenced by no config entry —
  pure wasted space today).
- Multi-select + Del for batch purge of squatters.

Layout: master-detail.
- Left: model list — name, provider badge, size-on-disk, last-used, group,
  category tag, loaded/active indicator. Nav: ↑/↓ move, PgUp/PgDn page,
  Space multi-select, Enter focus detail, Del = remove-from-config flow,
  Ctrl+Del = purge (config+disk) flow, Ctrl+S manual save (autosave is on
  anyway), `/` filter box.
- Right: detail drawer, tabs for the selected model:
  - Identity: name, short_name, aliases, provider, group(s), category
    (coding / vision / worker / experimental / cloud — new free-tag field),
    comment (multi-line, persisted).
  - Location: gguf_path / mmproj_path / endpoint / api_key_secret name,
    size on disk (live stat), quant + family (derived), "reveal in Explorer".
  - Runtime (llama.cpp): full `spawn:` block, extra args editor.
  - Request: num_ctx, think, reasoning_effort, system_prompt(+mode),
    strip_tools, capabilities.
  - Sampling: all SamplingConfig fields.
  - Tools: group-inherited toolset + limits with per-model override, shown
    resolved (inherited values greyed, overrides bold).
- Toolbar: "Scan directory…" (user-picked dir → GgufScanner → results list
  with add-checkboxes, dedup against configured paths), "Add model", "Groups
  editor" (edit boards themselves), provider filter.
- Autosave: debounced write-through on field commit; every save validates via
  Zod first — invalid edits stay in the UI marked red, never written to disk.
- YAML fidelity — DECIDED (Q4): add the `yaml` (eemeli) npm dependency;
  writer moves to document-mode editing so hand-written comments and key
  order survive round-trips. `comment:` also becomes a first-class per-model
  field so UI-authored notes don't depend on YAML comments.

### 2.4 Claude Code + Codex via existing subscriptions — DECIDED (Q5/Q6)

New provider `cli` — Forge spawns the locally installed, already-logged-in
CLI; auth lives entirely in the CLI's own login (subscription), no key in
Forge, no direct HTTP from Forge:

```yaml
- name: claude-code
  provider: cli
  cli: claude          # claude CLI on PATH, or explicit path
  group: external-agents
- name: codex
  provider: cli
  cli: codex
```

- Transport: `claude -p --output-format stream-json` (headless Agent SDK
  mode) and `codex exec --json`. Both stream; both run with cwd = workspace.
- DECIDED: these are EXTERNAL AGENTS with FULL RIGHTS using THEIR OWN tools
  (Read/Edit/Bash…), executed by the CLIs themselves in the workspace. Forge
  does NOT inject its tool registry into them and does not run its own tool
  loop for them — it sends the task, streams their output into chat/worker
  UI, and snapshots a checkpoint before any write-capable dispatch so
  Keep/Undo still covers their edits.
- Scope now: valid targets for `dispatch_workers` / delegation + direct chat
  in an "external agent" turn mode. Selecting one in the sidebar runs that
  dedicated CLI turn path with the agent's own tools; Forge's own tool loop is
  intentionally bypassed.
- DECIDED: CLAUDE.md Hard Stops amendment approved — add one line: "opt-in,
  user-configured local CLI agents (claude, codex) — spawned locally, auth
  via the CLI's own login, never via keys in Forge".
- The dead `claude-via-gateway` entry gets deleted; existing `codex`
  (provider: openai) entry replaced by the CLI entry.

### 2.5 Auto-scan upgrades (small)

- Surface scan in the Model Manager (2.3) — visible, on-demand, user-picked
  dir, results actionable. This answers "no idea if it works".
- Scanner improvements: extract quant (`Q4_K_M`, `IQ3_S`…) and family from
  filename into structured fields; skip mmproj files as model candidates and
  instead auto-suggest them as `mmproj_path` for sibling models; flag
  configured models whose gguf_path no longer exists (dead-entry detection).

### 2.6 Compatibility guarantees

- Same file, same locations, same watcher. Schema v2 is additive; v1 configs
  load unchanged (groups absent = current behavior).
- One-shot migration command `Forge: Compact config into groups` — rewrites
  the file using groups, then diffs the fully-resolved per-model output of
  old vs new and refuses to save on any mismatch. Backup written first
  (`config.yaml.bak-v2migration`).
- Control server `/models` unchanged; additively gains `short_name`, `group`,
  `category` fields. Relay keeps working untouched.

## 3. Final decisions (all questions closed)

- Q7 DECIDED: purge deletes gguf + sibling mmproj + emptied snapshot dir,
  as proposed.
- Q8 DECIDED: NO in-UI downloads. The Acquire step is scan-only — the user
  downloads GGUFs themselves; the UI scans and registers them. No new
  outbound traffic is added.

## 4. Implementation packaging (one-shot, coordinator → worker)

Order matters; each step ends green on `npm run ci`.

1. Schema v2: `groups`, `short_name`, `category`, `comment`, `tools`,
   `tool_call_limits`, `provider: cli` — Zod + types + resolver precedence +
   unit tests (resolved-config golden tests).
2. Fuzzy resolver + prompt catalog injection + eligibility/worker tests
   ("gemma4" acceptance test against the real-shape fixture).
3. Tool allowlist + call-budget enforcement in ToolRegistry/AgentLoop/
   WorkerLoop + tests.
4. Migration command + resolved-diff verifier; run on the real config.
5. `yaml`-based comment-preserving ConfigWriter + round-trip tests.
6. Model Zoo Manager webview (largest chunk — split: panel shell/list/
   keyboard, detail tabs, scan integration, lifecycle/purge flows, usage
   tracking). 350-LOC-per-file rule means ~8–10 new files under
   `src/sidebar/modelManager/` + webview UI files.
7. `cli` provider driver (spawn/stream/cancel/timeout, per-CLI adapters) +
   dispatch integration + CLAUDE.md/OWNERS.md/docs updates.
8. Control server additive fields + Relay smoke check.

Acceptance: real config migrated with zero resolved-diff; "use gemma4 for X"
dispatches correctly from a gemma coordinator; manager UI full keyboard pass;
claude/codex worker round-trip on the live subs; `npm run ci` + `npm run
package` green.
