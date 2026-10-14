/** Builds the host-owned context carried into and preserved across compaction. */

import type { ChatMessage } from '../llm/types';
import { collectLastReply, toolActivityFollowedLastReply } from './compactionLastReply';
import {
  collectRecordedActions,
  mergeRecordedActions,
  renderRecordedActionsBlock,
} from './compactionLedger';
import { shedRecordedActions, shortenActionEvidence } from './compactionRecordedState';
import {
  COMPACTION_USER_REQUEST_FLOOR_CHARS,
  fitUserMessagesToHostBudget,
  renderCompactionHostBlock,
} from './compactionHostFit';
import { boundMemoryKeys, shedMemoryKeys } from './compactionWindow';
import {
  collectCompactionUserMessages,
  boundCompactionUserMessages,
  firstRequestExtraChars,
  renderCompactionUserMessages,
} from './compactionUserContext';
import type { CompactionBudget } from './compactionBudget';
import type { CompactionState, RecordedCompactionAction } from './compactionTypes';
import type { OptionalHostFacts } from './compactionHostFit';

export class CompactionHostContext {
  readonly recordedActions: RecordedCompactionAction[];
  readonly omittedActions: { file: number; command: number };
  recordedActionsText: string;
  readonly optional: OptionalHostFacts;
  readonly memoryKeys: string[];
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
    this.memoryKeys = boundMemoryKeys(memoryKeys);
    this.optional = {
      repoState: '',
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

  /** The first request's own allowance in use; CompactionService adds it to the budget. */
  get firstRequestExtraChars(): number {
    return firstRequestExtraChars(this.userMessages);
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
      ...(this.memoryKeys.length > 0 ? { memoryKeys: this.memoryKeys } : {}),
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
        'memory keys': this.memoryKeys.join(', ').length,
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

  /** Sheds required facts in the Phase 3 order, checking the rendered block after each change. */
  shedRequiredFacts(measure: () => number, maxChars: number): string[] {
    const shed: string[] = [];
    if (measure() <= maxChars) return shed;

    const shortened = shortenActionEvidence(this.recordedActions, 300);
    if (shortened.changed) {
      this.recordedActions.splice(0, this.recordedActions.length, ...shortened.actions);
      this.recordedActionsText = renderRecordedActionsBlock(
        this.recordedActions,
        this.omittedActions,
      );
      shed.push('action evidence');
    }
    if (measure() > maxChars) {
      const reduced = shedRecordedActions(
        this.recordedActions,
        this.omittedActions,
        4,
        () => measure() > maxChars,
      );
      if (reduced.dropped > 0) {
        this.recordedActions.splice(0, this.recordedActions.length, ...reduced.actions);
        this.omittedActions.file = reduced.omitted.file;
        this.omittedActions.command = reduced.omitted.command;
        this.recordedActionsText = renderRecordedActionsBlock(
          this.recordedActions,
          this.omittedActions,
        );
        shed.push(`recorded actions ×${reduced.dropped} (floor: 4 unresolved)`);
      }
    }
    if (measure() > maxChars) {
      const reduced = shedMemoryKeys(this.memoryKeys, 5);
      if (reduced.dropped > 0) {
        this.memoryKeys.splice(0, this.memoryKeys.length, ...reduced.keys);
        shed.push(`memory keys ×${reduced.dropped} (floor: 5)`);
      }
    }
    if (measure() > maxChars) {
      const bounded = boundCompactionUserMessages(
        this.userMessages,
        COMPACTION_USER_REQUEST_FLOOR_CHARS,
      );
      if (bounded.some((message, index) => message !== this.userMessages[index])) {
        this.userMessages = bounded;
        this.userContext = renderCompactionUserMessages(
          this.userMessages,
          COMPACTION_USER_REQUEST_FLOOR_CHARS,
        );
        shed.push(
          `user requests to floor (floor: ${COMPACTION_USER_REQUEST_FLOOR_CHARS} characters)`,
        );
      }
    }
    return shed;
  }
}
