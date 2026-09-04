# Handoff — SWE-bench Verified 50-task Qwen benchmark

**Status at handoff:** Everything is committed, quality-gated, and ready to run.
The 50-task run has **NOT started** — the command is staged in the terminal
waiting for the user to press Enter. Nothing is running.

Read this top-to-bottom in a fresh session before doing anything else.

---

## 1. What this task is

Benchmark Qwen3.8-27B on a stratified 50-task sample of **SWE-bench Verified**,
comparing two local arms:

- **`qwen-forge`** — the model loaded through Forge's configured spawn
  parameters and the real Forge `ToolCallingLoop`.
- **`qwen-minimal`** — the same GGUF through a direct llama-server with only
  baseline server args and a neutral, minimal tool loop.

The comparison is **Forge harness vs. minimal harness**, same model, same task
contract. This is a pipeline/capability smoke benchmark, **not** a SWE-bench
score and not a statistically meaningful ranking — say so in any report.

### Deferred arms (cost)
`claude-code` and `codex` are **out of scope for this run** — the user cannot
afford the token cost. Estimates and the exact resume commands are saved in
`benchmarks/COST_ESTIMATES.md`. Do **not** add them without the user re-approving
the cost. The suite JSON is 4-arm-shaped; the run simply selects the two Qwen
arms.

---

## 2. Exact state at handoff

| Item | Value |
| --- | --- |
| Working tree | Clean (only untracked `scripts/swebench-windows/__pycache__/` — a build artifact, do not commit) |
| Benchmark commit | `dfd3f20` — `feat(bench): 50-task stratified SWE-bench Verified suite + multi-arm pass-through` |
| Quality gates | `type-check` ✓, `lint` ✓, full `test` ✓ (unit + integration + webview) |
| `num_ctx` | `45000` in `.forge/config.yaml` (reduced from 58k to fit VRAM) |
| Run started? | **No.** Command staged in terminal, awaiting Enter. |
| Latest run dirs | `smoke-2026-09-03T07-36-39-686Z` (earlier smoke runs only) |

The benchmark commit hash is recorded in each arm's `runtime.json`, so the run
is reproducible against `dfd3f20`.

---

## 3. How to start the run (the single command)

From the workspace root (`n:\vs code apps\Forge`):

```powershell
npm run bench:qwen-suite -- --suite benchmarks/swe-bench-verified-50-suite.json --unload-chat-node
```

Flags:
- `--suite benchmarks/swe-bench-verified-50-suite.json` — the stratified 50-task
  sample (suite name: "SWE-bench Verified stratified-50 (4-arm comparison)",
  `timeout_minutes: 30`).
- `--unload-chat-node` — **required here.** Unloads the 8080 chat node first so
  its ~13 GB VRAM is freed; without it the `qwen-minimal` server on 8084 gets
  starved and the run crashes (this was the root cause of the earlier Django
  "fetch failed" / dropped-server failures).

The runner (`scripts/forge-bench-suite.mjs`) iterates the 50 tasks, runs each
through the selected arms, and writes a per-run directory under `results/`.

### Pre-flight before hitting Enter
Confirm these are true, or the run will fail:
1. **Port 8084 free** (minimal arm) — and 8085/8086.
2. **llama-server healthy** on the benchmark base URL (see `.forge/config.yaml`
   `benchmark.base_url`; the runner resolves `--base-url` → env → config and
   errors loudly rather than silently falling back to 8080).
3. **Docker Desktop up** — the official SWE evaluator runs in Docker.
4. **Chat node** on 8080 is the one to be unloaded (the flag handles it).

---

## 4. How to check progress while it runs

- **New run directory** appears under `results/` with a fresh timestamp.
  Find the latest:
  ```powershell
  node -e "const fs=require('fs');const d=fs.readdirSync('results').filter(x=>!x.startsWith('.')&&fs.statSync('results/'+x).isDirectory()).sort();console.log(d.slice(-3).join('\n'))"
  ```
- Each task/arm writes a self-contained dir:
  ```text
  results/<run-id>/<arm>/
    manifest.json  runtime.json  agent-events.jsonl
    stdout.log     stderr.log    patch.diff
    evaluator/     usage.json
  ```
- **`patch.diff` present + `evaluator/` populated** = the task reached the
  scoring stage. `PASS`/`FAIL` comes **only** from the official evaluator
  result, never from the agent's prose or a diff heuristic.
- Per-task wall-clock limit is 30 min; on timeout the evaluator still runs if a
  patch exists (result `TIMEOUT`).

### Expected duration
50 tasks × 2 arms × up to 30 min = up to ~50 h worst case. The 5-task pilot
averaged ~15 min/task, so expect roughly **25–35 h** total. This is a
long-running, unattended job — start it, then poll the run dir periodically.

---

## 5. Reference: 5-task pilot results

From the original 5-task suite run
(`results/qwen-suite-2026-09-02T13-09-49-283Z/`):

| Arm | Result |
| --- | --- |
| `qwen-forge` | **4/5 PASS** |
| `qwen-minimal` | **2/5 PASS** |

So Forge's harness is clearly winning the pilot. The 50-task run is to confirm
that on a larger, stratified sample.

---

## 6. Known issues / gotchas (already fixed — do not re-litigate)

- **VRAM starvation of the minimal arm** → fixed by `--unload-chat-node` +
  preflight chat-node VRAM check. Always pass the flag.
- **`UnicodeEncodeError` (cp1253 / Greek locale)** crashing the evaluator on
  non-ASCII eval scripts → fixed by making `sitecustomize.py` default
  `write_text` to UTF-8.
- **Django "fetch failed" / server drop** (old 58k ctx) → fixed by the 45k
  `num_ctx` reduction + unloading the chat node.
- **Windows quoting:** never quote a path passed to `exec_command`; write script
  files instead of `node -e` for anything non-trivial.
- **`__pycache__`** under `scripts/swebench-windows/` is a build artifact —
  leave it untracked.

---

## 7. Key files

| Path | Role |
| --- | --- |
| `scripts/forge-bench-suite.mjs` | Suite runner — `--arms` / `--limit` / `--unload-chat-node` pass-through, per-arm report |
| `scripts/forge-bench.mjs` | Single-task runner; `ALL_ARMS = ['qwen-minimal','qwen-forge','claude-code','codex']` |
| `benchmarks/swe-bench-verified-50-suite.json` | The stratified 50-task sample (instance_id only) |
| `scripts/fetch-swebench-verified.mjs` | Fetches the 500 instance_ids from the HF API |
| `scripts/build-50-sample.mjs` | Builds the stratified 50-task sample |
| `benchmarks/COST_ESTIMATES.md` | Deferred Claude/Codex cost estimates + resume commands |
| `results/swe-bench-verified-500.json` | Full 500-instance list |
| `.forge/config.yaml` | `num_ctx: 45000`, `benchmark.base_url` |

### 50-task sample composition (proportional allocation)
django 23, sympy 8, matplotlib 4, sphinx 4, scikit-learn 3, astropy 2,
xarray 2, pytest 2, requests 1, pylint 1. The 5 previously-run pilot tasks are
locked in.

---

## 8. To resume in a new session — do this

1. Read this file.
2. `git status` — confirm clean (only `__pycache__` untracked).
3. Confirm port 8084 free + llama-server healthy + Docker up (Section 3).
4. If the run already started, find the latest `results/` dir and inspect
   per-task `patch.diff` / `evaluator/` progress (Section 4).
5. If not started, hit Enter on the staged command (Section 3).
6. Poll the run dir while it runs. When done, read the per-arm report and
   compare `qwen-forge` vs `qwen-minimal` PASS counts. State clearly it is not
   a SWE-bench score.
7. Do **not** add `claude-code` / `codex` without re-approving cost
   (`benchmarks/COST_ESTIMATES.md`).
