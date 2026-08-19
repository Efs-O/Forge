import { describe, expect, it } from 'vitest';
import { groupModels } from '../../webview-ui/src/modelGroups';

describe('groupModels', () => {
  it('uses host categories and alphabetizes each category', () => {
    expect(
      groupModels([
        { name: 'zeta-local', provider: 'ollama', group: 'Local — Ollama' },
        { name: 'alpha-local', provider: 'ollama', group: 'Local — Ollama' },
        { name: 'gpt-5', provider: 'openai', group: 'OpenAI' },
        { name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' },
        { name: 'cerebras-fast', provider: 'openai-compatible', group: 'Cerebras' },
        { name: 'codex', provider: 'cli', group: 'CLI agents' },
      ]),
    ).toEqual([
      {
        label: 'Local — Ollama',
        entries: [
          { name: 'alpha-local', provider: 'ollama', group: 'Local — Ollama' },
          { name: 'zeta-local', provider: 'ollama', group: 'Local — Ollama' },
        ],
      },
      { label: 'Ollama Cloud', entries: [{ name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' }] },
      { label: 'Cerebras', entries: [{ name: 'cerebras-fast', provider: 'openai-compatible', group: 'Cerebras' }] },
      { label: 'OpenAI', entries: [{ name: 'gpt-5', provider: 'openai', group: 'OpenAI' }] },
      { label: 'CLI agents', entries: [{ name: 'codex', provider: 'cli', group: 'CLI agents' }] },
    ]);
  });
});
