import {
  DEFAULT_PROMPT_STYLE,
  formatDocument,
  formatQuery,
  type EmbeddingPromptStyle,
} from './embeddingPrompts';
import {
  DEFAULT_EMBEDDING_WINDOW,
  estimateTokens,
  maxPossibleTokens,
  type TokenCounter,
} from './embeddingBudget';

export class EmbeddingClient {
  constructor(
    private readonly baseUrlProvider: () => string,
    private readonly promptStyleProvider: () => EmbeddingPromptStyle = () => DEFAULT_PROMPT_STYLE,
    private readonly maxTokensProvider: () => number = () => DEFAULT_EMBEDDING_WINDOW,
    private readonly tokenCounterProvider: () => TokenCounter | null = () => null,
  ) {}

  /** Embed indexed content. Documents and queries take different prefixes. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const style = this.promptStyleProvider();
    return this.post(texts.map((text) => formatDocument(text, style)));
  }

  /** Embed a search query. Must use the same style the index was built with. */
  async embedQuery(text: string): Promise<number[]> {
    const style = this.promptStyleProvider();
    const [embedding] = await this.post([formatQuery(text, style)]);
    if (!embedding) throw new Error('Embedding response returned no vector.');
    return embedding;
  }

  private async post(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];

    // llama.cpp's /v1/embeddings combines every string in the `input` array
    // into one physical batch per slot. In --embeddings + pooling mode the
    // entire batch must fit in --ubatch-size or the server returns HTTP 500
    // "input is too large to process". We therefore split the inputs into
    // sub-batches whose total token count stays under the budget, which
    // mirrors the server's --ubatch-size (pinned to embeddings.n_ctx).
    //
    // The count is EXACT when a TokenCounter is configured (measured via the
    // server's own tokenizer); otherwise it falls back to the byte bound
    // (maxPossibleTokens), a provable upper bound. estimateTokens is no longer
    // used for packing — it undercounts dense content and was the root cause
    // of the recurring 500s.
    const subBatches = await this.splitByTokenBudget(inputs, this.maxTokensProvider());
    const results: number[][] = [];
    for (const sub of subBatches) {
      const vectors = await this.postOne(sub);
      results.push(...vectors);
    }
    return results;
  }

  /** Exact token count of `text`, or the byte bound when no counter is set. */
  private async countTokens(text: string): Promise<number> {
    const counter = this.tokenCounterProvider();
    if (counter) return counter.count(text);
    return maxPossibleTokens(text);
  }

  /**
   * Greedily pack inputs into sub-batches respecting the token budget. A single
   * input that exceeds the window on its own can never fit (no packing helps),
   * so it is a chunker bug / misconfigured window and fails fast with the
   * measured number rather than 500ing at the server.
   */
  private async splitByTokenBudget(inputs: string[], maxTokens: number): Promise<string[][]> {
    if (inputs.length === 0) return [];
    const subBatches: string[][] = [];
    let current: string[] = [];
    let currentCount = 0;

    for (const input of inputs) {
      const count = await this.countTokens(input);
      if (count > maxTokens) {
        throw new Error(
          `Embedding input exceeds the physical batch: ${count} tokens > ${maxTokens}. ` +
            'This is a chunking bug — every chunk must fit the window before it is sent.',
        );
      }
      if (current.length > 0 && currentCount + count > maxTokens) {
        subBatches.push(current);
        current = [];
        currentCount = 0;
      }
      current.push(input);
      currentCount += count;
    }
    if (current.length > 0) subBatches.push(current);
    return subBatches;
  }

  private async postOne(inputs: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrlProvider()}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'embedding',
        input: inputs,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Backstop: exact measurement can be defeated by operational skew — the
      // embedding server restarting under a different model mid-build, or a
      // future llama.cpp whose embedding path adds a token /tokenize does not.
      // If the server says the batch is too large, split and retry so the build
      // survives; a single oversized input is a chunker bug and fails loudly.
      if (response.status === 500 && detail.includes('is too large to process')) {
        if (inputs.length > 1) {
          const mid = Math.ceil(inputs.length / 2);
          const left = await this.postOne(inputs.slice(0, mid));
          const right = await this.postOne(inputs.slice(mid));
          return [...left, ...right];
        }
        const parsed = detail.match(/(\d+) tokens.*?batch size: (\d+)/);
        throw new Error(
          `Embedding input exceeds the physical batch: server reports ` +
            `${parsed ? `${parsed[1]} tokens > batch size ${parsed[2]}` : 'input too large'}. ` +
            'This is a chunking bug — every chunk must fit the window before it is sent.',
        );
      }
      // Diagnostics: how many inputs, and the largest by char count.
      const maxChars = Math.max(0, ...inputs.map((i) => i.length));
      throw new Error(
        `Embedding request failed: HTTP ${response.status} ` +
          `(inputs=${inputs.length}, maxChars=${maxChars}, estTokens=${estimateTokens(inputs.join('\n'))})` +
          `${detail ? ` - ${detail}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    if (!Array.isArray(payload.data)) {
      throw new Error('Embedding response was missing a data array.');
    }

    return payload.data
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) {
          throw new Error('Embedding response item was missing the embedding vector.');
        }
        return item.embedding;
      });
  }
}
