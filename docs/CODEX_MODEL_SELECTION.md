# Codex model / reasoning-effort selection

Reference for "use model X at effort Y for this Codex session". Written
2026-10-03 against **codex-cli 0.155.1**. Everything here was measured against
the live app-server, not inferred. Read this before re-deriving any of it —
in particular, **do not grep the Codex binary and do not ask the model which
model it is** (a model naming itself is not evidence).

## 1. The config keys

`.forge/config.yaml` → `agent_bus:`

| Key | Type | Reaches |
|---|---|---|
| `codex_model` | string, optional | `thread/start` `model`; `thread/resume` `model` |
| `codex_effort` | `low\|medium\|high\|xhigh\|max` | process-level `-c model_reasoning_effort="<v>"`; resume `config.model_reasoning_effort` |

Schema: `src/config/agentBusSchema.ts`. Plumbing: `agentMesh/ownedSessionFactory.ts`
→ `agentMesh/creationPreamble.ts` → `agents/CodexAppServerSession.ts`
→ `agents/codexAppServerArgs.ts`.

**`ultra` gap:** `gpt-6-astra` / `gpt-6-sol` / `gpt-5.6-*` advertise `ultra`,
but Forge's Zod enum stops at `max`, so `ultra` cannot be set through config.
Adding it is a one-line enum change.

## 2. Authoritative model list — one command

Spawn `codex app-server --stdio`, send `initialize`, then `model/list`.
Each entry carries `supportedReasoningEfforts`, so this also answers "which
efforts can I use with model X".

Observed 2026-10-03 (codex-cli 0.155.1):

| Model | Default | Efforts |
|---|---|---|
| `gpt-6-astra` (isDefault) | low | low/medium/high/xhigh/max/ultra |
| `gpt-6-sol` | medium | low/medium/high/xhigh/max/ultra |
| `gpt-6-luna` | medium | low/medium/high/xhigh/max |
| `gpt-5.6-sol` | low | low/medium/high/xhigh/max/ultra |
| `gpt-5.6-terra` | medium | low/medium/high/xhigh/max/ultra |
| `gpt-5.6-luna` | medium | low/medium/high/xhigh/max |
| `gpt-5.5` | medium | low/medium/high/xhigh |

`~/.codex/config.toml` may carry `notice.model_migrations`
(e.g. `"gpt-5.6-luna" = "gpt-6-luna"`), so an old name auto-migrates.

## 3. Where selection does and does not apply

| Surface | Can Forge set it? | How |
|---|---|---|
| Forge-**owned** session, fresh | ✅ | `thread/start {model}` + `-c model_reasoning_effort` |
| Forge-**owned** session, resumed | ✅ (fixed 2026-10-03) | `thread/resume {model, config:{model_reasoning_effort}}` |
| **Joined** session (`by: "user"` in `~/.forge/agent-bus/aliases.json`) | ❌ | User's own Codex window selector |
| One specific task | ⚠️ CLI only | `codex exec -m X -c model_reasoning_effort=Y` |

Why the joined case is unfixable from Forge: `thread/settings/update` — the
only live model switch — is rejected with *"requires experimentalApi
capability"*, and Forge never claims that capability. A joined thread is also
owned by another process, so Forge must not re-create it.

`thread/resume`'s `config` map is **not** experimental-gated (verified).
`turn/start` also accepts `model`/`effort` per turn, but that is not the
per-task knob Forge exposes.

## 4. There is no per-call model argument

- `ask_live_session` takes `subject` / `question` / `target` / `session` /
  `wait_minutes` — **no `model`**.
- `ask_local_agent`'s `model` names a **delegation target** from
  `list_delegation_targets`, not an arbitrary Codex model.

So "use sol medium for this task" resolves to: edit the two config keys →
re-create the owned session → verify. Not a per-call flag.

## 5. Config edits need a session re-creation

`createOwnedCodex()` reads `agent_bus` only at creation, and the live session
is cached in `OwnedSessionFactory.owned`. Editing the keys does **nothing** to
an already-running owned session. The alias must be closed / parked / reaped
first; the next `ask_live_session` then re-creates it with the new values.

## 6. Verify by reading the rollout, never the reply

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*<thread_id>.jsonl
```

Grep for `"model":"…"` and `"reasoning_effort":"…"`. They appear per
`turn_context`, so a mid-session switch is visible turn by turn.

Measured proof of the resume override (2026-10-03): thread created on
`gpt-5.6-sol` + `medium`; after `thread/resume {model:"gpt-6-luna",
config:{model_reasoning_effort:"xhigh"}}` the next turn's context read
`gpt-6-luna` / `xhigh`, and a later plain resume kept it.

## 7. Cleanup note

Throwaway probe threads: `thread/delete {threadId}`. A thread with **no
completed turn never writes a rollout**, so it cannot be resumed or deleted
afterwards — expect `no rollout found for thread id …`.
