import type { UsageHandler } from '../llm/OpenAIClient';
import { formatPromptCacheStats, readPromptCacheStats } from '../llm/promptCacheStats';
import type { PromptRequestSnapshot } from '../util/contextBudget';
import { getLogger } from '../util/logger';
import type { ConversationRuntime } from './sessionTypes';
import type { LiveStreamMeter } from './LiveStreamMeter';

const log = getLogger();

interface OutputBudgetUsage {
  onUsage: (
    usage: { prompt_tokens: number; completion_tokens: number },
    request: PromptRequestSnapshot,
  ) => void;
}

/** Per-request usage effects shared by the UI, context meter and output budget. */
export function reportRequestUsage(input: {
  conv: ConversationRuntime;
  usage: Parameters<UsageHandler>[0];
  request: PromptRequestSnapshot;
  outputBudget: OutputBudgetUsage;
  onUsage?:
    | ((conv: ConversationRuntime, inputTokens: number, outputTokens: number) => void)
    | undefined;
  streamMeter?: LiveStreamMeter | undefined;
  onContextChanged?: ((conversationId: string) => void) | undefined;
}): void {
  const { conv, usage, request } = input;
  input.onUsage?.(conv, usage.prompt_tokens, usage.completion_tokens);
  input.streamMeter?.reset(conv.id);
  input.outputBudget.onUsage(usage, request);
  input.onContextChanged?.(conv.id);
  const cache = readPromptCacheStats(usage);
  if (cache) log.debug(formatPromptCacheStats(cache));
}
