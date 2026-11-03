import { describe, expect, it } from 'vitest';
import {
  mergeGroupsIntoModel,
  resolveModelEntry,
  resolveRequestModel,
} from '../../src/config/ConfigResolver';
import type { ForgeConfig } from '../../src/config/types';

/**
 * The engine fold. It lives in `mergeGroupsIntoModel` rather than in `findBase`
 * because four consumers flatten a model themselves (`ExternalModelServers`,
 * `ControlModelLifecycle`, `ModelStarterEnsure`, `ModelStarterPassThrough`) instead
 * of going through the resolver, and one implementation is the only way all of
 * them and `findBase` see the same fields. `ExecFieldReads.test.ts` fails if a
 * new consumer reads an exec field straight out of `config.models` instead.
 */
const CONFIG: ForgeConfig = {
  active_model: 'strata',
  llama_server: {},
  agent_links: {},
  groups: {
    'strata-8090': { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8081' },
  },
  engines: {
    'strata-8090': {
      start_command: ['python', 'N:/Strata/start_strata.py', '--config', 'x', 'solo'],
      stop_command: ['python', 'N:/Strata/stop_strata.py'],
      unload_path: '/unload',
      llama_server_binary: 'C:/Forge/llama-server.exe',
    },
  },
  models: [
    { name: 'strata', engine: 'strata-8090', group: 'strata-8090' },
    { name: 'own-voice', engine: 'strata-8090', group: 'strata-8090', unload_path: '/own_unload' },
    { name: 'dangling', engine: 'no-such-engine' },
    { name: 'plain', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
  ],
};

describe('the engine fold (phase 2)', () => {
  it('supplies every exec field the model does not declare itself', () => {
    const model = resolveModelEntry(CONFIG, 'strata');
    expect(model?.start_command).toEqual([
      'python',
      'N:/Strata/start_strata.py',
      '--config',
      'x',
      'solo',
    ]);
    expect(model?.stop_command).toEqual(['python', 'N:/Strata/stop_strata.py']);
    expect(model?.unload_path).toBe('/unload');
    expect(model?.llama_server_binary).toBe('C:/Forge/llama-server.exe');
    // The flat shape consumers already read: no engine pointer travels with it.
    expect(model?.engine).toBeUndefined();
  });

  it('leaves a model that names its own field in charge of that field', () => {
    // The phase-2 transition depends on this: a config.yaml that has not been
    // migrated still carries its own exec fields, and the engine must not
    // over-veto an owner's explicit choice.
    const model = resolveModelEntry(CONFIG, 'own-voice');
    expect(model?.unload_path).toBe('/own_unload');
    expect(model?.start_command).toEqual([
      'python',
      'N:/Strata/start_strata.py',
      '--config',
      'x',
      'solo',
    ]);
  });

  it('reports an unknown engine by model and engine name', () => {
    expect(() => resolveModelEntry(CONFIG, 'dangling')).toThrow(
      /model "dangling" names engine "no-such-engine"/,
    );
    expect(() => resolveModelEntry(CONFIG, 'dangling')).toThrow(/strata-8090/);
  });

  it('returns undefined for a name that is not configured, instead of throwing', () => {
    // The raw readers this function replaced returned undefined for a miss, and
    // every one of them has a message for that case; a throw here would turn a
    // model delete into an extension-host error.
    expect(resolveModelEntry(CONFIG, 'gone')).toBeUndefined();
  });

  it('folds groups and engines together, in the order the plan says', () => {
    // defaults < group(s) < model fields, engine < model fields: the group gives
    // `provider`/`endpoint`, the engine gives the launcher, and the model's own
    // `unload_path` still wins over both.
    const entry = CONFIG.models.find((model) => model.name === 'own-voice');
    const folded = entry ? mergeGroupsIntoModel(CONFIG, entry) : undefined;
    expect(folded?.provider).toBe('openai-compatible');
    expect(folded?.endpoint).toBe('http://127.0.0.1:8081');
    expect(folded?.unload_path).toBe('/own_unload');
    expect(folded?.start_command?.[4]).toBe('solo');
  });

  it('reaches the request-time resolver through the same fold', () => {
    const resolved = resolveRequestModel(CONFIG, 'strata');
    expect(resolved.unload_path).toBe('/unload');
    expect(resolved.stop_command).toEqual(['python', 'N:/Strata/stop_strata.py']);
    expect(resolved.provider).toBe('openai-compatible');
  });
});
