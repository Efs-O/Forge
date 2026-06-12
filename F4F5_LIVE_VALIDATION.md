# F4/F5 Live Validation Procedure

Validates commit `63a70ec` (VRAM-aware eviction on /ensure, POST /unload,
dead-process reconcile) against the **running** extension. Run after any
change to `ControlServer.ts` / `BackendPool.ts` / `DirectBackend.ts`.

## Prerequisites

- Forge VSIX built from the commit under test is installed
  (`& "N:\VScode\Microsoft VS Code\bin\code.cmd" --install-extension forge-llm-<ver>.vsix --force`)
  and the VS Code window **reloaded after install** (old extension host =
  old control server; results are meaningless otherwise).
- Control server up: `GET http://127.0.0.1:8799/healthz` → `{"ok":true}`.
- Two local GGUF models in `.forge/config.yaml` that do NOT fit in VRAM
  together. Reference pair: `gemma4-26b-a4b-it-iq3s` (~17.6 GB) and
  `qwen36-35b-a3b-iq3s`.
- No llama-server already running (`Get-Process llama-server`).

All calls below are PowerShell. Helper:

```powershell
function ctl($route, $model) {
  Invoke-RestMethod -Uri "http://127.0.0.1:8799/$route" -Method POST `
    -Body ('{"model":"' + $model + '"}') -ContentType 'application/json' -TimeoutSec 300
}
function models() { (Invoke-RestMethod http://127.0.0.1:8799/models).models `
  | Where-Object { $_.loaded -or $_.holds -gt 0 } }
```

## Test 1 — auto-evict swap (F4, the original failure)

```powershell
ctl ensure gemma4-26b-a4b-it-iq3s      # loads on :8080, returns baseUrl
ctl release gemma4-26b-a4b-it-iq3s     # → released:true (hold bookkeeping only; model STAYS loaded)
models                                  # gemma loaded=True holds=0
ctl ensure qwen36-35b-a3b-iq3s         # THE TEST
```

PASS: qwen ensure returns 200 with a baseUrl in well under 120 s; gemma's
llama-server is gone first (watch `Get-Process llama-server` — one process,
new PID); `models` shows only qwen loaded. Extension log line:
`[ControlServer] released idle "gemma4-26b-a4b-it-iq3s" to make room for "qwen36-35b-a3b-iq3s"`.

FAIL (pre-fix behavior): second llama-server spawns on :8081, starves, 502
after 120 s `No response from http://127.0.0.1:8081/v1/models`.

Also verify the grace window: `ensure A` then immediately `ensure B`
(within 2 s, without releasing A) must 409 `recently active`, not evict A.

## Test 2 — /unload semantics (F4)

```powershell
ctl ensure qwen36-35b-a3b-iq3s         # hold = 1
ctl unload qwen36-35b-a3b-iq3s         # → 409 "active holds — POST /release them first"
ctl release qwen36-35b-a3b-iq3s        # → released:true
ctl unload qwen36-35b-a3b-iq3s         # → 200 {unloaded:true}; llama-server exits
ctl unload qwen36-35b-a3b-iq3s         # → 200 {unloaded:false} (idempotent)
ctl unload gpt-oss:120b-cloud          # ollama cloud → unloaded + keep_alive:0 path (or false if never loaded)
ctl unload grok-4.3                    # → 422 cloud-provider
ctl unload nope                        # → 404
```

PASS: statuses as annotated; `Get-Process llama-server` empty after the
first successful unload; `models` shows nothing loaded.

## Test 3 — external-kill reconcile (F5)

```powershell
ctl ensure gemma4-26b-a4b-it-iq3s
ctl release gemma4-26b-a4b-it-iq3s
Get-Process llama-server | Stop-Process -Force    # simulate external death
Start-Sleep -Seconds 3
models                                            # THE TEST
```

PASS: gemma `loaded=False` within a few seconds (exit event, no health-poll
wait); a follow-up `ctl ensure gemma4-26b-a4b-it-iq3s` cold-starts cleanly
on the SAME port (8080 — the slot/port was freed, not leaked).

FAIL (pre-fix): `loaded=True holds=0` persists indefinitely.

## Cleanup

```powershell
ctl unload gemma4-26b-a4b-it-iq3s; ctl unload qwen36-35b-a3b-iq3s
```

## Record results

Append PASS/FAIL per test to `RELAY_SMOKE_FINDINGS.md` under
"Resolved this cycle" (move F4/F5 there on full pass) and update the
auto-memory `project_relay_smoke_findings.md`.
