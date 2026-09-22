import { resolveModelName, splitModelProfile } from '../config/ConfigResolver';
import { updateConfigFile } from '../config/ConfigWriter';
import type { ForgeConfig } from '../config/types';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import type { RunRow } from './jobSchema';

/**
 * `jobs.allow_cli_agents` — whether an unattended job may drive a CLI agent
 * (Claude Code / Codex), which runs on the user's own subscription seat.
 *
 * Neither vendor forbids it for one person on their own seat, but it spends
 * the plan's limits with nobody watching, and OpenAI recommends an API key for
 * automated Codex. So it is off until the user consents once: the consent is
 * the approval card on `manage_jobs create/update`, which writes the flag.
 * Three doors, one rule: creating such a job, running one, and a job's turn
 * delegating to a CLI agent (`ask_local_agent`, `ask_live_session`,
 * `tell_live_session`). Attended chat is never gated.
 */

export const CLI_AGENT_CONSENT_DETAIL =
  'This job runs a CLI agent (Claude Code / Codex) unattended on your own subscription. ' +
  "Unattended runs use up your plan's usage limits, and OpenAI recommends an API key for " +
  'automated Codex. Approve to allow CLI agents in scheduled jobs from now on ' +
  '(sets `jobs.allow_cli_agents: true` in config.yaml).';

const REFUSAL =
  'CLI agents (Claude Code / Codex) are not allowed in scheduled jobs: `jobs.allow_cli_agents` ' +
  'is off. They would run unattended on the user’s subscription. The user can allow it by ' +
  'approving a manage_jobs create/update that uses a CLI model, or by setting ' +
  '`jobs.allow_cli_agents: true` in config.yaml.';

export function cliAgentsAllowed(config: ForgeConfig): boolean {
  return config.jobs?.allow_cli_agents === true;
}

/** The consent write: `jobs.allow_cli_agents: true`, comments preserved. */
export function makeAllowCliAgents(configPath: string): () => void {
  return () => updateConfigFile(configPath, (doc) => doc.setIn(['jobs', 'allow_cli_agents'], true));
}

/** True when the name resolves to a `provider: cli` model. Unknown names are not CLI. */
export function isCliAgentModel(config: ForgeConfig, name: string | null | undefined): boolean {
  if (!name) return false;
  try {
    const resolved = resolveModelName(config, splitModelProfile(name).base);
    return config.models.find((m) => m.name === resolved)?.provider === 'cli';
  } catch {
    return false; // unknown or ambiguous: the runner reports that itself
  }
}

/** Needs consent: the model is a CLI agent and the flag is off. */
export function needsCliConsent(config: ForgeConfig, model: string | null | undefined): boolean {
  return !cliAgentsAllowed(config) && isCliAgentModel(config, model);
}

/** The skipped run row for a job whose model is a blocked CLI agent, else undefined. */
export function cliAgentSkip(
  config: ForgeConfig,
  model: string,
  at: number,
  late: boolean,
): RunRow | undefined {
  if (!needsCliConsent(config, model)) return undefined;
  return {
    at,
    late,
    outcome: 'skipped',
    changed: false,
    summary: `skipped: ${model} is a CLI agent and jobs.allow_cli_agents is off`,
    delivered: 0,
  };
}

/**
 * The refusal for a job turn reaching a CLI agent by delegation, else
 * undefined (attended conversation, or the flag is on).
 */
export function unattendedCliRefusal(
  config: ForgeConfig,
  conversationId: string | undefined,
): string | undefined {
  if (!conversationId || !unattendedConversations.has(conversationId)) return undefined;
  return cliAgentsAllowed(config) ? undefined : REFUSAL;
}
