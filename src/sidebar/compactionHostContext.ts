/** Builds the host-owned context carried into and preserved across compaction. */

import type { ChatMessage } from '../llm/types';
import { collectLastReply, toolActivityFollowedLastReply } from './compactionLastReply';
import {
  collectRecordedActions,
  mergeRecordedActions,
  renderRecordedActionsBlock,
} from './compactionLedger';
import { fitUserMessagesToHostBudget, renderCompactionHostBlock } from './compactionHostFit';
import { boundMemoryKeys } from './compactionWindow';
import {
  collectCompactionUserMessages,
  renderCompactionUserMessages,
} from './compactionUserContext';
import type { CompactionBudget } from './compactionBudget';
import type { CompactionState, RecordedCompactionAction } from './compactionTypes';
import type { OptionalHostFacts } from './compactionHostFit';

export class CompactionHostContext {
  readonly recordedActions: RecordedCompactionAction[];
  readonly omittedActions: { file: number; command: number };
  readonly recordedActionsText: string;
  readonly optional: OptionalHostFacts;
  readonly lastReplyFollowedByTools: boolean;
  private userMessages: string[];
  private userContext: string;
  private readonly fromIndex: number;
  private readonly generation: number;

  constructor(options: {
    previous: CompactionState | undefined;
    pending: ChatMessage[];
    summarize: ChatMessage[];
    tailStart: number;
    fromIndex: number;
    memoryKeys: readonly string[];
  }) {
    const { previous, pending, summarize, tailStart, fromIndex, memoryKeys } = options;
    this.fromIndex = fromIndex;
    this.generation = (previous?.generation ?? 0) + 1;
    const merged = mergeRecordedActions(
      previous?.recordedActions,
      collectRecordedActions(summarize),
      previous?.omittedActions,
    );
    this.recordedActions = merged.actions;
    this.omittedActions = merged.omitted;
    this.recordedActionsText = renderRecordedActionsBlock(
      this.recordedActions,
      this.omittedActions,
    );
    this.userMessages = collectCompactionUserMessages(previous?.userMessages, summarize);
    this.userContext = renderCompactionUserMessages(this.userMessages);
    this.optional = {
      repoState: '',
      memoryKeys: boundMemoryKeys(memoryKeys),
      // Only when the retained tail has no words of the agent's own. A tail that
      // carries them needs no copy; a tail that is empty, or is a user turn whose
      // answer had not started yet, leaves the summarizer's paraphrase as the sole
      // account of what the user was last told.
      lastReply: collectLastReply(pending.slice(tailStart))
        ? undefined
        : collectLastReply(summarize),
    };
    // Recorded with the reply, because the transcript it was derived from is not
    // available when the block is rendered on a later turn. The retained tail
    // counts too: a tail of tool calls with no text of its own ran after the reply.
    this.lastReplyFollowedByTools = this.optional.lastReply
      ? toolActivityFollowedLastReply([...summarize, ...pending.slice(tailStart)])
      : false;
  }

  get userContextText(): string {
    return this.userContext;
  }

  get recordedFactsText(): string {
    return this.recordedActionsText + this.optional.repoState;
  }

  candidate(summary: string): CompactionState {
    // Built before the summary so the floor check can run before the summarization request.
    return {
      summary,
      fromIndex: this.fromIndex,
      generation: this.generation,
      ...(this.userMessages.length > 0 ? { userMessages: this.userMessages } : {}),
      ...(this.recordedActions.length > 0 ? { recordedActions: this.recordedActions } : {}),
      ...(this.omittedActions.file > 0 || this.omittedActions.command > 0
        ? { omittedActions: this.omittedActions }
        : {}),
      ...(this.optional.repoState ? { repoState: this.optional.repoState } : {}),
      ...(this.optional.memoryKeys.length > 0 ? { memoryKeys: this.optional.memoryKeys } : {}),
      ...(this.optional.lastReply ? { lastReply: this.optional.lastReply } : {}),
      ...(this.optional.lastReply && this.lastReplyFollowedByTools
        ? { lastReplyFollowedByTools: this.lastReplyFollowedByTools }
        : {}),
    };
  }

  render(messages: ChatMessage[], tailChars: number) {
    return renderCompactionHostBlock({
      messages,
      candidate: this.candidate(''),
      tailChars,
      components: {
        'user requests': this.userContext.length,
        'recorded actions': this.recordedActionsText.length,
        'repo state': this.optional.repoState.length,
        'last reply': this.optional.lastReply?.length ?? 0,
      },
    });
  }

  fitUserContext(options: {
    budget: CompactionBudget;
    hostMaxChars: number;
    conversationMessages: ChatMessage[];
    tailChars: number;
  }): void {
    const { budget, hostMaxChars, conversationMessages, tailChars } = options;
    const fitted = fitUserMessagesToHostBudget({
      budget,
      hostMaxChars,
      hostChars: this.render(conversationMessages, tailChars).hostChars,
      userContextChars: this.userContext.length,
      optional: this.optional,
      userMessages: this.userMessages,
    });
    this.userMessages = fitted.userMessages;
    this.userContext = renderCompactionUserMessages(this.userMessages, fitted.maxChars);
  }
}
