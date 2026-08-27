# Gemma and Qwen GGUF inventory

Current snapshot of the live `.forge/config.yaml` compared with the model files
present on disk. The disk scan covers:

- `N:/GEMMA GGUF UNSLOTH`
- `N:/QWEN GGUF`
- `N:/.cache/huggingface`

## Configured local models

Every local GGUF path currently configured below exists on disk.

### Gemma

| Config model | GGUF path | Status |
|---|---|---|
| `gemma4-e4b-it-ud-q4kxl` | `N:/GEMMA GGUF UNSLOTH/E4B/gemma-4-E4B-it-UD-Q4_K_XL.gguf` | PRESENT |
| `gemma4gr-e4b-efso-q4km-experimental` | `N:/GEMMA GGUF UNSLOTH/E4B EFSO/gemma4gr-e4b-efso-q4_k_m.gguf` | PRESENT |
| `gemma4-26b-a4b-it-qat-q4kxl` | `N:/GEMMA GGUF UNSLOTH/26B-QAT/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` | PRESENT (main/agent) |
| `gemma4-12b-it-ud-q5kxl` | `N:/GEMMA GGUF UNSLOTH/12B/gemma-4-12b-it-UD-Q5_K_XL.gguf` | PRESENT |
| `gemma4-31b-it-q3ks` | `N:/GEMMA GGUF UNSLOTH/31B/gemma-4-31B-it-Q3_K_S.gguf` | PRESENT |

### Qwen

| Config model(s) | GGUF path | Status |
|---|---|---|
| `qwen38-27b-mtp-q3km`, `qwen38-27b-mtp-q3km-worker` | `N:/QWEN GGUF/Qwen3.8-27B/Qwen3.8-27B-Q3_K_M.gguf` | PRESENT |

There are no configured Gemma or Qwen GGUF paths currently missing from disk.

## Present on disk but not configured

These files currently have no matching local `gguf_path` in the config.

### Gemma models and MTP artifact

| File | Location | Role |
|---|---|---|
| `gemma-4-E2B-it-UD-Q4_K_XL.gguf` | `N:/GEMMA GGUF UNSLOTH/E2B/` | Gemma 4 base model |
| `gemma-4-e4b-it-gr-v2-Q4_K_M.gguf` | `N:/.cache/huggingface/hub/gemma-4-E4B-it-GR-v2/` | Gemma 4 GR-v2 model |
| `gemma-4-e4b-it-gr-v2-Q8_0.gguf` | `N:/.cache/huggingface/hub/gemma-4-E4B-it-GR-v2/` | Gemma 4 GR-v2 model |
| `mtp-gemma-4-26B-A4B-it.gguf` | `N:/GEMMA GGUF UNSLOTH/26B-QAT/` | MTP drafter for the QAT family |

### Unconfigured supplemental asset

| File | Location | Role |
|---|---|---|
| `gemma-4-e4b-it-gr-v2-mmproj.gguf` | `N:/.cache/huggingface/hub/gemma-4-E4B-it-GR-v2/` | GR-v2 projector |

No unconfigured Qwen model GGUFs are currently present in the scanned model
locations.

## Referenced projector assets

These `mmproj_path` files are referenced by currently configured local models.

| Config family | Projector path | Status |
|---|---|---|
| Gemma E4B | `N:/GEMMA GGUF UNSLOTH/E4B/mmproj-F16.gguf` | PRESENT |
| Gemma E4B GR experimental | `N:/GEMMA GGUF UNSLOTH/E4B EFSO/gemma4gr-e4b-efso-mmproj.gguf` | PRESENT |
| Gemma 26B QAT | `N:/GEMMA GGUF UNSLOTH/26B-QAT/mmproj-BF16.gguf` | PRESENT |
| Gemma 12B | `N:/GEMMA GGUF UNSLOTH/12B/mmproj-F16.gguf` | PRESENT |
| Gemma 31B | `N:/GEMMA GGUF UNSLOTH/31B/mmproj-F16.gguf` | PRESENT |
| Qwen 3.8 27B | `N:/QWEN GGUF/Qwen3.8-27B/mmproj-BF16.gguf` | PRESENT |

## Other GGUF artifact

`N:/.cache/huggingface/hub/models--unsloth--embeddinggemma-300m-GGUF/snapshots/6661a65/embeddinggemma-300m-Q4_0.gguf`
is present on disk but is an embedding model, not a Gemma 4 or Qwen chat model.

