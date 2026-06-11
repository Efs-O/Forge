# 08 — Risks & Mitigations

Consolidated risk register. Read alongside [02-wedge-and-positioning.md](02-wedge-and-positioning.md)
(which covers honest market/audience risks) and [06-networking.md](06-networking.md)
(prompt-injection deep dive).

---

## Engineering / Product Risks

| #   | Risk                                                              | Mitigation                                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Tool-calling reliability varies wildly across local models        | Dual path: native function-call + structured-output fallback parser; per-model `system_prompt`; `StripTools` safety valve |
| 2   | Partial/malformed tool args from local models (Gemma 4 issue)     | **Strict JSON Schema for every tool**. No free-form `string` blobs. Validate before dispatch; re-prompt with schema reminder on fail. |
| 3   | Agent edits trash files                                           | Per-turn `CheckpointStack` snapshots before any write; inline Keep/Undo CodeLens; "Undo last turn" command; **no write tools ship before this is in place** |
| 4   | `run_terminal` / `exec_command` hallucinated destructive commands | **Show-before-execute always** (user sees exact command before it runs); `spawn` with arg array only (`shell: false`); static denylist of high-risk patterns (rm -rf, git reset --hard, curl\|sh, DROP TABLE, etc.) with mandatory override phrase; shell operators (`&&`, `\|`, `;`, `$()`) blocked in args; commands from fetched/untrusted content never dispatched; full spec in [05-tools.md §Terminal safety](05-tools.md) |
| 5   | Context overflow on long sessions                                 | Token budget guard with summarization fallback; visible token-budget UI in v0.9; HalluMeter integration option in v0.9 |
| 6   | Double templating (extension applies template + backend re-templates) | Send `messages[]`, let `llama-server` apply chat template via `--jinja`. Document this clearly. Never wrap content in chat-template syntax inside extension code. |
| 7   | Webview ↔ host message protocol drift                             | Single typed `messageBridge.ts` with discriminated unions; no ad-hoc `postMessage` in components |
| 8   | Cursor API divergence breaks extension                            | Defer Cursor support to post-v1.0; pin VS Code engine version conservatively                |
| 9   | `llama-server` not on user's PATH                                 | Detection order: `config.yaml` → PATH → well-known locations → first-run wizard with setup guide |
| 10  | Model switch latency (kill + respawn = 2–5s)                      | Acceptable for v0.1+; document in README; consider pre-load in post-v1.0 if frequent switching becomes pain point |
| 11  | Resource leaks across extension reloads                           | Strict `context.subscriptions.push(...)` discipline; dispose all child processes, watchers, providers; enforced in code review |
| 12  | Hot-reload of `config.yaml` corrupts in-flight session            | Atomic swap: parse + validate + replace, only on full success; keep previous config on validation fail; surface error in sidebar |

---

## Security Risks

| #   | Risk                                                              | Mitigation                                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 13  | Prompt injection via fetched web content                          | Wrap fetched/searched content in `<UNTRUSTED_CONTENT>` delimiters; system prompt explicitly de-trusts; tool calls discovered inside untrusted content are filtered out before dispatch |
| 14  | API key leakage to logs                                           | Keys in `SecretStorage` only; never logged at any level; URL query strings redacted in logs |
| 15  | API key leakage via committed `config.yaml`                       | Schema validation refuses to load if API key value found in YAML; warn user with clear error |
| 16  | SSRF via `web_fetch` to private IPs / localhost                   | Pre-DNS scheme check + post-DNS IP-range check; reject `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, IPv6 equivalents, `localhost` hostname; rebinding-safe (re-check after DNS) |
| 17  | Malicious tool call discovered in fetched content auto-executed   | Tool-call origin check: only model's own output (post-untrusted-content) yields legitimate tool calls; calls inside `<UNTRUSTED_CONTENT>` filtered |
| 18  | Path traversal via tool args (`read_file("../../../etc/passwd")`) | Enforce workspace-root containment in `read_file`/`write_file`/`delete_file`; reject paths outside workspace unless explicitly allowed in config |
| 19  | Command injection via `exec_command` args                         | `spawn` with arg array, `shell: false`; shell operators in args → `ToolError`; Windows built-ins require explicit `cmd.exe`/`powershell.exe` as `command`; `-Command`/`-EncodedCommand` PowerShell flags banned |
| 19b | `run_terminal` shell-string risk (all platforms)                  | `sendText(cmd, false)` only — user must press Enter; show-before-execute + denylist are the sole guards; no arg-array protection available for interactive terminals |
| 19c | Windows PowerShell destructive commands not in Unix denylist       | Platform-aware denylist: `Remove-Item -Recurse -Force`, `Invoke-Expression`/`iex`, `Format-Volume`, `Stop-Computer`, `-EncodedCommand` added alongside Unix patterns; checked on all platforms |
| 20  | Model `endpoint` pointing at non-loopback URL                     | Endpoints are explicit in `config.yaml` (no hidden defaults); non-loopback use is a visible, user-owned choice |
| 21  | Webview script injection                                          | Strict CSP in webview HTML; sanitize all rendered model output (assume hostile); no `innerHTML` from model strings without sanitization |
| 22  | Untrusted GGUF execution surface                                  | GGUFs are model weights, not executables; risk is mostly hallucination not RCE. Document HF source recommendation; do not auto-download from arbitrary URLs |

---

## Distribution / Project Risks

| #   | Risk                                                              | Mitigation                                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 23  | Continue ships first-class llama.cpp tomorrow                     | Wedge becomes 50% weaker overnight. Mitigation: pillars 2–4 (tool reliability, autodetect, search) still hold; double down on those. Also: actively contribute the bridge improvements upstream — using their distribution to build name. |
| 24  | Tool-reliability is a maintenance treadmill                       | Per-model defaults updated as new model families drop. Build a small public dataset of model-specific tool-call quirks; ship it as `docs/model-notes.md` post-v1.0 |
| 25  | VS Code marketplace discovery is brutal                           | Distinctive name (Forge), one-line wedge, screencast in README, target HN/X with a real demo. Without a marketing moment, expect ~50 installs. |
| 26  | Single-author burnout                                             | Keep scope tight per version; reject feature requests outside the four pillars; "What's not on the roadmap" section in [07-roadmap.md](07-roadmap.md) is enforced |
| 27  | License churn (Apache 2.0 vs MIT)                                 | Decide before v1.0 publish; current default lean is **Apache 2.0** for compatibility with HalluMeter and bridge |
| 28  | Cursor-compatibility breakage post-v1.0                           | Defer to post-v1.0; engage Cursor users for testing once VS Code marketplace path is stable |

---

## Compliance / Legal Risks (forward-looking)

| #   | Risk                                                              | Mitigation                                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 29  | Trademark conflict with "Forge" in software branding              | Acknowledged: SourceForge (faded), Minecraft Forge (different category). Distinctive enough for a side project. Revisit if growth requires formal trademarking. |
| 30  | Search provider ToS violation (high-volume scraping)              | Stay within free-tier limits by default; rate-limit per-provider; no automated bulk searches |
| 31  | Bundled `llama-server` binary licensing (post-v1.0)               | llama.cpp is MIT-licensed; redistribution OK; document attribution in NOTICE                |

---

## Risks That Are Out of Scope

We deliberately do not mitigate these:

| Risk                                  | Reason                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Slow inference on weak hardware       | User's machine is user's responsibility; we don't ship a fallback to cloud |
| Loss of work from VS Code crashes     | VS Code's responsibility; we persist conversations to `workspaceState`  |
| Model output quality / hallucinations | Inherent to LLMs; mitigated by HalluMeter integration in v0.9, not eliminated |
| Network outages during search         | Surface error to user; they retry. No offline cache for search.         |

---

## Pre-implementation gate (review before v0.1 coding)

Confirm each risk above has at least one mitigation listed and that the
mitigation is scheduled in the roadmap (or explicitly deferred). Risks **#3**
(checkpoints), **#4** (terminal safety), **#13** (prompt injection),
**#16** (SSRF), and **#18** (path traversal) are blockers — their mitigations
must ship in or before the version where the corresponding tools land.
