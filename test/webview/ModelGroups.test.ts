import { describe, expect, it } from 'vitest';
import { groupModels } from '../../webview-ui/src/modelGroups';

describe('groupModels', () => {
  it('uses host categories and preserves input order within each category', () => {
    expect(
      groupModels([
        { name: 'zeta-local', provider: 'ollama', group: 'Ollama Local' },
        { name: 'alpha-local', provider: 'ollama', group: 'Ollama Local' },
        { name: 'gpt-5', provider: 'openai', group: 'OpenAI' },
        { name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' },
        { name: 'cerebras-fast', provider: 'openai-compatible', group: 'Cerebras' },
        { name: 'codex', provider: 'cli', group: 'CLI agents' },
      ]),
    ).toEqual([
      {
        label: 'Ollama Local',
        entries: [
          { name: 'zeta-local', provider: 'ollama', group: 'Ollama Local' },
          { name: 'alpha-local', provider: 'ollama', group: 'Ollama Local' },
        ],
      },
      { label: 'Ollama Cloud', entries: [{ name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' }] },
      { label: 'Cerebras', entries: [{ name: 'cerebras-fast', provider: 'openai-compatible', group: 'Cerebras' }] },
      { label: 'OpenAI', entries: [{ name: 'gpt-5', provider: 'openai', group: 'OpenAI' }] },
      { label: 'CLI agents', entries: [{ name: 'codex', provider: 'cli', group: 'CLI agents' }] },
    ]);
  });

  it('shows the Desktop group between Ollama Cloud and OpenRouter', () => {
    // The host sends `group` for every model, so a `remote_start` entry arrives
    // as 'Desktop' and the sidebar orders it by MODEL_PICKER_GROUP_ORDER —
    // which the webview imports, so it cannot fall out of step with the host.
    const desktopModel = {
      name: 'strata-flashnext-iq3_s',
      provider: 'openai-compatible',
      group: 'Desktop',
    };
    expect(
      groupModels([
        { name: 'grok', provider: 'openrouter', group: 'OpenRouter' },
        desktopModel,
        { name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' },
      ]),
    ).toEqual([
      { label: 'Ollama Cloud', entries: [{ name: 'qwen:cloud', provider: 'ollama', group: 'Ollama Cloud' }] },
      { label: 'Desktop', entries: [desktopModel] },
      { label: 'OpenRouter', entries: [{ name: 'grok', provider: 'openrouter', group: 'OpenRouter' }] },
    ]);
  });
});
