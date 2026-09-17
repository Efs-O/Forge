# Nemotron model support plan

Status: implemented

## Goal

Add a local llama.cpp profile for NVIDIA Nemotron 3 Nano 30B-A3B and a
repeatable endpoint-only benchmark. The profile uses the GGUF's embedded Jinja
template, forwards Forge's existing thinking selection as the template's
`enable_thinking` kwarg, and keeps Forge tool schemas strict.

## Evidence and decision

- `llama-server.exe --version` at the configured b11011 install reports build
  11011. Its help exposes `--jinja`, `--chat-template-kwargs`, and
  `--n-cpu-moe`; the model card lists llama.cpp as a supported engine.
- The Hugging Face GGUF search and repository metadata identify
  `unsloth/Nemotron-3-Nano-30B-A3B-GGUF`, file
  `Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf` (24,574,373,664 bytes; SHA-256
  `0e7f6e51fdd9039928749d07eed9e846dbfd97681646544c5406bcdd788e5940`).
  It is an instruct, tool-trained, 30B-total/3.5B-active hybrid MoE model,
  small enough to leave room for a 64K Q8 KV cache across the 44 GB GPU pool.
- NVIDIA's model card recommends temperature 0.6 and top-p 0.95 for tool
  calling; its template defaults thinking on and accepts `enable_thinking`.

## Implementation

1. Add an optional, schema-validated model template-kwargs map. Merge it into
   llama.cpp requests after the existing Qwen reasoning-effort specialization.
   For Nemotron, derive `enable_thinking` from the resolved existing `think`
   control rather than putting a `/think` instruction or a tool list in a
   prompt.
2. Add the Q4_K_M model profile to `.forge/config.yaml`. Keep the embedded
   template (`--jinja` is composed centrally); use all three GPUs and zero CPU
   MoE layers as the initial fit configuration. Comments record that a live
   load must validate the split and context margin before treating it as tuned.
3. Add `scripts/nemotron-bench.mjs`. It connects only to an already-running
   server, obtains strict schemas from Forge's benchmark `ToolRegistry`, runs
   twelve fixed tool/coding scenarios, records server timing fields, and writes
   raw JSON plus the stable Markdown report at `docs/benchmarks/nemotron.md`.
   It neither starts nor stops a server.
4. Unit-test request normalization and the script's argument validation/help
   path. Run repository CI and inspect the final diff.
5. Freeze a validation-only Greek-language evaluation set outside Forge and
   extend the endpoint-only benchmark with aggregate-only QA, Greek-script,
   and Greek strict-schema tool-call measurements in both thinking modes.

## State × lifecycle ledger

| Durable artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
| --- | --- | --- | --- | --- | --- | --- |
| `.forge/config.yaml` model entry | Manual, comment-preserving edit | User removes entry; no runtime deletion | Select another model/profile | YAML remains valid because it is edited atomically as source | No process owns it | Persistent until user changes config |
| `docs/benchmarks/nemotron-raw-*.json` | Benchmark creates a dated raw result | User may delete old runs | No benchmark runs when command is not invoked | Raw JSON uses temp file then rename | Partial temp is ignored; next run creates a new dated file | No automatic expiry; results are audit evidence |
| `docs/benchmarks/nemotron.md` | Benchmark atomically replaces the latest human report | User may delete it | No update when benchmark is not invoked | Existing report remains until rename | Existing report remains valid for its recorded date | Replaced by next successful report; raw file remains |
| `Gemma4GR/data/nemotron_greek_eval/eval.jsonl` (local, uncommitted) | Deterministic builder filters `persona_val.jsonl` | User may remove local set | No benchmark runs when absent | Builder rewrites set and manifest together | No Forge process owns it | Persistent until the dataset/rule is intentionally rebuilt |
| `Gemma4GR/data/nemotron_greek_eval/SHA256SUMS` (local, uncommitted) | Builder writes SHA-256 alongside the set | User may remove it with set | No benchmark runs when absent | Rebuilt with set | No Forge process owns it | Persistent until rebuild |

The script's atomic raw/report writes are the CI-enforceable lifecycle guard:
unit coverage verifies it rejects missing endpoint/model inputs before creating
an output artifact.

## Acceptance criteria

- [x] b11011 capability and the selected model's repo, file, byte size, hash,
  sampling guidance, and template behavior are recorded above. (Manual
  validation against server help and model metadata.)
- [x] The Nemotron profile is schema-valid, preserves existing config comments,
  uses one 64K slot with Q8 KV cache, and documents each hardware choice.
  (`npm run type-check` config load validation.)
- [x] Toggling Forge's `think` profile becomes the embedded template's
  `enable_thinking` kwarg without a hardcoded prompt or tool list. (Unit test.)
- [x] `scripts/nemotron-bench.mjs` uses Forge's strict benchmark tool schemas,
  runs 12 fixed scenarios including four file/test coding checks, and produces
  raw JSON plus Markdown timing/success tables. (Script help/argument test;
  live server run remains required.)
- [x] `npm run ci` and `git diff --check` pass after the final change. The
  package guard was invoked but correctly refused to overwrite the existing
  `forge-llm-0.16.8.vsix`; no version change or overwrite is authorized.
- [x] A local-only held-out set is frozen from `persona_val.jsonl` under the
  documented Greek/NFC/decontamination rule: 39 rows, SHA-256
  `c9dee5253ff44ca5fa743f7fc41c81e416ee7e32428db1c5d9530c2277f34c70`.
  The exact-pair exclusion rule is in its local README for future training.
- [x] The endpoint-only benchmark accepts `--greek-eval` (defaulting to that
  local path), reports aggregate character 3-gram F1, token F1, Greek-script
  share, and eight Greek strict-schema tool cases with thinking both off and
  on. It does not emit QA rows or answers into Forge artifacts. (Unit help
  coverage; live run remains required.)

## Known limitations

No GPU/model run is performed by this change. The tensor split, 64K cache
margin, request parser behavior, and measured tool/coding success remain live
validation work after the GPUs are released.
