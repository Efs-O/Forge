# Forge Agent Architecture Recommendations

**Date:** 2026-08-31  
**Status:** architectural review / recommendation report  
**Scope:** ideas worth borrowing from Hermes Agent and OpenClaw without turning Forge into a generic personal-assistant platform.

## Executive summary

Forge is already strong at the part that matters most for its identity: local-first software-engineering agents, direct llama.cpp/GGUF runtime control, bounded/recoverable tool use, reversible edits, VS Code integration, delegation to Codex/Claude/local models, remote control, and shared project/session knowledge through HalluScribe over MCP.

The remaining opportunities are not about copying Hermes Agent or OpenClaw wholesale. The best additions are the ones that deepen Forge as a **federated engineering-agent runtime**: multiple heterogeneous agents, shared persistent engineering memory, stronger subagent boundaries, lower context amplification, and optional durable/event-triggered execution.

The five highest-value ideas are highlighted below. The rest of the report records the broader set of suggestions so they can be evaluated individually rather than rediscovered later.

---

# Top 5 recommendations

## 1. Programmatic tool execution / Hermes-style `execute_code`

**Interest: VERY HIGH**  
**Primary benefit:** context efficiency, especially for 20-40B local models.

Today a conventional agent loop repeatedly pays for intermediate tool output:

```text
agent
  -> search
  -> result enters context
  -> agent
  -> read
  -> result enters context
  -> agent
  -> filter/compare
  -> agent
```

A programmatic tool-execution path would let the model construct a bounded script/workflow that invokes approved Forge tools and returns only the compact result needed by the parent model:

```text
agent
  -> controlled program
       -> search()
       -> read()
       -> filter()
       -> compare()
  -> compact stdout/result
  -> agent
```

This directly attacks the token-amplification pathology already measured in Forge. Intermediate outputs need not all be serialized back into the model-facing transcript.

### Design constraints

- No unrestricted shell escape disguised as a convenience feature.
- Tool invocations must still go through Forge permission/capability policy.
- The execution environment should be bounded by time, output size, call count, and accessible APIs.
- Side-effecting calls must preserve existing approval semantics.
- The generated program should be inspectable/loggable for auditability.
- Prefer strict typed wrappers around Forge tools rather than a generic opaque RPC blob.

### Why this is more interesting for Forge than for many cloud agents

Forge deliberately supports smaller local models with finite reliable context. Avoiding 20-100 KB of intermediate search/read output can improve both speed and answer quality, not only API cost.

---

## 2. Stronger isolated and optionally nested subagents

**Interest: VERY HIGH**  
**Primary benefit:** scalable multi-agent work without polluting parent context.

Forge already has delegation. The opportunity is to make delegated work a stronger runtime primitive without resurrecting the removed heavyweight worker-role system.

A subagent should ideally receive:

- a bounded task packet,
- a separate context/session,
- explicit capability/permission limits,
- access to the relevant workspace and HalluScribe knowledge,
- an execution budget,
- cancellation ownership,
- a structured result contract.

Only the useful result should return to the parent.

```text
parent agent
   |
   +--> child: implementation review
   |
   +--> child: security review
   |
   +--> child: test/diagnostic task
   |
   +<-- structured findings
```

### Optional nesting

Controlled one- or two-level nesting can be useful, but should have hard depth/concurrency limits. A child must not create an unbounded agent tree.

### Permission attenuation

A child should never gain more authority than its parent. A parent delegating a read/test task should not implicitly grant filesystem writes, terminal execution, Git mutation, or external network access.

### Resource awareness

Target selection should consider:

- local VRAM availability,
- context requirement,
- local versus CLI/cloud agent,
- expected task type,
- concurrency,
- current runtime occupancy.

This is especially important because local-model delegation can otherwise attempt to load a second GGUF that does not fit.

---

## 3. Structured HalluScribe handoff, engineering state, and provenance

**Interest: VERY HIGH**  
**Primary benefit:** heterogeneous agents sharing one durable engineering memory.

HalluScribe is already more important architecturally than a normal MCP add-on. Because Forge, Codex, Claude Code, and other MCP-capable agents can access the same archive/profile/session substrate, it can act as a shared engineering knowledge layer across otherwise independent reasoning engines.

```text
                   HalluScribe
              shared project knowledge
                 /       |       \
                /        |        \
             Forge     Codex     Claude
              GGUF       CLI       CLI
```

The next step should be to make that shared state increasingly explicit rather than relying only on raw transcript search.

### Useful structured record types

- architectural decisions,
- current project state,
- completed implementation milestones,
- unresolved issues,
- assumptions,
- known failures and failed approaches,
- benchmark/test results,
- changed-file summaries,
- pending approvals/actions,
- explicit agent handoff/checkpoint records.

### Provenance

Retrieved knowledge should retain enough metadata to answer:

- Which session produced this?
- Which model/agent produced it?
- When?
- Is it raw evidence, a digest, or an inferred summary?
- Has a newer decision superseded it?

### Freshness / authority

Where possible, distinguish:

- historical observation,
- current verified state,
- superseded decision,
- model inference,
- user decision,
- tool-verified fact.

This reduces the risk of persistent memory turning an old model mistake into a permanent project fact.

### Agent-to-agent handoff

An agent should be able to leave a concise structured checkpoint that a different agent can recover later without the parent conversation repackaging the whole history.

```text
Qwen works
   -> HalluScribe checkpoint
   -> session ends

Codex starts later
   -> reads checkpoint + supporting evidence
   -> continues from the same engineering state
```

This is one of the clearest ways Forge can differentiate from a single-vendor agent runtime.

---

## 4. Reusable engineering skills with controlled refinement

**Interest: HIGH**  
**Primary benefit:** convert repeated successful procedures into auditable capabilities.

Hermes Agent's learned/reusable skills concept is worth borrowing, but Forge should keep the implementation engineering-centric and inspectable.

A useful Forge skill is not simply a memory. It is a reusable procedure such as:

```text
.forge/skills/
  release-check/
  debug-llama-server/
  dependency-upgrade/
  site-audit/
  investigate-ci-failure/
```

A skill may contain:

- purpose and activation criteria,
- procedural instructions,
- required/allowed tools,
- validation steps,
- expected outputs,
- known failure modes,
- optional scripts/templates.

### Skill generation

After successfully completing a repeated or complex task, the agent may propose a reusable skill. Durable creation should preferably require explicit approval.

### Skill refinement

Future executions can propose changes when the existing procedure fails or when a better method is verified. Skills should remain versionable and reviewable rather than becoming opaque hidden memory.

### Dynamic loading

Do not advertise the entire skill catalog every request. Use lightweight discovery/relevance selection and inject only the procedures needed for the current task.

---

## 5. Durable scheduler, conditional jobs, and event-triggered engineering routines

**Interest: HIGH, implementation likely relatively small compared with the other four**  
**Primary benefit:** allow Forge to initiate engineering work without an active human chat turn.

Forge agents already support long multi-step work, planning, process monitoring, tool use, delegation, and remote control during an active run. The missing distinction is not "autonomy"; it is a first-class durable trigger/job layer outside the active conversation.

Useful engineering-focused examples:

- nightly repository audit,
- scheduled site audit,
- CI failure check and diagnosis,
- benchmark regression check,
- dependency-update review,
- release-readiness audit,
- periodic test suite run,
- GitHub issue triage,
- disk/VRAM/runtime health check,
- conditional Telegram notification when a monitored condition changes.

### Job properties

A durable job should have:

- stable ID,
- owner/workspace/conversation binding,
- schedule or trigger,
- current state,
- retry policy,
- last/next run metadata,
- cancellation,
- restart recovery,
- result record,
- notification policy.

The current durable remote queue, outbox, cancellation, crash-state, lease, and notification machinery may provide reusable infrastructure rather than requiring a new subsystem from zero.

### External events

Later, a generic ingress can allow GitHub/CI or another trusted source to create jobs. Avoid building a giant generic automation platform unless it directly serves engineering workflows.

---

# Additional recommendations

## 6. Structured subagent result contracts

Avoid treating delegated output as arbitrary prose when a task benefits from a predictable contract. Candidate fields:

- conclusion,
- evidence,
- files examined,
- tests run,
- proposed changes,
- risks,
- confidence,
- unresolved questions,
- recommended next action.

This is especially useful when the parent is a smaller local model.

## 7. Long-running task state separate from transcript verbosity

Maintain compact task state independent of raw conversation history:

```text
objective
completed steps
current step
blockers
files changed
test status
delegated work
pending approvals
important decisions
```

This complements transcript compaction and HalluScribe. It should not become a second contradictory source of truth; fields should be updated from verified runtime events where possible.

## 8. Conditional jobs / watches

Support "check, but act only if condition X is true" as a first-class execution pattern. Examples:

- CI changed from green to red,
- a benchmark regressed beyond threshold,
- a new dependency advisory appeared,
- a site audit found new failures,
- available disk or VRAM falls below threshold.

## 9. Capability discovery and dynamic tool exposure

Forge's built-in tool descriptions are already relatively compact. The main schema cost comes from breadth and from external MCP servers such as HalluScribe.

Consider a small stable core plus dynamically exposed domain tools when measurement shows a net gain.

Do not implement discovery merely because it is elegant: local models can perform worse if they must guess that a capability exists. Benchmark task success, tool-selection accuracy, rounds, and context savings together.

## 10. Reduce HalluScribe MCP schema cost

Measured HalluScribe schemas are comparatively expensive to advertise. Keep the architecture, but reduce recurring prompt cost where possible:

- shorten descriptions at the HalluScribe source,
- expose archive-heavy tools only for relevant models/profiles/tasks,
- provide a compact discovery/help affordance,
- retain strict schemas rather than collapsing everything into one loosely typed mega-tool.

The goal is to make HalluScribe cheaper to keep available to local models, not to weaken its capabilities.

## 11. Budget-aware delegation policy

Beyond raw VRAM availability, delegation policy can account for:

- expected context length,
- task complexity,
- agent latency,
- model strengths,
- whether an already-warm agent/runtime exists,
- current concurrency,
- whether the task needs writes or only review.

This should influence the available target catalog structurally rather than relying only on prompt instructions.

## 12. Agent capability inheritance

Define a clear rule for what delegated children inherit:

```text
child capabilities <= parent capabilities
```

The parent may further reduce the child's scope per delegation. Tool advertisement and dispatch enforcement should agree; hiding a forbidden tool only in the prompt is insufficient.

## 13. Cancellation and ownership across agent trees

If nested delegation is introduced:

- cancelling a parent should cancel or intentionally detach its children,
- children must have stable ownership identifiers,
- stale child completions should not mutate a finished/replaced parent turn,
- timeouts should produce explicit terminal states.

## 14. Shared-memory confidence and conflict handling

When HalluScribe contains contradictory sessions, the retrieval layer should make conflicts visible rather than silently choosing one summary. Prefer newer tool-verified state, explicit user decisions, and records marked as superseding prior decisions.

## 15. Durable engineering checkpoints

Allow an agent to explicitly write a handoff checkpoint before:

- context compaction,
- switching agent/model,
- pausing a long task,
- ending a remote session,
- handing work to another agent.

A checkpoint should be compact enough to load cheaply and reference deeper HalluScribe evidence when required.

## 16. Autonomous engineering routines rather than generic personal-assistant breadth

If Forge gains scheduler/event features, prioritize software-development operations rather than trying to match every OpenClaw integration.

High-value areas:

- repo health,
- CI,
- dependency/security review,
- deployment/site audit,
- benchmarks,
- issue triage,
- code-quality checks,
- release preparation.

## 17. Generic external-event ingress, later

A generic trusted event endpoint could eventually map external events into Forge jobs. Keep authentication, deduplication, replay protection, and workspace routing consistent with the remote-control architecture.

This is more valuable than individually hardcoding many external services.

## 18. Keep messaging transports thin

Telegram already exercises most of the interesting remote-control architecture. WhatsApp is useful as an optional second transport, but adding many more chat networks has diminishing architectural value.

The important layer is the common admission/authorization/queue/approval/runtime system beneath the transport.

## 19. Avoid duplicating HalluScribe with a competing Forge-native memory system

Forge does need small internal runtime state, but a second large semantic memory stack would create competing sources of truth. Prefer improving HalluScribe integration, structured records, provenance, freshness, and retrieval rather than rebuilding the same capability inside Forge.

## 20. Keep strict schemas for local models

Do not trade away schema reliability merely to save several hundred prompt tokens. Small/local models benefit disproportionately from clear, strict arguments and narrow tool contracts.

Optimization order should generally be:

1. remove redundant information,
2. dynamically avoid irrelevant tools when safe,
3. shorten descriptions,
4. reduce intermediate result propagation,
5. only then consider more radical schema consolidation.

## 21. Benchmark orchestration changes against task success, not token count alone

Any optimization that changes what the model sees should be evaluated on:

- task completion,
- number of retries,
- tool-call validity,
- rounds per task,
- context consumed,
- time to completion,
- regressions on smaller local models.

A token optimization that forces one extra repair round can cost more than it saves.

---

# Corrected architectural assessment

Several initially suggested "missing" capabilities are already present or partially present and should not be treated as gaps:

- Forge local agents can already organize multi-step work and monitor running executions during active tasks.
- Telegram provides remote initiation and control.
- Delegation already exists; the recommendation is stronger isolation/contracts/nesting, not "add delegation."
- Persistent memory is not absent: HalluScribe over MCP provides a substantial shared archive/profile/session layer that can be accessed by multiple heterogeneous agents.
- Forge's context reduction is already more sophisticated than generic blind truncation: model-facing stale-read superseding, bounded/recoverable tool results, compaction, measured usage, and prefix-stability work are all relevant foundations.

The scheduler/event layer is therefore best understood as **durable triggering**, not as the mechanism that makes Forge agents autonomous.

---

# Strategic direction

Forge should not try to become a clone of Hermes Agent or OpenClaw.

Its strongest differentiated architecture is becoming:

> **A local-first federated engineering-agent runtime where GGUF models, Codex, Claude and other agents can work against the same project, use bounded/reversible engineering tools, share persistent knowledge through HalluScribe/MCP, and be controlled locally or remotely.**

The best borrowed ideas are those that strengthen that identity:

```text
programmatic tool pipelines
          +
isolated/nested agents
          +
structured HalluScribe handoff
          +
reusable engineering skills
          +
durable jobs/triggers
          |
          v
local-first autonomous engineering system
```

Messaging breadth, generic personal-assistant integrations, and broad consumer automation should remain secondary unless they directly improve software-engineering workflows.

---

# Priority shortlist

| Priority | Feature | Expected architectural value | Relative complexity |
| --- | --- | --- | --- |
| **1** | Programmatic tool execution / `execute_code` concept | Very high | Medium-High |
| **2** | Isolated + controlled nested subagents | Very high | High |
| **3** | Structured HalluScribe state/handoff/provenance | Very high | Medium |
| **4** | Reusable engineering skills | High | Medium |
| **5** | Scheduler + durable/conditional jobs | High | Low-Medium |

These five should be evaluated independently. None requires abandoning Forge's current architecture, and several can reuse systems that already exist.

---

# README update recommendation

**Priority:** HIGH as a one-time packaging/discoverability task, not as ongoing marketing.  
**Goal:** make the README's first screen describe the product Forge has actually become.

Forge's implementation has outgrown the narrow mental model implied by a phrase such as "VS Code coding agent for local models." That description is true, but incomplete enough that a technically relevant user may leave before discovering the capabilities that differentiate Forge from a conventional local-chat extension.

The README should therefore optimize the first 30-60 seconds for **recognition**, not promotion. A user who already wants local coding agents, llama.cpp, MCP, Codex/Claude interoperability, or remote engineering control should be able to determine immediately that Forge is relevant.

## Recommended first-screen positioning

Keep the product identity precise. A strong positioning line should communicate three things at once:

1. Forge is a **coding/engineering agent runtime**, not merely a chat UI.
2. Local GGUF/llama.cpp support is **first-class runtime management**, not just another OpenAI-compatible endpoint.
3. Forge can coordinate **heterogeneous agents and shared project knowledge**, not only one local model.

Candidate direction:

> **Forge is a local-first engineering-agent runtime for VS Code: run GGUF models through llama.cpp, work with Ollama/Claude/Codex/cloud agents, connect shared MCP knowledge and tools, and control long-running engineering work locally or remotely.**

This is deliberately broader than "local LLM extension" but narrower than "general AI agent platform."

## Put the differentiators before the long feature inventory

The current README contains many strong features, but they should be grouped by why they matter rather than presented only as an expanding catalog.

The first-screen hierarchy should emphasize roughly:

### 1. Local-model-native agent runtime

- direct `llama-server` lifecycle management,
- GGUF loading and model switching,
- shared runtimes across VS Code windows,
- per-slot context accounting,
- local-model-aware tool/context protections,
- Ollama support.

This is Forge's clearest distinction from harnesses that merely accept an OpenAI-compatible URL.

### 2. Full engineering-agent loop

- file/LSP/Git/terminal/search tools,
- checkpoints and Keep/Undo,
- inline diffs,
- approval gates and Clanker mode,
- long-running execution monitoring,
- truncation recovery and context management.

Make it clear that a local model can actually **do engineering work**, not only answer questions about code.

### 3. Mixed-agent interoperability

- persistent Codex CLI sessions,
- persistent Claude Code sessions,
- delegation to other agents,
- MCP client bridge,
- HalluScribe/shared project-session knowledge where configured.

This is architecturally important and currently easy to underestimate. Forge is not forced into a local-versus-cloud choice; local and commercial agents can coexist around the same engineering environment.

### 4. Remote engineering control

- Telegram owner pairing,
- TOTP/security model,
- durable FIFO requests,
- remote approvals,
- conversation/model/workspace control,
- attachments,
- crash-safe queue/outbox semantics.

Describe this as **remote control of the same Forge agent runtime**, not as a Telegram chatbot feature.

## Add one compact architecture diagram near the top

A diagram can communicate the system faster than several paragraphs:

```text
                 VS Code / Telegram
                        |
                        v
                      Forge
          engineering-agent runtime
             /          |          \
            /           |           \
      local GGUF      Codex       Claude
      llama.cpp         CLI          CLI
            \           |           /
             \----------+----------/
                        |
                    MCP tools
                        |
                  HalluScribe
              shared project history
```

The exact diagram should reflect only currently supported paths. Do not imply that HalluScribe is bundled with Forge if it remains an external MCP server.

## Make HalluScribe/MCP understandable without requiring prior context

The README already documents generic MCP support. Add a small example explaining the architectural consequence:

> Forge can consume external MCP servers. In one deployed configuration, HalluScribe exposes shared session/archive tools to Forge while the same MCP knowledge layer can also be used by Codex or Claude Code. This allows heterogeneous agents to recover common project history without embedding that memory system inside Forge.

Keep this as an example, not a hard dependency or bundled feature claim.

## Explain local-agent context engineering as a product feature

Forge has invested unusually deeply in failure modes that become important on 20-40B local models. The README should surface this without drowning the reader in internals.

A short section such as **Built for local-model limits** can mention:

- per-slot context budgeting,
- measured rather than guessed context usage,
- bounded tool results,
- recoverable excerpts,
- superseded stale-read removal,
- prompt-prefix stability work,
- truncated tool-call recovery,
- compaction designed to preserve the raw transcript.

This explains why Forge is not equivalent to wiring a GGUF endpoint into a cloud-first harness.

## Improve search/discovery metadata once, not continuously

This recommendation is explicitly **not** a social-media or advertising program.

Audit the static metadata that search engines, GitHub, Marketplace, and users already consume:

- VS Code Marketplace display name/subtitle/description,
- extension keywords in `package.json`,
- GitHub repository description,
- GitHub topics,
- README title/first paragraph/headings,
- Open VSX description if applicable.

Useful terms should be present naturally where accurate, for example:

- local coding agent,
- local LLM,
- llama.cpp,
- GGUF,
- VS Code agent,
- MCP,
- Codex CLI,
- Claude Code,
- Ollama,
- agentic coding,
- local AI coding assistant,
- multi-agent coding.

Do not keyword-stuff. The objective is that someone already searching for the capability can find the project.

## Include a capability comparison, but avoid a marketing scoreboard

A small factual table can answer "why would I use Forge instead of connecting a model to another extension?"

Candidate rows:

| Capability | Forge approach |
| --- | --- |
| GGUF / llama.cpp | Forge owns and manages the runtime |
| Ollama | Native local-daemon/cloud routing |
| Codex / Claude | Persistent authenticated CLI sessions |
| External tools | MCP stdio bridge with capability classification |
| Local-model context | Per-slot accounting, bounded/recoverable tool context, compaction |
| File-changing work | Approval gates, inline diffs, Keep/Undo checkpoints |
| Remote control | Authenticated Telegram transport over the same agent runtime |
| Shared knowledge | External MCP knowledge layers such as HalluScribe |

Avoid claims such as "better than OpenClaw/Hermes/Cline/Cursor" in the README unless backed by a concrete benchmark. Explain architecture instead.

## Show one end-to-end workflow

Feature lists make Forge look like a collection of integrations. One workflow demonstrates that the pieces compose:

```text
Telegram request
   -> Forge opens/binds project conversation
   -> local Qwen investigates code
   -> HalluScribe retrieves relevant prior project work
   -> Qwen delegates a review to Codex
   -> Forge edits/tests with approval/checkpoint protection
   -> final result returns to Telegram
```

Use only a workflow that is actually supported and validated. If a step requires configuration, say so.

## Keep installation early and simple

Do not let architectural depth make the README intimidating. After the positioning/differentiators, users should reach a minimal quick-start path quickly:

1. install Forge,
2. point it at `llama-server`, Ollama, an OpenAI-compatible endpoint, or an authenticated CLI,
3. select/configure a model,
4. start a conversation.

Advanced MCP, HalluScribe, Telegram, shared-runtime, embedding, and control-server setup should remain linked subsections rather than prerequisites.

## Preserve trust signals

Forge's no-telemetry/local-first behavior deserves prominent but precise wording:

- local execution is the default,
- external providers/services are opt-in,
- credentials are stored in SecretStorage where applicable,
- remote messages necessarily traverse their configured messaging provider,
- external MCP servers have their own trust boundary.

Do not imply "everything stays local" once Telegram, cloud providers, web search, external MCP servers, or CLI providers are enabled.

## README work that is not worth doing

Avoid turning README maintenance into another project:

- no release-by-release marketing copy at the top,
- no giant badge wall,
- no competitor attack section,
- no exaggerated benchmark claims,
- no duplicated documentation for every config field,
- no requirement to continuously produce screenshots/videos,
- no social-media workflow tied to releases.

The target is a **one-time structural rewrite plus occasional factual maintenance**.

## Recommended README structure

```text
Forge LLM
  one-sentence positioning
  4-6 differentiators
  compact architecture diagram
  screenshots/demo

Why Forge
  local-model-native runtime
  engineering agent loop
  mixed agents + MCP/shared knowledge
  remote control
  reversible/safe execution

Quick Start

How it works
  backends
  agent/tool model
  context handling

MCP + HalluScribe example
Codex / Claude CLI agents
Remote control
Shared runtimes
Search / semantic code search
Configuration
Security / privacy
Development / testing
```

The first screen should answer **what Forge is and why it is technically different**. The remainder can continue to serve as the detailed operator documentation it already is.

## Acceptance criterion

The README update succeeds if a technically relevant developer can look at the first screen and correctly answer, without scrolling through the entire document:

- Is Forge a real coding agent or only a chat UI?
- Does it manage local GGUF/llama.cpp itself?
- Can it coexist with Codex/Claude/Ollama/cloud models?
- Does it support MCP/shared external knowledge?
- Can it safely perform and reverse file-changing work?
- Can it be controlled remotely?

If those answers are obvious, discoverability has improved without requiring the project maintainer to become a marketer.