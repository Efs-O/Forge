# 11 — HalluMeter Integration

**Decision deferred.** Captures the integration option; no code commitment
until post-v0.5 dogfooding.

---

## What HalluMeter Is

`HalluMeter` (https://github.com/Efs-O/hallumeter, Apache 2.0, sibling project)
is a Tauri-based always-on-top desktop overlay that monitors AI coding
sessions' context-window fill and surfaces a green/amber/red hallucination-risk
score based on research-backed degradation curves. Already supports Claude
Code, Codex, Continue, and Cursor.

For local OSS models (Llama, Qwen, Gemma, Mistral), HalluMeter currently uses
a **generic fallback curve** because per-model data is sparse — and Continue's
token fill is a "best-effort estimate" from telemetry scraping.

---

## Why It's Relevant to Forge

- Forge knows its **exact token count** and `contextLength` per model — no
  scraping needed. Forge is the ideal first-party data source for HalluMeter's
  local-model curves.
- HalluMeter's "hallucination-aware" angle directly extends Forge's wedge
  pillar of "tools tuned for local-model reliability" — see
  [02-wedge-and-positioning.md](02-wedge-and-positioning.md).
- Both projects are owned by the same author and Apache 2.0 / MIT compatible.

---

## Two Integration Paths (decision deferred)

### Path 1 — Recommend in README, no code coupling

- Add a "Recommended companion" section to Forge's README pointing to
  HalluMeter, explaining the always-on-top overlay.
- Optionally write a HalluMeter-compatible session file from Forge (~50 LoC)
  so HalluMeter detects Forge automatically alongside Claude Code, Codex,
  Continue, Cursor.
- Zero ongoing maintenance burden; tools stay independent.

**Cost**: ~1 day of work for the session-file writer + README update.

### Path 2 — Deeper integration via shared `hallumeter-core` package

- Extract HalluMeter's degradation curves into a shared TS/Rust package.
- Forge renders an inline meter in the sidebar webview (no desktop overlay
  required).
- Curve updates land in one place; both projects benefit.
- Adds a dependency edge between the two repos.

**Cost**: ~1 week of work (package extraction, TS port of curves, inline UI).

### Path 3 (post-v1.0) — Eval-data flywheel

- Forge logs per-task outcome (did the edit work? did the tool call succeed?)
  correlated with context fill.
- Aggregate → publish anonymised curve refinements → upgrade HalluMeter from
  "generic fallback" to **calibrated per-model curves for Qwen3 and Gemma 4**.
- **Strictly opt-in.** Forge's networking policy (no telemetry) is non-negotiable;
  this would require explicit user consent per session and an export mechanism
  the user controls.

**Cost**: indefinite; only viable after v1.0 with a real user base.

---

## Decision Criteria (when to revisit)

After v0.5 (read-only tools shipped, Execute mode partly working), evaluate:

1. **Are users naturally running both side-by-side?** If yes → Path 1 is
   sufficient; ship the session-file writer and README link.
2. **Do users complain about not seeing context-fill inline?** If yes →
   Path 2 is justified; extract the shared package.
3. **Is there a measurable difference in failure rates correlated with
   context fill?** If yes → Path 3 (with strict opt-in) becomes valuable.

---

## Roadmap touchpoints (already in [07-roadmap.md](07-roadmap.md))

| Version | What it adds toward HalluMeter readiness                             |
| ------- | -------------------------------------------------------------------- |
| v0.1    | Token counter exposed (precursor to writing session file)            |
| v0.4    | Plan mode displays current context-fill % at generation time         |
| v0.6    | Auto-checkpoint on agent edits (extra-cautious mode)                 |
| v0.9    | Inline meter widget — pending Path 2 decision                        |
| v1.0    | (Optional) HalluMeter-compatible session file writer (Path 1)        |

---

## What is NOT in the plan

- Bundling HalluMeter inside Forge — they're separate products by design
- Forge depending on HalluMeter at runtime — Forge must work standalone
- Default-on telemetry export — the networking policy forbids this; if
  Path 3 is ever pursued it's strict opt-in with explicit consent

---

## Next action

None until post-v0.5. Revisit this doc after v0.5 dogfooding.
