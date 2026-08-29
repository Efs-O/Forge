# Qwen 3.8 27B Q3_K_XL — Performance Benchmark Report

Date: 2026-08-29
Backend: Forge-managed llama.cpp b10673, RTX 5060 Ti 16 GB

## Fixed baseline

- Model: `qwen38-27b-mtp-ud-q3kxl-no-vision`
- Context: 50,000
- KV cache: Q4_0 (K and V)
- Thinking: enabled; reasoning budget 3,072
- GPU layers: 999; Flash Attention enabled
- Baseline batching: `n_batch 2048`, `--ubatch-size 1024`
- Baseline speculation: `draft-mtp,ngram-mod`; draft max 2; n-gram match/min 24, max 86
- Every model lifecycle operation used Forge's control server. Each test released and unloaded its model afterward.

## Results

### Long-prompt ingestion

Workload: 32,075 prompt tokens, fixed seed, thinking enabled, short `ACK` response.

| Variant | Time | End-to-end rate | Result |
| --- | ---: | ---: | --- |
| `n_batch 1024` | 44.41 s | 723.8 tok/s | 1.7% below baseline |
| `n_batch 2048`, `ubatch 1024` | 43.60 s | 736.6 tok/s | Balanced baseline |
| `n_batch 4096` | 43.33 s | 741.2 tok/s | Only 0.6% above baseline |
| `ubatch 2048` | 44.85 s | 716.7 tok/s | 2.7% below baseline |

Recommendation: retain `n_batch 2048` and `--ubatch-size 1024`. The tiny 4096 gain needs repeated validation and does not justify reducing the available stability margin.

### Long decode with thinking enabled

Workload: fixed seed, 8,192-token output cap, 500 numbered technical records.

| Variant | Completion tokens | Time | Rate |
| --- | ---: | ---: | ---: |
| MTP only (`draft-mtp`) | 8,192 | 198.20 s | 41.33 tok/s |
| MTP + n-gram modification | 8,192 | 214.89 s | 38.12 tok/s |

This is one paired measurement, not a final verdict. On this non-repetitive workload the n-gram modifier was slower by about 8%; it should be repeated and tuned before removal because coding/tool workloads may have different repetition and acceptance patterns.

### Vision/no-vision sanity check

The matched vision and no-vision models were effectively tied over two 8,192-token runs: 95.91 versus 95.85 tok/s on average. `--no-mmproj-offload` keeps the 900 MB projector in system RAM, so it did not add approximately 900 MB of VRAM use.

### Checkpoint observation

A direct-control-API test did not retain the prompt prefix cache: changing one token near the end of a 32k prompt still took 45.06 s. This cannot evaluate `--checkpoint-min-step`; run that test through a normal Forge conversation path, which owns the appropriate cached request/session prefix.

## Speculative-decoding follow-up

The same fixed-seed, thinking-enabled 8,192-token workload was used for every comparable run below. The model reached the output cap in every row except the marked draft-count-3 probe.

| Variant | Runs (tok/s) | Mean | Decision |
| --- | --- | ---: | --- |
| Draft max 1, n-gram 24/24/86 | 37.40 | 37.40 | Slower than draft max 2 |
| Draft max 2, n-gram 24/24/86 | 38.12, 38.80 | 38.46 | Previous baseline |
| Draft max 3, n-gram 24/24/86 | 39.11, but stopped at 3,134 tokens | — | Not comparable; do not adopt |
| Draft max 2, n-gram 16/16/64 | 41.20, 41.05 | 41.13 | Adopt for performance testing |

The 16/16/64 n-gram profile improved measured completion throughput by 6.8% over the two-run default average while retaining MTP and requiring no extra VRAM or context change. The live no-vision entry now uses this profile:

```yaml
--spec-draft-n-max: 2
--spec-ngram-mod-n-match: 16
--spec-ngram-mod-n-min: 16
--spec-ngram-mod-n-max: 64
```

This is a performance recommendation only. Validate ordinary coding/tool-call quality over normal use before treating it as a permanent quality-neutral setting. Keep `n_batch 2048`, `--ubatch-size 1024`, Q4 KV, thinking enabled, and the 50k context unchanged.
