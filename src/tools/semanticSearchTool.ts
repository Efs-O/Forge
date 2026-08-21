import type { RegisteredTool } from './ToolRegistry';
import type { IndexManager } from '../search/IndexManager';

export function makeSearchCodebaseTool(indexManager: IndexManager): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_codebase',
        description:
          'Search the indexed workspace semantically and return the most relevant code snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language or code query to search for.' },
            top_k: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description: 'Maximum number of results to return. Defaults to 5.',
            },
            scope_glob: {
              type: 'string',
              description: 'Optional file glob to narrow the search scope.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    approval: () => indexManager.startApproval(),
    handler: async (args) => {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('search_codebase: query must be a non-empty string.');
      }
      const topK = typeof args['top_k'] === 'number' ? args['top_k'] : 5;
      const scopeGlob = typeof args['scope_glob'] === 'string' ? args['scope_glob'] : undefined;
      const hits = await indexManager.search(query, topK, scopeGlob);
      if (hits.length === 0) {
        return `No semantic matches found for "${query}".`;
      }
      return hits
        .map((hit, index) => {
          const score = hit.score.toFixed(3);
          const header = `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine} (score ${score})`;
          const symbol = hit.symbolName ? `Symbol: ${hit.symbolName}\n` : '';
          return `${header}\n${symbol}${hit.snippet.trim()}`;
        })
        .join('\n\n');
    },
  };
}
