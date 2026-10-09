import type { ModelConfig } from '../config/types';
import type { ToolCallProgressHandler, UsageHandler } from '../llm/OpenAIClient';
import type { ChatMessage, ToolCall, ToolDefinition } from '../llm/types';
import type { ToolResultContextResult } from './toolResultContext';

/** Inputs and outputs shared by the tool-calling loop and its turn adapter. */
export interface ToolCallingLoopOptions {
  /** Re-resolved on every round because the backend pool can rotate endpoints. */
  resolveBaseUrl: () => Promise<string>;
  model: ModelConfig;
  messages: ChatMessage[];
  /** Rebuilt each round so a just-loaded lazy group is present immediately. */
  getToolDefinitions: () => ToolDefinition[];
  dispatchToolCalls: (calls: ToolCall[], messages: ChatMessage[]) => Promise<void>;
  prepareMessages?: (messages: ChatMessage[]) => ChatMessage[] | ToolResultContextResult;
  signal: AbortSignal;
  apiKey?: string;
  maxRounds: number;
  /** The model's `writeChunkLimit`; truncation recovery stays under it. */
  writeChunkLimit?: number;
  /**
   * Tools held back until a tool call is cut off this turn. Offering
   * `append_file` up front made the model split new files into write + append
   * calls it did not need (5/5 runs on one task), each a separate request; with
   * no append tool on offer, the same model wrote them in one call.
   */
  offerAfterTruncation?: readonly string[];
  maxOutputTokens?: number;
  nativeTools: boolean;
  stripAllTools?: boolean;
  canUseThinkingKwargs?: boolean;
  stripThinkingChannels?: boolean;
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCallProgress?: ToolCallProgressHandler;
  onDone?: (finishReason: string | null) => void;
  onRepeatedCall?: () => void;
  onNativeFallback?: () => void;
  /** Called as soon as a transcript entry is appended, before the turn ends. */
  onMessagesChanged?: () => void;
  /** Actual tool names from the request, after all filtering, before dispatch. */
  onToolsOffered?: (names: readonly string[]) => void;
  /** Finished narration for a round that calls tools. */
  onRoundNarration?: (text: string) => void;
  /** Request exact provider usage in the final stream frame. */
  includeUsage?: boolean;
  onUsage?: UsageHandler;
  /** Claim messages waiting for the next safe gap after a completed tool round. */
  drainTells?: () => Promise<{
    messages: ChatMessage[];
    settle?: () => Promise<void>;
  }>;
  /** Fired when a tool call was cut off and the loop asks for it in chunks. */
  onTruncatedToolCall?: (info: { toolName: string | undefined; approxBytes: number }) => void;
  /** Output tokens the model may still generate for these messages. */
  getOutputRoom?: (messages: ChatMessage[]) => number | undefined;
  isMutatingTool?: (name: string) => boolean;
  /** Compacts between rounds; `exhausted` means the next round cannot fit. */
  compactMidTurn?: (request: {
    exhausted: boolean;
    rawUsed?: number | undefined;
    trimAdvanced?: boolean;
  }) => Promise<boolean>;
}

export interface ToolCallingLoopResult {
  finishReason: string | null;
  finalText: string;
  rounds: number;
  repeatedCall: boolean;
  /** The loop stopped because it ran out of rounds, not because the model was done. */
  hitRoundCap: boolean;
  /** The model stopped while still inside its thinking block, leaving no answer. */
  stoppedWhileReasoning?: boolean;
}
