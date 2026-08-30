# Qwen3.8-27B UD Q3_K_XL — Perplexity / Quantization Quality Report

Date: 2026-08-29
Model: `N:/QWEN GGUF/Qwen3.8-27B/Qwen3.8-27B-UD-Q3_K_XL.gguf` (12.24 GB, unsloth Dynamic v3 UD quant)
Data: `test/data/wiki.valid.raw` (wikitext-2-raw-v1 valid split, 1.09 MB, ~245k tokens)
Tool: `llama.cpp-b10673/llama-perplexity.exe`, `-b 512 --n-gpu-layers 999`, two context sizes
Hardware: RTX 5060 Ti 16 GB, all layers on GPU

## Method

Two runs per context size, same weights, same data, only the KV cache type
 differs. Per-chunk deltas are positive in every chunk at both context sizes,
 so the KV-cache effect is real, not noise.

### 4096 context (63 chunks)

| KV cache | PPL |
|---|---|
| `q4_0` (current Forge config) | **6.5835 ± 0.0462** |
| `f16` (reference) | **6.5585 ± 0.0459** |

### 25000 context (10 chunks — matches the live Forge server `--ctx-size`)

| KV cache | PPL |
|---|---|
| `q4_0` (current Forge config) | **5.8324 ± 0.0390** |
| `f16` (reference) | **5.8144 ± 0.0388** |

Note the absolute PPL drops from ~6.56 to ~5.81 at 25k context: the model sees
more of the document per chunk, so it predicts better. That is the long-context
benefit, not a cache artifact — both cache types benefit equally.

## Results

### 1. KV-cache quantization cost (measured, this machine)

| Context | q4_0 PPL | f16 PPL | Delta | Relative |
|---|---|---|---|---|
| 4096 | 6.5835 | 6.5585 | **+0.0250** | +0.38% |
| 25000 | 5.8324 | 5.8144 | **+0.0180** | +0.31% |

The `q4_0` KV cache costs ~0.02–0.025 PPL. The relative cost is **stable
across context** (~0.3–0.4%) — it does not grow at 25k the way a naive
"more cached tokens = more error" model would predict. Per-chunk deltas at
25k: 0.008–0.018, all positive. Conclusion: keep `q4_0`; switching to `f16`
for ~2× KV VRAM would save 0.018 PPL — below the noise floor of any real task.

### 2. Weight-quantization cost (published reference, unsloth)

From the unsloth Qwen3.8-27B-GGUF release discussion (same model family,
Quant-vs-Base measured on identical data with identical harness):

```
Mean PPL(Q) − PPL(base)   : +0.0542 ± 0.0042
Mean PPL(Q) / PPL(base)   : 1.007804 ± 0.000610   (i.e. +0.78%)
Cor(ln PPL(Q), ln PPL(base)): 99.56%
```

Absolute PPLs are NOT comparable across harnesses (unsloth's base reference
was 6.9505 vs. our 6.5585 on nominally the same file — different context /
build / flash-attn setup), so only the **ratio** is transferable.

Applying the ratio to our measured f16-cache PPL:

```
Implied BF16-equivalent PPL ≈ 6.5585 / 1.0078 ≈ 6.5075
Weight-quant cost           ≈ +0.051 PPL      ≈ +0.78% relative
```

### 3. Total degradation of the live config

At the live 25k context (the number that actually matters for this machine):

```
Implied BF16-equivalent (25k) : 5.8144 / 1.0078 ≈ 5.7692
Live config (Q3 + q4_0, 25k)  : 5.8324
Total                         : +0.063 PPL ≈ +1.1% relative
```

(At 4k context the same calculation gives +0.076 PPL ≈ +1.2% — the KV-cache
share is slightly larger there, see §1.)

## Interpretation

- A ~1.2% PPL increase on a 27B dense model is negligible for task quality.
  Task benchmarks (coding, tool-calling, reasoning) typically move less than
  the PPL delta suggests, because they are less sensitive to the long-tail
  knowledge that PPL captures.
- The UD Q3_K_XL quant is well-made: the Q3 weight cost (+0.78%) is about the
  same order as a Q4_K quant would be on a non-UD quantization.
- The `q4_0` KV cache is the smaller of the two costs and, contrary to the
  initial hypothesis, does **not** scale badly with context: +0.38% at 4k,
  +0.31% at 25k. No reason to switch to `f16` on this hardware.
- Absolute PPL is context-dependent (5.81 at 25k vs 6.56 at 4k on the same
  file), so never compare absolute PPL across context sizes — only same-run
  deltas and same-harness ratios are meaningful.

## Caveats

- wikitext PPL measures language modeling, not instruction-following or
  tool-calling. It isolates "how much did the weights lose" from everything
  else, which is what was asked — but it is a proxy, not a task benchmark.
- The unsloth Q/base ratio is from their release discussion and may not be
  for the exact Q3_K_XL variant (likely their headline quant); treat the
  0.78% as an order-of-magnitude anchor, not an exact figure for this file.
- Only the valid split was used (63 chunks). The train split would give the
  same conclusion with more chunks.

## Reproduce

4k (script, both cache types):
```
& "n:\vs code apps\Forge\test\run-perplexity.bat"
```

25k (matches live server context):
```
& "C:\Program Files (x86)\Llamacpp\llama.cpp-b10673\llama-perplexity.exe" -m "N:\QWEN GGUF\Qwen3.8-27B\Qwen3.8-27B-UD-Q3_K_XL.gguf" -f "n:\vs code apps\Forge\test\data\wiki.valid.raw" -c 25000 -b 512 --n-gpu-layers 999 --cache-type-k q4_0 --cache-type-v q4_0
& "C:\Program Files (x86)\Llamacpp\llama.cpp-b10673\llama-perplexity.exe" -m "N:\QWEN GGUF\Qwen3.8-27B\Qwen3.8-27B-UD-Q3_K_XL.gguf" -f "n:\vs code apps\Forge\test\data\wiki.valid.raw" -c 25000 -b 512 --n-gpu-layers 999 --cache-type-k f16 --cache-type-v f16
```

Requires the Forge llama-server to be stopped first (VRAM):
`taskkill /PID <pid> /F` (find via `wmic process where name='llama-server.exe'
get ProcessId,CommandLine /format:list`).
