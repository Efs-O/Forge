# Bench monitoring notes — live-chat-on-8080 vs qwen-forge (small, pre-compact)

Run: `results/suite-2026-09-04T00-39-35-430Z`.
Model: **Qwen3.8-27B** (`N:/QWEN GGUF/Qwen3.8-27B/Qwen3.8-27B-UD-Q3_K_XL.gguf`,
UD-Q3_K_XL, MTP+ngram spec), llama-server on **8080**, `--parallel 1`.
Both arms use the SAME model (that's the point: same model, different harness).

## RESUME STATE (as of 2nd stop, 2026-09-05 ~15:35)

- Run was **stopped** (user: "stop"). Last in flight: task 17 qwen-forge.
- **BLOCKER: Docker daemon is DOWN.** The official SWE-bench evaluator runs in
  Docker; with the daemon down it throws `DockerException` (named pipe
  `//./pipe/docker_engine` not found) → every task scores **ERROR** ("Official
  evaluator did not produce a resolved result"), NOT PASS/FAIL. Confirmed on
  tasks 11–16 this session. This is NEW — the prior session had Docker up and
  produced real PASS/FAIL.
- **Prior valid data is SAFE (not destroyed).** Each task keeps every smoke dir;
  `bench-progress.mjs` reads only the LATEST smoke, so today's ERROR runs
  *shadow* the good ones. e.g. task 11 `smoke-2026-09-04T22-38-09-315Z` still
  holds `qwen-forge status=PASS`. The good per-arm `runtime.json` files remain
  on disk in their own smoke dirs.
- **Resume is pointless until Docker is up** — it will just re-ERROR 11→50.
  When Docker is back: resume with the same command. Tasks 1–10 skip (have
  `report.json`); 11–41 re-run (only per-arm runtime, no top-level report.json —
  so resume re-runs from 11, NOT 39, and 34/35 preflight-failers re-run too).
- **`qwen-minimal` is DEFERRED** — standalone pass after the forge run completes
  (user decision; 8083 not needed now).
- **`qwen-minimal` OOMs on the shared `--parallel 1` 8080 server** — expected;
  it ERRORs. Only `qwen-forge` is meaningful on this run.

### Resume command (qwen-forge only, as-is)
```
npm run bench:qwen-suite -- --suite benchmarks/swe-bench-verified-50-suite.json --unload-chat-node --resume results/suite-2026-09-04T00-39-35-430Z
```
Run via `exec_command` background=true, then `monitor_execution`.

---
## (below: earlier analysis)

Run: `results/suite-2026-09-04T00-39-35-430Z` (resumed, in background).
Model: Qwen3.8-27B-UD-Q3_K_XL.gguf, llama-server on **8080**, `--parallel 1`.

## 1. Do I (this chat) and qwen-forge share inference?

- **Same llama-server process (8080), same weights, same GPU: YES.** The
  resumed `qwen-forge` arms report `endpoint=http://127.0.0.1:8080` — the same
  server serving this conversation.
- **Same inference *context* (KV): NO.** My conversation and the benchmark
  agent's loop are separate request contexts.
- **Contention: YES, but only timing, not validity.** `--parallel 1` = one
  inference slot, so requests **serialize** — when the benchmark generates, my
  requests wait, and vice versa. Effect:
  - benchmark `runtime_ms` is inflated by any time I'm generating,
  - my replies get slower while the benchmark generates,
  - **PASS/FAIL is unaffected** (same weights, separate context, official
    evaluator still authoritative).

So the user's intuition is half right: we don't share the same *context*, but
we do share the server + single slot, so we contend for it.

## 1a. "But you were monitoring all the time — doesn't that contradict serialization?"

No — monitoring is mostly **not inference**:

- `wait` / `monitor_execution` / file reads / `node` scripts are **local** —
  they never touch 8080, so they work fine while the benchmark generates.
- Only my **replies** (generation) need the 8080 slot. Those are short bursts
  and they **queue behind the benchmark's current generation** (llama-server
  `--parallel 1` = one slot; a new request waits for the slot to free).
- The benchmark loop is **not continuous generation**: it alternates
  generation (minutes) with tool execution (file reads, terminal, evaluator,
  Docker — also minutes) during which the slot is **free** and my requests
  pass instantly.
- So I did not need to work "only between tests." The only cost is **reply
  latency** if the user messages during an active benchmark generation: my
  reply waits for that generation to finish (worst case a few minutes).

## 2. What if autocompact fires?

- **If *I* (monitor) hit autocompact:** my context is compacted; I lose
  monitoring detail, the 2h cadence could slip. Benchmark is **unaffected**
  (separate context). Mitigation: keep state in files (this file,
  `scripts/bench-progress.mjs`, run dir), not in my head.
- **If the *benchmark qwen-forge* agent hits autocompact:** the real Forge
  ToolCallingLoop would compact the agent's context mid-task (num_ctx 45000,
  max_tokens 16384). That is **real Forge behavior** — arguably a fair thing to
  measure — but it means that task ran with a compacted context (a different
  condition than a short task) and could change PASS/FAIL. Flag per task: check
  `agent-events.jsonl` / `runtime.json` for compaction events.

## 3. Known blocker (deferred, per user)

`qwen-minimal` is **skipped** on all resumed tasks: `unloadForgeQwen` throws
("8080 stayed reachable") because this live chat holds the model, aborting the
task before the minimal arm runs. Fix = dedicated server on **8083** +
`benchmark.base_url`, or run minimal after the forge run completes (user's
call: 8083 is fine, not urgent now).

## 4. Monitoring tools (already written)

- `scripts/bench-progress.mjs <run-dir>` — per-arm tallies (reads runtime.json).
- `scripts/bench-inspect.mjs <run-dir> <task...>` — per-task arm detail.
- Run execution id: `exec-863d51b9-bb99-4e7d-b45e-9c1978bdd30d`.
- Reports to user **must** go via `notify_user` (reaches offline phone);
  chat-only text is invisible while the user is away.

---

## 5. Answers to the two live concerns (2026-09-05, no new investigation)

**Decision recorded:** 8083 is NOT being done now. Monitoring qwen-forge live is
worth more than the minimal arm. Minimal runs as a **second pass after the forge
arm finishes**, GPU-exclusive. Nothing about the in-flight run changes.

### a) Do this chat and qwen-forge share inference context?

**No.** Each HTTP request to llama-server carries its **entire** prompt; the
server keeps no conversation memory between requests. My messages and the
benchmark agent's messages are separate request bodies that happen to hit the
same process. There is no path by which my tokens enter its output or vice
versa. Contention is timing only: `--parallel 1` means one slot, so requests
queue. Latency, not validity.

**The one thing worth confirming later (not now):** the shared slot has a KV
**prefix cache**. llama.cpp reuses cached KV when a new request's prefix matches
what is already in the slot, and evicts when it does not. That matching is what
keeps the two conversations separate. It is designed to be exact-match safe, so
this is a verify-later item, not a suspected bug — but it is the only place in
the stack where "shared server" could become "shared state", so it is the right
place to look if the forge arm ever produces output that reads like it came from
this chat.

### b) What happens on autocompact?

**If this monitoring chat compacts:** benchmark is untouched (separate process,
separate context). I lose monitoring detail. Mitigation is already in place —
state lives in this file, `scripts/bench-progress.mjs`, and the run dir, not in
my context. Recovery = re-read this file and re-run bench-progress.

**If the qwen-forge agent compacts mid-task:** its context is compacted by the
real Forge loop (num_ctx 45000, max_tokens 16384). That is genuine Forge
behaviour and arguably in scope for the benchmark, but that task then ran under
a different condition than a short task, and it can flip PASS/FAIL.

**Known gap:** the note in §2 says to check `agent-events.jsonl` for compaction
events. Nothing appears to emit one there, so **compaction is currently
invisible in the run artifacts** — we cannot tell after the fact which tasks
compacted. That is the one real defect the two concerns surfaced. Fix is small
and does not touch inference: emit a compaction event into `agent-events.jsonl`
when the loop compacts, so each task's log says whether it happened. Do this
before the minimal second pass, not during the live run.
