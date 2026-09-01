import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CliAgentSession } from '../../src/agents/CliAgentSession';
import {
  CliSessionCapacityError,
  CliSessionRegistry,
} from '../../src/agents/CliSessionRegistry';

const fixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');
const options = {
  executable: process.execPath,
  argsPrefix: [fixture],
  cwd: process.cwd(),
};

describe('CliSessionRegistry', () => {
  it('isolates conversation/model pairs and evicts the LRU idle session', async () => {
    const created: CliAgentSession[] = [];
    const registry = new CliSessionRegistry(2, 60_000, (value) => {
      const session = new CliAgentSession(value);
      created.push(session);
      return session;
    });
    await registry.run({ conversationId: 'a', modelName: 'm' }, options, 'WARM_TURN a');
    await registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b');
    await registry.run({ conversationId: 'c', modelName: 'm' }, options, 'WARM_TURN c');
    expect(created).toHaveLength(3);
    expect(created[0]!.state).toBe('disposed');
    expect(created[1]!.state).toBe('idle');
    await registry.dispose();
  });

  it('never evicts a busy session when capacity is full', async () => {
    const registry = new CliSessionRegistry(1, 60_000);
    const controller = new AbortController();
    const busy = registry.run(
      { conversationId: 'a', modelName: 'm' },
      options,
      'TRIGGER_SLOW',
      { signal: controller.signal },
    );
    await expect(
      registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b'),
    ).rejects.toBeInstanceOf(CliSessionCapacityError);
    controller.abort();
    await busy;
    await registry.dispose();
  });

  it('disposes idle sessions on timeout and awaits conversation cleanup', async () => {
    const created: CliAgentSession[] = [];
    const registry = new CliSessionRegistry(2, 20, (value) => {
      const session = new CliAgentSession(value);
      created.push(session);
      return session;
    });
    await registry.run({ conversationId: 'a', modelName: 'm' }, options, 'WARM_TURN a');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created[0]!.state).toBe('disposed');
    await registry.run({ conversationId: 'b', modelName: 'm' }, options, 'WARM_TURN b');
    await registry.disposeConversation('b');
    expect(created[1]!.state).toBe('disposed');
  });
});
