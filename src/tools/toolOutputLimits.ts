import type { ForgeConfig, LlamaServerConfig, ModelConfig } from '../config/types';
import { COMPACTION_CHARS_PER_TOKEN } from '../sidebar/compactionBudget';
import { perSlotContext } from '../util/contextBudget';

export interface ToolOutputLimits {
  searchLines: number;
  resultPageChars: number;
  shellInlineChars: number;
  execOutputChars: number;
}

export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = {
  searchLines: 50,
  resultPageChars: 6_000,
  shellInlineChars: 30_000,
  execOutputChars: 16_000,
};

const CEILINGS: ToolOutputLimits = {
  searchLines: 200,
  resultPageChars: 24_000,
  shellInlineChars: 60_000,
  execOutputChars: 32_000,
};

export function toolOutputLimits(
  model: ModelConfig,
  server: LlamaServerConfig | undefined,
  autoCompact: ForgeConfig['auto_compact'],
): ToolOutputLimits {
  const window = perSlotContext(model, server);
  if (window <= 0 || autoCompact?.enabled !== true) return { ...DEFAULT_TOOL_OUTPUT_LIMITS };
  const chars = (fraction: number): number =>
    Math.floor(window * fraction * COMPACTION_CHARS_PER_TOKEN);
  return {
    searchLines: Math.min(CEILINGS.searchLines, Math.max(50, Math.floor(window / 1_000))),
    resultPageChars: Math.min(CEILINGS.resultPageChars, Math.max(6_000, chars(0.04))),
    shellInlineChars: Math.min(CEILINGS.shellInlineChars, Math.max(30_000, chars(0.1))),
    execOutputChars: Math.min(CEILINGS.execOutputChars, Math.max(16_000, chars(0.06))),
  };
}
