import { CompactionFailure } from './compactionFailure';
import type { ConversationRuntime } from './sessionTypes';
import type { CompactionBudget } from './compactionBudget';
import { COMPACTION_CHARS_PER_TOKEN } from './compactionBudget';
import { getLogger } from '../util/logger';
import type { ChatMessage } from '../llm/types';
import type { CompactionState } from './compactionTypes';
import { compactionWindowChars, replacementHostMessages } from './compactionWindow';
import { boundCompactionUserMessages, USER_CONTEXT_MAX_CHARS } from './compactionUserContext';

/** Optional host facts. Required facts (user requests, recorded actions) are never shed. */
export interface OptionalHostFacts {
  repoState: string;
  memoryKeys: string[];
  lastReply: string | undefined;
}

export const REPO_STATE_SHED_MARKER = '[repository state omitted to fit the compaction budget]';

/**
 * Sheds optional facts, least valuable first, until the host block fits.
 * `measure` renders the real candidate, so sizes are actual rather than nominal maxima.
 * Returns the names of what was shed (for the log), mutating `optional` in place.
 */
export function shedOptionalHostFacts(
  optional: OptionalHostFacts,
  measure: () => number,
  maxChars: number,
): string[] {
  const shed: string[] = [];
  const steps: Array<[string, () => boolean]> = [
    [
      'repo state',
      () => {
        if (!optional.repoState || optional.repoState === REPO_STATE_SHED_MARKER) return false;
        optional.repoState = REPO_STATE_SHED_MARKER;
        return true;
      },
    ],
    [
      'memory keys',
      () => {
        if (optional.memoryKeys.length === 0) return false;
        optional.memoryKeys = [];
        return true;
      },
    ],
    [
      'last reply',
      () => {
        if (!optional.lastReply) return false;
        optional.lastReply = undefined;
        return true;
      },
    ],
  ];
  for (const [name, apply] of steps) {
    if (measure() <= maxChars) break;
    if (apply()) shed.push(name);
  }
  return shed;
}

/** Names the largest remaining host component so a refusal says what to reduce. */
export function refuseHostFacts(
  hostChars: number,
  maxChars: number,
  components: Record<string, number>,
): never {
  const [largest] = Object.entries(components).sort((a, b) => b[1] - a[1])[0] ?? ['host facts'];
  throw new CompactionFailure(
    'budget-refusal',
    `Required host-preserved compaction facts need an estimated ${hostChars} characters, above the ${maxChars}-character budget (largest component: ${largest}); previous context kept.`,
  );
}

export type CompactionCounterName = 'tokenize' | 'count_tokens' | 'estimate';

export interface HostFitResult {
  hostChars: number;
  hostMaxChars: number;
  charsPerToken: number;
  counter: CompactionCounterName;
  shed: string[];
  components: Record<string, number>;
  floorChars: number;
}

/** Bounds persisted user requests only when the policy budget reflects real usage. */
export function fitUserMessagesToHostBudget(options: {
  budget: CompactionBudget;
  hostMaxChars: number;
  hostChars: number;
  userContextChars: number;
  optional: OptionalHostFacts;
  userMessages: string[];
}): { userMessages: string[]; maxChars: number } {
  const { budget, hostMaxChars, hostChars, userContextChars, optional, userMessages } = options;
  if (budget.policyTokens > budget.observedTokens) {
    return {
      userMessages,
      maxChars: USER_CONTEXT_MAX_CHARS,
    };
  }
  const optionalChars =
    optional.repoState.length +
    optional.memoryKeys.reduce((total, key) => total + key.length, 0) +
    (optional.lastReply?.length ?? 0);
  const fixedHostChars = hostChars - userContextChars - optionalChars;
  const maxChars = Math.max(4_000, hostMaxChars - fixedHostChars);
  const bounded = boundCompactionUserMessages(userMessages, maxChars);
  return { userMessages: bounded, maxChars };
}

/** Measures one rendered host block, sheds optional facts, then admits or refuses it. */
export async function fitCompactionHostBlock(options: {
  optional: OptionalHostFacts;
  budget: CompactionBudget;
  budgetForCharsPerToken: (ratio: number) => CompactionBudget;
  render: () => {
    hostChars: number;
    floorChars: number;
    hostBlock: string;
    components: Record<string, number>;
  };
  counter: CompactionCounterName;
  countTokens?: (text: string, conv: ConversationRuntime) => Promise<number>;
  endpoint?: string;
  conv: ConversationRuntime;
  onHostBudget?: (hostMaxChars: number) => void;
}): Promise<HostFitResult> {
  const {
    optional,
    budget,
    budgetForCharsPerToken,
    render,
    counter,
    countTokens,
    endpoint,
    conv,
    onHostBudget,
  } = options;
  const largest = render();
  let charsPerToken = COMPACTION_CHARS_PER_TOKEN;
  if (counter !== 'estimate') {
    if (!countTokens)
      throw new CompactionFailure('budget-refusal', `No ${counter} counter is configured.`);
    try {
      const tokens = await countTokens(largest.hostBlock, conv);
      if (!Number.isSafeInteger(tokens) || tokens <= 0)
        throw new Error(`invalid token count ${tokens}`);
      const measured = largest.hostBlock.length / tokens;
      charsPerToken = Math.max(2, Math.min(5, measured));
      if (charsPerToken !== measured) {
        getLogger().info(
          `[compact] charsPerToken ratio ${measured.toFixed(2)} clamped to ${charsPerToken.toFixed(2)}`,
        );
      }
    } catch (err) {
      const where = endpoint ? ` at ${endpoint}` : '';
      throw new CompactionFailure(
        'budget-refusal',
        `Configured ${counter} counter${where} failed: ${(err as Error).message}; previous context kept.`,
      );
    }
  }
  const hostMaxChars =
    counter === 'estimate'
      ? budget.hostMaxChars
      : budgetForCharsPerToken(charsPerToken).hostMaxChars;
  onHostBudget?.(hostMaxChars);
  const shed = shedOptionalHostFacts(optional, () => render().hostChars, hostMaxChars);
  const rendered = render();
  if (rendered.hostChars > hostMaxChars) {
    refuseHostFacts(rendered.hostChars, hostMaxChars, rendered.components);
  }
  return {
    ...rendered,
    hostMaxChars,
    charsPerToken,
    counter,
    shed,
  };
}

/** Renders the exact replacement host block and its character components. */
export function renderCompactionHostBlock(options: {
  messages: ChatMessage[];
  candidate: CompactionState;
  tailChars: number;
  components: Record<string, number>;
}): {
  hostChars: number;
  floorChars: number;
  hostBlock: string;
  components: Record<string, number>;
} {
  const { messages, candidate, tailChars, components } = options;
  const floorChars = compactionWindowChars(messages, candidate);
  const hostBlock = replacementHostMessages(candidate)
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n\n');
  return { hostChars: floorChars - tailChars, floorChars, hostBlock, components };
}
