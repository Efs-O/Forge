import type { CliAdapter, CliAgentName } from '../types';
import { claudeAdapter } from './claudeAdapter';
import { codexAdapter } from './codexAdapter';

const ADAPTERS: Partial<Record<CliAgentName, CliAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getCliAdapter(name: CliAgentName): CliAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(
      `No one-shot CLI adapter for "${name}" — copilot runs as an owned ACP session (CopilotAcpSession), not through the one-shot driver.`,
    );
  }
  return adapter;
}
