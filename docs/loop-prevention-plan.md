# Loop Prevention Plan

## Problem
The agent sometimes enters endless loops — two distinct causes:

1. **Reasoning loops** — model reconsidering the same hypothesis repeatedly without acting.
   Fixable via system prompt rules.

2. **Duplicate tool loops** — agent calls the same tool with the same args repeatedly,
   getting the same result each time. Detectable in code.

3. **Context degradation** — as the context window fills past ~75%, weaker local models
   lose coherence and start looping. Warn the user to `/compact` before this happens.

---

## Fix 1 — System Prompt (execute.njk + hardcoded fallback)
Add explicit anti-loop rules:
- If you've considered the same hypothesis twice, act or discard it — do not re-examine it.
- Never call the same tool with the same arguments twice in a row.
- After 3 consecutive tool calls with no user-visible result, stop and ask.

## Fix 2 — Duplicate Tool Call Detection (AgentLoop.ts)
In `runAgentLoop`, track the last tool call signature (name + args).
If the current round's tool calls exactly match the previous round's, break the loop
and post an error message: "Forge: agent is repeating the same tool call — stopping."

## Fix 3 — Context Pressure Warning (SidebarProvider.ts)
In `postTokenBudget()`, after computing `used` and `max`:
- If `used / max >= 0.75` and not already warned, show a VS Code warning message:
  "Forge: context is 75% full — run /compact to keep the agent coherent."
- Reset the warning when a new user turn starts (so it fires once per threshold crossing).

---

## Files Changed
| File | Change |
|---|---|
| `src/templates/builtin/execute.njk` | Add anti-loop rules |
| `src/llm/SystemPromptInjector.ts` | Add same rules to hardcoded fallback |
| `src/sidebar/AgentLoop.ts` | Duplicate tool call detection |
| `src/sidebar/SidebarProvider.ts` | Context pressure warning at 75% |
