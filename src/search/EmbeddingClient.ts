import {
  DEFAULT_PROMPT_STYLE,
  formatDocument,
  formatQuery,
  type EmbeddingPromptStyle,
} from './embeddingPrompts';

export class EmbeddingClient {
  constructor(
    private readonly baseUrlProvider: () => string,
    private readonly promptStyleProvider: () => EmbeddingPromptStyle = () => DEFAULT_PROMPT_STYLE,
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
      throw new Error(
        `Embedding request failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`,
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
