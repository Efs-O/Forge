import { describe, expect, it } from 'vitest';
import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from '../../src/llm/types';
import { fingerprintRequest, requestPrefixRow } from '../../src/sessions/requestFingerprint';

const tool = (description: string): ToolDefinition => ({
  type: 'function',
  function: {
    name: 'read_file',
    description,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
});

const base: ChatMessage[] = [
  { role: 'system', content: 'SYSTEM-TEXT-secret-alpha' },
  { role: 'user', content: 'USER-TEXT-secret-beta' },
  { role: 'assistant', content: 'ASSISTANT-TEXT-secret-gamma' },
];

const request = (
  messages: ChatMessage[],
  extra: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest => ({
  model: 'm',
  stream: true,
  messages,
  tools: [tool('TOOL-DESCRIPTION-secret-delta')],
  ...extra,
});

describe('requestPrefixRow', () => {
  it('omits first_changed for a plain append and for the first request', () => {
    const one = fingerprintRequest(request(base));
    const two = fingerprintRequest(
      request([...base, { role: 'user', content: 'next' }], { max_tokens: 99 }),
    );
    expect(requestPrefixRow(undefined, one)).not.toHaveProperty('first_changed');
    const row = requestPrefixRow(one, two);
    expect(row).not.toHaveProperty('first_changed');
    expect(row['messages']).toBe(4);
    // max_tokens cannot reach the prompt, so it does not move params_hash.
    expect(row['params_hash']).toBe(one.paramsHash);
  });

  it('names the first changed message and its role', () => {
    const one = fingerprintRequest(request(base));
    const edited = [...base];
    edited[2] = { ...base[2]!, reasoning_content: 'kept thinking' };
    const row = requestPrefixRow(one, fingerprintRequest(request(edited)));
    expect(row['first_changed']).toBe(2);
    expect(row['changed_role']).toBe('assistant');
  });

  it('reports a shorter history as a change at the cut', () => {
    const one = fingerprintRequest(request(base));
    const row = requestPrefixRow(one, fingerprintRequest(request(base.slice(0, 2))));
    expect(row['first_changed']).toBe(2);
    expect(row['changed_role']).toBe('removed');
  });

  it('ignores sidebar-only message fields that never reach the wire', () => {
    const one = fingerprintRequest(request(base));
    const withUi = base.map((m) => ({ ...m, reasoning: 'sidebar only', internal: true }));
    expect(requestPrefixRow(one, fingerprintRequest(request(withUi)))).not.toHaveProperty(
      'first_changed',
    );
  });

  it('separates a tool description change, a system change and a kwarg change', () => {
    const one = fingerprintRequest(request(base));
    const tools = fingerprintRequest({ ...request(base), tools: [tool('reworded')] });
    expect(tools.toolsHash).not.toBe(one.toolsHash);
    expect(tools.systemHash).toBe(one.systemHash);

    const sys = [{ role: 'system' as const, content: 'other' }, ...base.slice(1)];
    const system = fingerprintRequest(request(sys));
    expect(system.systemHash).not.toBe(one.systemHash);
    expect(system.toolsHash).toBe(one.toolsHash);

    const kwargs = fingerprintRequest(
      request(base, { chat_template_kwargs: { preserve_thinking: true } }),
    );
    expect(kwargs.paramsHash).not.toBe(one.paramsHash);
  });

  it('carries no message or tool text', () => {
    const one = fingerprintRequest(request(base));
    const changed = [...base];
    changed[1] = { role: 'user', content: 'USER-TEXT-secret-epsilon' };
    const serialized = JSON.stringify(requestPrefixRow(one, fingerprintRequest(request(changed))));
    for (const secret of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'read_file']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
