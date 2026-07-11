# Forge Hardening and Configuration Onboarding Plan

## Goal

Preserve Forge's current architecture and product direction while tightening its
permission guarantees, making Keep/Undo reliable for every mutation, reducing
orchestration complexity, restoring clean quality gates, and giving new users a
configuration experience that does not require them to hand-write model entries.

This is a hardening and onboarding release, not a redesign.

## Recommended Configuration Experience

Do not ship or ask users to rename the maintainer's `.forge/config.yaml`. It is a
personal machine inventory containing paths, model choices, aliases, endpoints,
and tuning decisions that will not transfer safely to another computer.

Use three configuration layers instead:

1. **Setup wizard (primary path)**
   - Keep the existing first-run wizard as the default onboarding experience.
   - Let llama.cpp users choose a `llama-server` executable and one or more GGUF
     directories, then scan and multi-select discovered models.
   - Let Ollama users connect to an endpoint and multi-select models returned by
     `/api/tags`.
   - Generate model names and conservative spawn suggestions automatically.
   - Show a preview, validate it with `ForgeConfigSchema`, then write the global
     config without requiring the user to rename or move a file.
   - Never place API keys in YAML; keep using SecretStorage commands.

2. **Small starter templates (manual fallback)**
   - Add sanitized, copy-ready templates for:
     - `config/starter/llama-cpp.yaml`
     - `config/starter/ollama.yaml`
     - `config/starter/openai-compatible.yaml`
   - Each template should contain one clearly marked placeholder model and only
     the settings needed to start.
   - Users should copy the appropriate template to `.forge/config.yaml`, replace
     the marked values, and run `Forge: Validate Config`.

3. **Comprehensive reference example (advanced users)**
   - Keep `config/config.example.yaml` as the documented reference for profiles,
     aliases, MCP, embeddings, search, control server, and advanced sampling.
   - Do not turn it into a large catalog of real model names. Provider catalogs
     change and local GGUF filenames are machine-specific.

The generated config should be a user's inventory. Forge should help populate
that inventory from the user's machine or daemon rather than shipping a fixed
inventory copied from the maintainer.

## Phase 1: Enforce Configured Permissions

### Work

- Add one canonical function that converts `ForgeConfig.permissions` into the
  allowed `ToolPermission` set.
- Use the resulting set both when advertising tool definitions and dispatching
  tool calls.
- Map individual tools precisely. In particular, distinguish network fetch from
  search and Git reads from Git writes if the current permission type is too
  coarse.
- Keep confirmation prompts as a second safety layer for allowed mutations.
- When a tool is disabled, omit it from the model request and reject direct or
  fallback calls defensively at dispatch.
- Update token estimation in `SidebarProvider` to use the same allowed set.

### Acceptance criteria

- Disabling filesystem writes prevents write tools from being advertised or run.
- Disabling terminal, fetch, search, or Git operations behaves independently.
- A malformed or fallback tool call cannot bypass the configured permissions.
- Unit tests cover every permission switch and the default behavior.

## Phase 2: Make Keep/Undo a Guaranteed Contract

### Work

- Extend registered mutating tools with explicit mutation metadata rather than
  inferring affected files from generic `path` or `filepath` keys.
- Have each mutating tool declare all affected paths before execution.
- Define checkpoint behavior for write, replace, create directory, move, delete,
  format, symbol rename, selection insertion, and any future mutation.
- Snapshot both source and destination for move/rename operations.
- Decide and document directory rollback semantics.
- Ensure partial tool failure either restores safely or leaves an accurate
  checkpoint and visible error.
- Keep diff cards and editor decorations driven by the same mutation metadata.

### Acceptance criteria

- Every registered mutating tool has a checkpoint strategy.
- Undo restores multi-file and source/destination mutations correctly.
- Keep discards exactly one completed turn checkpoint.
- New files and deleted files are restored correctly.
- Tests cover success, partial failure, cancellation, and repeated writes to the
  same file in one turn.

## Phase 3: Improve First-Run and Ongoing Model Management

### Work

- Extract config generation from `FirstRunWizard.ts` into a small tested module.
- Change GGUF and Ollama selection to support multiple models.
- Add `Forge: Add Model` so users can rerun discovery without replacing their
  existing config.
- Reuse the existing GGUF scanner, model heuristics, config loader, schema, and
  model picker; do not create parallel model parsing logic.
- Merge new entries by model name and require confirmation for conflicts.
- Validate generated YAML before writing it.
- Write through a temporary sibling file and rename it into place so interrupted
  writes do not corrupt the active config.
- Preserve comments and user formatting where practical; if safe structural YAML
  editing cannot preserve them, show a preview and make a backup before rewriting.
  Evaluate the `yaml` Document API for comment-preserving edits before adding it
  as a dependency; add it only if it materially improves safe merge behavior.
- Offer two destinations explicitly:
  - global config for all workspaces;
  - `.forge/config.yaml` for the current workspace.
- Stop tracking the personal `.forge/config.yaml` with `git rm --cached` and keep
  `.forge/config.yaml` ignored by default. This means removing it from future
  commits and distributable checkouts, not rewriting existing Git history.
- Before release, run a one-time secret scan over repository history. Rewrite
  history only if an actual secret is discovered and after coordinating the
  required credential rotation and repository cleanup.

### Acceptance criteria

- A new llama.cpp user can configure several discovered GGUFs without typing YAML.
- A new Ollama user can select several installed model tags without typing YAML.
- Adding a model does not remove profiles, aliases, or existing models.
- Generated configs pass `ForgeConfigSchema` validation before becoming active.
- No secrets or machine-specific maintainer paths ship in starter files.

## Optional Follow-up: Split High-Complexity Files

This is technical debt, not a release requirement. Large files are not defects by
themselves, and Forge currently type-checks, tests, builds, and packages cleanly.
Do not split these files solely to satisfy a line-count target.

Refactor incrementally only when real maintenance pressure provides a natural
boundary, such as:

- a new inference or tool-calling workflow makes `AgentLoop.ts` harder to change;
- unrelated agent behavior repeatedly regresses after localized changes;
- message routing or conversation state in `SidebarProvider.ts` becomes difficult
  to test independently;
- multiple contributors frequently conflict in the same orchestration file;
- control-server routing and lease behavior begin evolving independently.

When one of those triggers occurs, extract one responsibility at a time without
changing public behavior. Keep existing single points of truth and avoid
duplicating provider routing, permission resolution, constants, or message types.

`ControlServer.ts` is only slightly above the guideline and should remain intact
unless its responsibilities genuinely diverge. `AgentLoop.ts` is the first
candidate if future feature work creates a useful extraction boundary.

### Acceptance criteria for any future extraction

- The extraction is motivated by a concrete change or testing problem.
- Existing public APIs and observable behavior remain unchanged.
- Focused characterization tests exist before moving stateful behavior.
- Webview/host message types remain a single discriminated union.
- Canonical quality gates and packaging pass after every extraction.

## Phase 5: Restore Quality Gates

### Work

- Add `.gitattributes` with an explicit repository line-ending policy.
- Apply formatting once so lint passes consistently on Windows, Linux, and macOS.
- Treat the scripts in `package.json` as the canonical executable quality gates.
- Make GitHub CI invoke those scripts rather than maintaining a partially
  duplicated command list.
- Update `CLAUDE.md`, `AGENTS.md`, and other contributor instructions that list
  quality gates so they point to the same canonical npm scripts. Do not maintain
  a third independent set of raw commands.
- Ensure release publishing runs the same checks before publishing.
- Keep packaging as a separate release smoke check after the canonical CI command.

### Required gates

```bash
npm run type-check
npm run lint
npm test
npm run build
npm run package
```

### Acceptance criteria

- All gates pass locally and on every CI operating system.
- CI and `package.json` do not disagree about required checks.
- Line endings do not create platform-specific lint failures.

## Phase 6: Remove Provider-Specific Hidden Activation Behavior

### Work

- Remove the special activation-time import of `CEREBRAS_API_KEY`, or replace it
  with a generic, explicitly configured environment-to-SecretStorage import.
- Prefer the existing `Forge: Set Cloud Provider Token` command for interactive
  setup.
- Do not show provider-specific activation notifications unless the user initiated
  that setup action.
- Document OpenAI-compatible providers generically in the reference example.

### Acceptance criteria

- Activation has no undocumented provider-specific side effects.
- Every cloud token remains in SecretStorage.
- Generic OpenAI-compatible endpoints continue to work without special casing.

## Suggested Delivery Order

1. Permission enforcement and tests.
2. Checkpoint metadata and rollback tests.
3. Line-ending/CI repair.
4. Sanitized starter templates and removal of the personal tracked config.
5. Multi-model setup wizard and `Add Model` workflow.
6. Provider-specific cleanup.

The first three items reduce correctness risk immediately. The onboarding work
can then ship on a stable base. Large-file splits are optional, trigger-driven
maintenance work and are not part of this release sequence.

## Release Definition of Done

- A clean checkout passes every required gate.
- A first-time user can configure llama.cpp or Ollama without manually authoring
  a model catalog.
- Advanced users still have a complete sanitized reference configuration.
- Configured permissions are authoritative.
- Every mutation shown to the user is covered by Keep/Undo.
- No personal paths, API keys, or provider-specific hidden setup behavior ship.
- Optional orchestration-file splits are not required for release completion.
