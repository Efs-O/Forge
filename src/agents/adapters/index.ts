import type { CliAdapter, CliAgentName } from '../types';
import { claudeAdapter } from './claudeAdapter';
import { codexAdapter } from './codexAdapter';

const ADAPTERS: Record<CliAgentName, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getCliAdapter(name: CliAgentName): CliAdapter {
  return ADAPTERS[name];
}
