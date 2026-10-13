/**
 * `set_checkin` — the tool half of the elapsed-time note: its argument bounds,
 * its result string, its refusal when no clock is wired, and the config block
 * that advertises it.
 */

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  MAX_CHECKIN_MINUTES,
  MIN_CHECKIN_MINUTES,
  SET_CHECKIN_UNAVAILABLE,
  makeSetCheckinTool,
} from '../../src/tools/setCheckinTool';

const tool = makeSetCheckinTool({ getConfig: () => ({ elapsed_time_note: { after_minutes: 30 } }) as ForgeConfig });

describe('set_checkin arguments', () => {
  const call = (args: Record<string, unknown>) => tool.handler(args, {
    beforeMutate: () => undefined,
    setCheckin: (minutes) => ({ dueAt: minutes * 60_000 }),
  });

  it('rejects minutes below the floor, above the ceiling, and fractional', async () => {
    for (const minutes of [MIN_CHECKIN_MINUTES - 1, MAX_CHECKIN_MINUTES + 1, 12.5]) {
      const result = await call({ minutes, by_then: 'writing' });
      expect(String(result), `${minutes}`).toContain('set_checkin rejected');
    }
  });

  it('rejects a by_then outside the enum and any extra field', async () => {
    expect(String(await call({ minutes: 30, by_then: 'sleeping' }))).toContain('rejected');
    expect(String(await call({ minutes: 30 }))).toContain('rejected');
    expect(String(await call({ minutes: 30, by_then: 'done', note: 'x' }))).toContain('rejected');
  });

  it('the registry pre-check refuses a call missing a required field', () => {
    // `invalidArgs` gates required fields and wrong-shaped types before the
    // handler runs; numeric bounds and enums are the handler's own zod check,
    // which is why both halves are pinned here.
    const registry = new ToolRegistry();
    registry.register(tool);
    const registered = registry.get('set_checkin')!;
    expect(registry.invalidArgs(registered, { minutes: 30 })).toContain('missing required argument');
    expect(registry.invalidArgs(registered, { minutes: 30, by_then: 'testing' })).toBeUndefined();
  });

  it('accepts the bounds and reports the estimate, the clock time and the stage', async () => {
    const result = String(await call({ minutes: 45, by_then: 'testing' }));
    expect(result).toContain('Check-in set');
    expect(result).toContain('in 45 min');
    expect(result).toMatch(/\(at \d{2}:\d{2}\)/);
    expect(result).toContain('running tests');
    expect(result).toContain('Call set_checkin again to change it.');
  });

  it('refuses when the turn has no clock wired', async () => {
    await expect(
      tool.handler({ minutes: 30, by_then: 'writing' }, { beforeMutate: () => undefined }),
    ).rejects.toThrow(SET_CHECKIN_UNAVAILABLE);
    await expect(tool.handler({ minutes: 30, by_then: 'writing' })).rejects.toThrow(
      SET_CHECKIN_UNAVAILABLE,
    );
  });

  it('is read-permission and reaches the clock only through the context callback', () => {
    expect(tool.permission).toBe('read');
    const seen: [number, string][] = [];
    void tool.handler(
      { minutes: 20, by_then: 'done' },
      {
        beforeMutate: () => undefined,
        setCheckin: (minutes, byThen) => {
          seen.push([minutes, byThen]);
          return { dueAt: minutes * 60_000 };
        },
      },
    );
    expect(seen).toEqual([[20, 'done']]);
  });
});

describe('set_checkin registration follows the config block', () => {
  function registryWith(config: ForgeConfig): ToolRegistry {
    const registry = new ToolRegistry();
    registerAllTools(
      registry,
      { get: () => undefined, update: async () => undefined } as unknown as vscode.Memento,
      { get: async () => undefined } as unknown as vscode.SecretStorage,
      { provider: 'tavily', secret_key_name: 'audit-key' },
      { search: async () => [] } as unknown as IndexManager,
      new UserQuestionService(),
      new UserNotificationService(),
      undefined,
      () => config,
    );
    return registry;
  }

  const base = (extra: Partial<ForgeConfig>): ForgeConfig =>
    ({
      active_model: 'primary',
      llama_server: {},
      models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
      ...extra,
    }) as ForgeConfig;

  it('always registers the tool, advertised only while the block is present', () => {
    const without = registryWith(base({}));
    expect(without.get('set_checkin')?.advertise?.()).toBe(false);
    const withBlock = registryWith(base({ elapsed_time_note: { after_minutes: 30 } }));
    expect(withBlock.get('set_checkin')?.advertise?.()).toBe(true);
    // The block changes advertisement only, never the registered set.
    expect(withBlock.names().sort()).toEqual(without.names().sort());
  });

  it('shows the tool when the block is added to a live config, no window reload', () => {
    let config = base({});
    const registry = new ToolRegistry();
    registry.register(makeSetCheckinTool({ getConfig: () => config }));
    expect(registry.get('set_checkin')?.advertise?.()).toBe(false);
    config = base({ elapsed_time_note: { after_minutes: 30 } });
    expect(registry.get('set_checkin')?.advertise?.()).toBe(true);
  });

  it('refuses a call that arrives after the block was removed', async () => {
    const off = makeSetCheckinTool({ getConfig: () => base({}) });
    let set = false;
    const result = await off.handler({ minutes: 30, by_then: 'writing' }, {
      beforeMutate: () => undefined,
      setCheckin: () => ((set = true), { dueAt: 0 }),
    });
    expect(String(result)).toContain('set_checkin is off');
    expect(set).toBe(false);
  });

  it('hides the tool again when the block is removed from a live config', () => {
    let config = base({ elapsed_time_note: { after_minutes: 30 } });
    const registry = new ToolRegistry();
    registry.register(makeSetCheckinTool({ getConfig: () => config }));
    expect(registry.get('set_checkin')?.advertise?.()).toBe(true);
    config = base({});
    expect(registry.get('set_checkin')?.advertise?.()).toBe(false);
  });
});
