# SWE-bench Verified 50-task — token & cost estimates

Saved so we can revisit adding the paid CLI arms (`claude-code`, `codex`) later.
**Current decision (2026-09-03): run the two local Qwen arms only.** Claude + Codex
are deferred — the paid token bill was too high.

## Ground truth from the 5 completed calibration runs

Per-task, per-arm token usage (from `results/qwen-suite-2026-09-02T13-09-49-283Z/*/usage.json`):

| Arm | Avg tokens/task | Avg rounds | Notes |
| --- | ---: | ---: | --- |
| qwen-forge | ~550K | 47 | 5/5 runs |
| qwen-minimal | ~440K | 35 | 3 completed runs; 3 early-abort runs excluded from avg |

These are **local** — free. Token count only matters for wall-clock time (each run is
capped at `timeout_minutes: 30`).

## Full 50-task × 4-arm projection (what we are NOT doing now)

| Arm | Tasks | Avg tokens/task | Total tokens | Cost |
| --- | ---: | ---: | ---: | --- |
| qwen-forge | 50 | ~550K | ~27.5M | Free (local) |
| qwen-minimal | 50 | ~450K | ~22.5M | Free (local) |
| claude-code | 50 | ~200–400K (est, no local data) | 10M–20M | Paid |
| codex | 50 | ~200–400K (est, no local data) | 10M–20M | Paid |

- **Grand total: ~60M–90M tokens.** ~50M free (local Qwen), **~20M–40M paid**.
- Claude Sonnet-class pricing (~$5.40/M blended, 80/20 in/out): 20M→~$108, 40M→~$216.
- Codex (GPT-4o/4.1-class, ~$2.50/M blended): roughly half per token.
- **Estimated paid bill if all 4 arms ran: ~$100–250**, most of it in the Claude arm.

## Why this is only an estimate

- The CLI arms were never in the 5-task calibration, so their per-task token figures are
  a typical SWE-bench-agent range, not measured. A `--limit 2` smoke on the CLI arms
  would lock in real numbers before a full paid run.
- The 30-min timeout can truncate long tasks, changing per-task token counts.

## How to resume the paid arms later

```
# 2-task smoke to measure real CLI token cost first:
npm run bench:qwen-suite -- --suite benchmarks/swe-bench-verified-50-suite.json --limit 2 --arms claude-code,codex

# Full 50, all four arms (revisit once cost is acceptable):
npm run bench:qwen-suite -- --suite benchmarks/swe-bench-verified-50-suite.json --arms qwen-minimal,qwen-forge,claude-code,codex --unload-chat-node
```

## What we ARE running now (Qwen only)

```
npm run bench:qwen-suite -- --suite benchmarks/swe-bench-verified-50-suite.json --unload-chat-node
```

(Default arms are `qwen-minimal,qwen-forge` — no `--arms` flag needed. Free, local.)
