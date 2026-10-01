/**
 * Counts what a model request has streamed so far, per conversation, so the
 * status bar can move while a long thinking pass is still running.
 *
 * Every other number on the bar is server-reported and lands only when a
 * request ends. These are an estimate from streamed characters, cleared the
 * moment the server's own count arrives, and labelled `~` wherever shown.
 */

/** Characters per token for the estimate; English prose and code sit near 4. */
const CHARS_PER_TOKEN = 4;

export interface LiveStreamEstimate {
  reasoningTokens: number;
  answerTokens: number;
}

export class LiveStreamMeter {
  private readonly chars = new Map<string, { reasoning: number; answer: number }>();

  add(conversationId: string, kind: 'reasoning' | 'answer', text: string): void {
    const entry = this.chars.get(conversationId) ?? { reasoning: 0, answer: 0 };
    entry[kind] += text.length;
    this.chars.set(conversationId, entry);
  }

  /** The request ended (or a new one began): the server's count takes over. */
  reset(conversationId: string): void {
    this.chars.delete(conversationId);
  }

  read(conversationId: string): LiveStreamEstimate | undefined {
    const entry = this.chars.get(conversationId);
    if (!entry) return undefined;
    return {
      reasoningTokens: Math.round(entry.reasoning / CHARS_PER_TOKEN),
      answerTokens: Math.round(entry.answer / CHARS_PER_TOKEN),
    };
  }
}
