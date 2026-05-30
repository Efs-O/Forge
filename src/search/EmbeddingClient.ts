export class EmbeddingClient {
  constructor(private readonly baseUrlProvider: () => string) {}

  async embedMany(inputs: string[]): Promise<number[][]> {
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
      throw new Error(`Embedding request failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
    }

    const payload = await response.json() as {
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

  async embedOne(input: string): Promise<number[]> {
    const [embedding] = await this.embedMany([input]);
    if (!embedding) throw new Error('Embedding response returned no vector.');
    return embedding;
  }
}
