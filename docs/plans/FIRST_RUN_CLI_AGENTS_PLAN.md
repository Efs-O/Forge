# First-run: CLI agents, GPU layers, and the load-failure message

## Problem

A new user on a clean machine gets a Forge that cannot reach Claude Code or
Codex, and a llama.cpp config that is silently slower than it should be. None
of it shows on the maintainer's machine, whose `config.yaml` predates the
wizard. First recorded 2026-08-23 in a local-only report and never tracked.

1. **The setup wizard never writes `provider: cli` entries.** Claude and Codex
   are reachable only through hand-written YAML that nothing mentions.
2. **The example config says `cli: 'xxxx/claude.exe'`**, implying an absolute
   path is required. It is not: `resolveCliExecutable`
   (`src/agents/resolveCliExecutable.ts`) PATH-resolves any non-absolute value,
   and a bare name survives CLI upgrades and other usernames.
3. **`makeLlamaCppStarterConfig` writes `n_gpu_layers: -1`.** On current
   llama.cpp that is auto-fit, not "all layers" — the documented slowdown in
   `LlamaServerArgs.ts`. The code default is already `999`; the wizard
   overrides it with the wrong value.
4. **A model that does not fit reports only `llama-server exited with code N`.**
   The cause is in the stderr tail, which reaches the log and output channel but
   not the error the user sees. With `999`, "does not fit" becomes a hard load
   failure instead of a silent CPU spill, so it must name the setting to lower.
5. **The README's setup steps for CLI agents are missing**, and its delegation
   section still says CLI delegates are read-only (they run unrestricted — see
   CLAUDE.md "CLI Agent Delegation").

## Design

- `StarterConfig.ts`: `makeLlamaCppStarterConfig` writes `n_gpu_layers: 999`.
  New pure `withCliAgents(config, found)` appends
  `{ name: 'claude-code', provider: 'cli', cli: 'claude' }` and/or
  `{ name: 'codex', provider: 'cli', cli: 'codex' }` for the CLIs found. Bare
  names, never resolved absolute paths. It does not change `active_model` — a
  local model stays the default chat.
- `FirstRunWizard.ts`: before writing, probe `claude` and `codex` with the
  existing `resolveCliExecutable` (no second PATH lookup), pass the result to
  `withCliAgents`, and name what was added (or how to add it later) in the
  reload toast. No extra prompt: the entries are visible in the YAML and inert
  until selected.
- `serverDiagnostics.ts`: `attachServerDiagnostics` also returns
  `stderrTail()`. New pure `describeStartupFailure(tail)` returns a VRAM hint
  naming `n_gpu_layers` and `num_ctx` when the tail matches an out-of-memory
  signature (whole phrases: `out of memory`, `cudaMalloc failed`,
  `failed to allocate`, `unable to allocate`), else the last 300 chars of the
  tail. `DirectBackend` appends it to `llama-server failed to start: ...`.
- `config/config.example.yaml`: `cli: claude` / `cli: codex`.
- `README.md`: a "Claude Code and Codex" setup block — install + log in to each
  CLI, `crossSessionInbound`, MSI PowerShell 7 and Git Bash on Windows — and fix
  the read-only claim.

## Files touched

`src/config/StarterConfig.ts`, `src/sidebar/FirstRunWizard.ts`,
`src/backend/serverDiagnostics.ts`, `src/backend/DirectBackend.ts`,
`config/config.example.yaml`, `README.md`, tests in
`test/unit/StarterConfig.test.ts` and `test/unit/serverDiagnostics.test.ts`.

## State × lifecycle ledger

The only durable artifact is the `config.yaml` the wizard already writes; this
plan adds entries to it and creates no new file, directory or setting.

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `models[]` CLI entries in `config.yaml` | wizard, only for CLIs found on PATH | user edits the YAML; wizard "Replace config" rewrites with a `.bak` | not selecting the model; entries are inert until chosen | `writeConfigSafely` writes via temp + rename, so the old file or the new one, never half | nothing runs; entries are data | none — a CLI uninstalled later fails at spawn with `resolveCliExecutable`'s "not found on PATH" error |
| `llama_server.n_gpu_layers: 999` | wizard | user edits the YAML | user sets a lower count per model or globally | same temp + rename | n/a | none |

CI-enforced row: `StarterConfig.test.ts` asserts the starter config never
contains `n_gpu_layers: -1` and that CLI entries use bare names, not absolute
paths.

## Acceptance criteria

- A wizard run on a machine with `claude`/`codex` on PATH writes the matching
  `provider: cli` entries with bare `cli` names; with neither, writes none and
  the toast says how to add them.
- The starter llama.cpp config has `n_gpu_layers: 999`.
- A llama-server that dies on an out-of-memory error reports a message naming
  `n_gpu_layers` and `num_ctx`; any other early exit includes its stderr tail.
- The example config and README show bare `cli` names and the CLI setup steps.
- `npm run ci` and `npm run package` pass.
