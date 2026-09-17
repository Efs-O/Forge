# Nemotron benchmark

Date: 2026-09-17T19:04:30.561Z
Hardware: 2x RTX 5060 Ti 16 GB (PCIe Gen3 x8) + RTX 3060 12 GB (x4); i7-8700K DDR4
Endpoint: http://127.0.0.1:8091
Model: nemotron3-nano-30b-a3b-q4km-no-vision
llama.cpp: not reported by endpoint
Quant: Nemotron-3-Nano-30B-A3B-Q4_K_M (24,574,373,664 bytes; SHA-256 0e7f6e51fdd9039928749d07eed9e846dbfd97681646544c5406bcdd788e5940)
Context: 65536

Tool-call success: 10/12 (83.3%). Coding checks: 2/4.

| Scenario | Expected tool | Actual tool | Result | Prompt tok/s | Generation tok/s |
| --- | --- | --- | --- | ---: | ---: |
| tool-read-file | read_file | read_file | PASS | 248.14 | 86.08 |
| tool-find-files | find_files | find_files | PASS | 272.08 | 86.42 |
| tool-search-code | search_code | search_code | PASS | 286.14 | 96.62 |
| tool-write-file | write_file | write_file | PASS | 272.28 | 78.4 |
| tool-append-file | append_file | append_file | PASS | 276.55 | 98.62 |
| tool-edit-file | edit_file | edit_file | PASS | 279.14 | 95.84 |
| tool-run-terminal | run_terminal | run_terminal | PASS | 273.02 | 88.86 |
| tool-run-tests | run_tests | run_tests | PASS | 256.36 | 89.56 |
| coding-write-module | write_file | write_file | FAIL | 360.19 | 99.1 |
| coding-append-readme | append_file | append_file | FAIL | 288.7 | 99.29 |
| coding-edit-constant | edit_file | edit_file | PASS | 300.13 | 84.14 |
| coding-run-test | run_tests | run_tests | PASS | 318.81 | 83.94 |

## Greek-language evaluation

Held-out set: N:\vs code apps\Gemma4GR\data\nemotron_greek_eval\eval.jsonl (39 rows; SHA-256 838e592f4268e6f21805423c69d6d9b8b4409bc75f5931d29f198232741ede9e).
Quality is character 3-gram F1 and whitespace/token F1 against each held-out reference; language fidelity is the mean Greek-Unicode-letter share. Greek QA rows and model answers are deliberately not written into Forge artifacts.

| Thinking | QA char-F1 | QA token-F1 | Greek-script share | Greek tools |
| --- | ---: | ---: | ---: | ---: |
| off | 7.2% | 8.6% | 76.8% | 3/8 |
| on | 7.8% | 9.5% | 58.1% | 3/8 |

Gemma 4 E4B reference: base 3/4 (75.0%), fine-tuned 3/4 (75.0%) from Gemma4GR `tests/benchmark_results`. Those were a four-question `must_contain` smoke run, not this validation-only F1 evaluation, so they are not directly comparable.

Raw result: nemotron-raw-2026-09-17T19-04-30-561Z.json

The benchmark validates tool name plus required JSON fields. It does not execute model-proposed terminal commands.

## Q8_0 control (2026-09-17)

Same frozen 39-row Greek pilot and strict-schema tool benchmark, served locally on port 8092. The Q4_K_M baseline above is unchanged. Q8 run context was 16384, versus Q4's 65,536.

| Measure | Q4_K_M | Q8_0 | Delta |
| --- | ---: | ---: | ---: |
| Greek QA char-F1, thinking off | 7.2% | 7,0% | -0,2 pp |
| Greek QA char-F1, thinking on | 7.8% | 6,9% | -0,9 pp |
| Greek-script share, off | 76.8% | 77,7% | +0,9 pp |
| Greek-script share, on | 58.1% | 53,3% | -4,8 pp |
| Greek tools | 3/8 | 4/8 | 1 |
| English tool calling | 10/12 | 10/12 | 0 |
| Generation tok/s | 78–99 | 63.8–71.2 | n/a |
