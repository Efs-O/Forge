# CLI agents in unattended jobs: one consent, one flag

## Problem

A scheduled job (`agent_task`) can run a CLI agent (Claude Code / Codex) on
the user's own subscription with nobody watching. It can do that as the job's
model or by delegating from a local model's turn (`ask_local_agent`,
`ask_live_session`, `tell_live_session`). Neither vendor forbids this for one
person on their own seat: Anthropic permits ordinary individual use of the
unmodified `claude` binary, and OpenAI recommends an API key for automated
Codex but does not prohibit a login. But an unattended run spends the plan's
usage limits, and until now nothing asked first.

## Design

- **Config.** `jobs.allow_cli_agents: boolean`, default `false`.
- **Consent.** `manage_jobs` create/update for an `agent_task` whose model
  (named, or the pinned `active_model`) resolves to `provider: cli` gets a
  **dangerous** approval card while the flag is off, which rules out /clanker
  auto-approval. The card says what it spends. Approving it writes
  `jobs.allow_cli_agents: true` with comments preserved, then creates the job.
  Declining creates nothing. There is no Telegram notification: the card
  already reaches remote surfaces through the approval path.
- **Enforcement at run time.** `AgentTaskRunner` records a `skipped` run row
  instead of starting a CLI-agent job while the flag is off. This covers a flag
  turned off by hand after the job was created.
- **Delegation.** The three delegation tools refuse a CLI target only inside
  an unattended (job) conversation with the flag off. The refusal names the
  flag. Attended chat is never gated.
- **Owner.** `src/jobs/cliAgentGate.ts`. Every door calls into it.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `jobs.allow_cli_agents` in config.yaml | Consent approval on manage_jobs (via `updateConfigFile`), or a hand edit | Hand edit only; an absent key parses as `false` | Set `false`: the next run is skipped and delegation is refused; existing jobs stay defined | `updateConfigFile` validates, then writes atomically, so the old file survives | Nothing in memory to lose; the next `getConfig()` reads the file | None, by design: consent lasts until the user revokes it |
| CLI-agent job definition (existing JobStore file) | manage_jobs create, only after consent while the flag is off | manage_jobs delete (unchanged) | Flag off means each run becomes a `skipped` run row, never a silent drop | JobStore's existing atomic write (unchanged) | Scheduler re-reads on restart; the gate is re-checked per run | Job's own schedule (unchanged) |

CI-enforced row: `test/unit/CliAgentGate.test.ts` asserts the flag-off run is
`skipped` and that the consent write preserves comments.

## Acceptance criteria

- With the flag off, creating a CLI-model `agent_task` shows a dangerous
  approval card. Approving it sets the flag and creates the job.
- A local-model job never shows the card. Once the flag is on, the card is
  gone.
- With the flag off, a CLI-agent job run is recorded as `skipped` with a
  reason that names the flag.
- A job turn that delegates to a CLI agent is refused while the flag is off.
  The same call from an attended chat works.
- `npm run ci` is green.
