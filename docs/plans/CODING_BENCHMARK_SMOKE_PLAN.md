# Coding benchmark smoke test plan

Status: implementation-ready plan. This document intentionally records the
smallest useful first experiment before any multi-task leaderboard work.

## Goal

Run one **SWE-bench Verified** instance once with four coding-agent arms, then
produce one auditable report:

1. `qwen-minimal` — Qwen3.8-27B through a direct llama-server started with
   only the baseline server arguments and a neutral, minimal tool loop.
2. `qwen-forge` — the same model loaded through Forge's configured spawn
   parameters and real local-model loop.
3. `claude-code` — the authenticated Claude Code CLI launched by Forge's
   existing CLI integration.
4. `codex` — the authenticated Codex CLI launched by Forge's existing CLI
   integration.

This is a pipeline smoke test, not a claim of a statistically meaningful
ranking or a SWE-bench score. The result is one task outcome per arm.

## Non-negotiable comparison rules

All four arms receive:

- the exact official `problem_statement` for one pinned SWE-bench Verified
  `instance_id`;
- a new clean checkout at the task's exact `base_commit`;
- the same wall-clock limit (default 30 minutes); and
- the official SWE evaluator on the final patch.

The benchmark records the supplied task text verbatim, checks the starting Git
HEAD before each agent starts, and grades every result with the official test
patch/evaluator. An agent may inspect and change only its own checkout.

The report must call out the real harness distinction:

| Arm            | Agent/tool ownership                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| `qwen-minimal` | benchmark's intentionally small shared tool host                                         |
| `qwen-forge`   | Forge's native `ToolCallingLoop`, prompt/context policy, and benchmark tool host         |
| `claude-code`  | Claude Code's native tool loop; Forge owns launch, workspace and transcript capture only |
| `codex`        | Codex's native tool loop; Forge owns launch, workspace and transcript capture only       |

Therefore Claude/Codex are not described as using Forge's native tool registry.
They are reference agents on the same task and workspace contract.

## Reuse-first implementation map

No new generic agent framework is to be built.

| Need                    | Existing Forge / CacheWarden component                                   | Benchmark action                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Qwen production loop    | `src/agent/ToolCallingLoop.ts`                                           | Call it for `qwen-forge`; do not copy its recovery, request, or tool-call parsing code.                                        |
| Qwen minimal baseline   | `test/live/liveModelHarness.ts`                                          | Promote only the minimal request/round mechanics needed for a neutral loop; keep prompt and context policy deliberately small. |
| Claude/Codex invocation | `src/agents/CliAgentDriver.ts` and adapters                              | Reuse the existing executable resolution, argument construction, streaming events, timeout, and cancellation behavior.         |
| Local tool semantics    | current Forge file/search/edit/test helpers where decoupled from VS Code | Expose only the small benchmark allowlist: read, list/search, edit, and terminal/test. Both Qwen arms use this exact host.     |
| Qwen usage              | llama-server OpenAI `usage` and `/props`                                 | Persist raw usage and server metadata per run.                                                                                 |
| Codex usage             | CacheWarden `CodexJsonlParser.ts`                                        | Reuse/adapt its parser for the session's `token_count.last_token_usage` record.                                                |
| Claude usage            | CacheWarden `CacheKeepManager.getClaudeTokenUsage` logic                 | Reuse/adapt its bounded-tail parse of `message.usage`: normal input + cache creation + cache read.                             |
| Isolated workspaces     | Forge's temporary-workspace test patterns plus Git worktrees/clone       | One disposable task checkout per arm; never run an agent in the Forge checkout.                                                |
| Existing testing style  | Vitest, fake CLI fixtures, `scripts/*-ab.mjs`                            | Unit test parsers/orchestration with fakes; gate real model/provider work behind an explicit command.                          |

## Required new surface

Add a focused `scripts/forge-bench.mjs` command and small benchmark modules
under `src/benchmark/`. The command owns orchestration only:

1. load a versioned task manifest;
2. create four task workspaces from the pinned base commit;
3. run each selected arm sequentially and stream a concise live status line;
4. collect patch, stdout/stderr/transcript, timing, model/runtime facts, and
   usage evidence;
5. call the official evaluator after the agent has stopped; and
6. write `results/<run-id>/report.json` and `report.md`.

The default smoke command is:

```powershell
npm run bench:smoke
```

It must refuse before spending provider usage when any prerequisite is missing:

- Docker/official SWE evaluator unavailable;
- the pinned task cannot be fetched or prepared;
- llama-server does not answer at the configured benchmark URL;
- Claude or Codex is absent/not authenticated; or
- the selected task workspace is not a clean Git checkout at `base_commit`.

`--dry-run` validates everything except agent calls and evaluation. `--arms`
allows a local-Qwen-only rehearsal; default is all four arms.

## Full-Forge Qwen boundary

Forge currently has no headless endpoint that submits a full sidebar local-model
turn. Its localhost control server only loads local models and proxies cloud
completions. Do not automate the VS Code webview and do not create a broad
remote agent endpoint just for this benchmark.

Instead, factor a narrow, non-UI benchmark entry point around the already
production-owned local loop. It must compose the same request construction,
system/template injection, context handling, tool definitions, tool budget and
`ToolCallingLoop` as `ModelTurn`; the only substitute is a deliberately
sandboxed benchmark tool host instead of VS Code UI tools. The task manifest
will declare the allowed tools so `qwen-minimal` and `qwen-forge` receive the
same effective capabilities.

This is the smallest change that permits one command while preserving the
meaningful Forge-vs-minimal comparison. It is not a public control-server API.

## Task and evaluation contract

The initial manifest pins one official `SWE-bench_Verified` instance. It stores
the dataset revision/name and `instance_id`, not a copied issue description or
gold patch. On first run, the bootstrapper obtains the official task record,
which contains `repo`, `base_commit`, `problem_statement`, `test_patch`, and
the evaluator metadata.

The agent sees only the repository at `base_commit` and `problem_statement`.
The official test patch is applied only by the evaluator after the run. The
gold patch is never downloaded into an agent workspace or results directory.

The report uses these result states:

- `PASS` — official evaluator reports resolved;
- `FAIL` — evaluator ran and reports unresolved;
- `ERROR` — setup, agent, patch collection, or evaluator infrastructure failed;
- `TIMEOUT` — agent reached its deadline; evaluator still runs if a patch exists.

The report ranks only the four outcomes for this task, with ties. It may show
published SWE figures in a **separate external-reference table**, including
dataset, harness, date, and source. It must say that `1/1` is not a SWE score
and must never extrapolate it to a percentage ranking.

## Metrics and artifacts

Each arm writes a self-contained directory:

```text
results/<run-id>/<arm>/
  manifest.json
  runtime.json
  agent-events.jsonl
  stdout.log
  stderr.log
  patch.diff
  evaluator/
  usage.json
```

`runtime.json` includes Forge commit/version, benchmark version, OS, task id,
base commit, timeout, CLI versions when available, and for Qwen:

- llama-server `/props` and `/v1/models` snapshot;
- model identifier/path reported by the server;
- context/KV/GPU/sampling facts passed to the server where available; and
- prompt/completion/cache usage returned by llama-server.

`usage.json` includes provenance and raw evidence. CacheWarden's parsers show
that the authoritative data comes from local agent transcripts, so the benchmark
will read only the fresh session identified by the run, after the CLI exits:

- Claude: `input_tokens`, `cache_creation_input_tokens`, and
  `cache_read_input_tokens`;
- Codex: `input_tokens` and `cached_input_tokens`.

If a CLI version does not write a recognised record, usage is `unavailable`;
the run still completes and the report does not estimate a cost.

## Smoke execution order

The run is sequential to avoid competing for VRAM, CPU, disk, Docker resources,
or provider CLI session state:

1. preflight all four arms and the task evaluator;
2. `qwen-minimal`;
3. `qwen-forge`;
4. `claude-code`;
5. `codex`;
6. evaluate every resulting patch;
7. generate the human-readable report and machine JSON.

The runner executes `qwen-forge` first, releases and unloads its Forge-managed
server, then starts the same GGUF through the single Forge-owned
`DirectBackend` lifecycle with only baseline arguments for `qwen-minimal`. It
captures `/props`, `/v1/models`, and endpoint facts for both phases so the
startup-parameter distinction is auditable.

## Safety and cost controls

- Provider agents run only after a deliberate all-arm preflight succeeds.
- The default is one run per arm and one task.
- No secret, CLI auth file, source task checkout, Docker image, or user session
  transcript is committed to Forge.
- Agent workspaces and temporary evaluator data are created under the selected
  results/temp root and are preserved on error for diagnosis.
- The runner never changes the user's Forge workspace or live configuration.
- CacheWarden is a source-level reference only; Forge gains no dependency on
  CacheWarden and does not touch its keep-alive settings.

## Delivery sequence

1. Add task-manifest schema, preflight, result schema, report renderer, and
   usage parsers with unit tests.
2. Add official SWE task bootstrap/evaluator adapter plus a dry-run fixture.
3. Add the neutral Qwen loop and the narrow full-Forge benchmark entry point;
   test both against a fake OpenAI server and fake tool host.
4. Wire the existing Claude/Codex driver and fake CLI fixtures into the same
   result contract.
5. Run `--dry-run`, then a Qwen-only real rehearsal, then the deliberate
   four-arm smoke run.
6. Only after the smoke report is clean, add a 10-task calibration suite and
   repeated local-Qwen runs.

## Acceptance criteria

- [ ] `npm run bench:smoke -- --dry-run` validates a pinned official task, all
      arm prerequisites, clean isolated workspaces, and report generation
      without invoking any model or CLI. (Automated fixture test.)
- [ ] Every real arm starts from the identical task repo/base commit and cannot
      alter another arm's workspace. (Integration test plus recorded SHAs.)
- [ ] `qwen-minimal` and `qwen-forge` use the same GGUF and benchmark tool
      allowlist, while their server startup phases are separately unloaded,
      reloaded, and recorded. (Lifecycle assertion.)
- [ ] `qwen-forge` calls production-owned Forge loop components rather than a
      copied implementation. (Unit test/spies at the extracted entry point.)
- [ ] Claude and Codex launch through `CliAgentDriver`/their existing adapters
      and retain native tool ownership. (Fake-CLI integration test.)
- [ ] A timeout or agent crash still preserves logs, patch if present, and an
      `ERROR`/`TIMEOUT` result without aborting later selected arms. (Fixture
      test.)
- [ ] PASS/FAIL comes only from the official evaluator result, never from an
      agent's final prose or a diff heuristic. (Evaluator adapter test.)
- [ ] Claude and Codex usage parsing correctly handles CacheWarden's current
      documented transcript shapes and reports unavailable cleanly for unknown
      shapes. (Parser fixtures.)
- [ ] The final Markdown report has separate local-task ranking and external
      SWE reference sections and explicitly says a one-task smoke result is
      not a SWE score. (Snapshot test.)
- [ ] `npm run type-check`, `npm run lint`, `npm test`, and `npm run build`
      remain green before the branch is proposed for merge. (CI validation.)
