import { describe, expect, it } from 'vitest';
import {
  AmbiguousModelError,
  availableProfilesFor,
  deriveStaticCapabilities,
  expandAlias,
  listProfiles,
  mergeGroupsIntoModel,
  resolveModelName,
  resolveRequestModel,
  resolveSpawnModel,
  splitModelProfile,
} from '../../src/config/ConfigResolver';
import type { ForgeConfig } from '../../src/config/types';

function baseConfig(): ForgeConfig {
  return {
    models: [
      {
        name: 'gemma4-26b-iq3s',
        provider: 'llama.cpp',
        gguf_path: '/models/gemma.gguf',
        mmproj_path: '/models/gemma-mmproj.gguf',
        num_ctx: 8192,
        spawn: {
          num_ctx: 32768,
          n_parallel: 4,
          type_k: 'q8_0',
          flash_attn: true,
        },
        spawn_profiles: {
          'long-context': { num_ctx: 131072, n_parallel: 1 },
        },
      },
    ],
    active_model: 'gemma4-26b-iq3s@main',
    defaults: {
      system_prompt: 'default prompt',
      sampling: { temperature: 0.6, top_p: 0.95 },
      think: false,
    },
    profiles: {
      main: { system_prompt: 'main prompt', think: true, reasoning_effort: 'medium' },
      worker: {
        think: false,
        reasoning_effort: 'none',
        sampling: { temperature: 0.2, stop: '<end_of_turn>' },
      },
    },
    aliases: {
      'gemma4-26b-a4b-it-iq3s-worker': 'gemma4-26b-iq3s@worker',
      'gemma4-26b-a4b-it-iq3s-coding': 'gemma4-26b-iq3s@main',
    },
    llama_server: { binary: 'llama-server' },
  };
}

describe('splitModelProfile', () => {
  it('splits a trailing @profile', () => {
    expect(splitModelProfile('gemma@worker')).toEqual({ base: 'gemma', profile: 'worker' });
  });
  it('returns bare base when no @profile', () => {
    expect(splitModelProfile('gemma')).toEqual({ base: 'gemma' });
  });
  it('leaves internal colon untouched', () => {
    expect(splitModelProfile('forge:gemma')).toEqual({ base: 'forge:gemma' });
  });
  it('splits @profile but keeps internal colon in base', () => {
    expect(splitModelProfile('forge:gemma@main')).toEqual({ base: 'forge:gemma', profile: 'main' });
  });
  it('does not split when @ is leading', () => {
    expect(splitModelProfile('@main')).toEqual({ base: '@main' });
  });
});

describe('expandAlias', () => {
  it('expands a known alias to its target', () => {
    const cfg = baseConfig();
    expect(expandAlias(cfg, 'gemma4-26b-a4b-it-iq3s-worker')).toBe('gemma4-26b-iq3s@worker');
  });
  it('passes through unknown ids unchanged', () => {
    const cfg = baseConfig();
    expect(expandAlias(cfg, 'gemma4-26b-iq3s@main')).toBe('gemma4-26b-iq3s@main');
  });
  it('lets an explicit @profile override the alias target profile', () => {
    const cfg = baseConfig();
    expect(expandAlias(cfg, 'gemma4-26b-a4b-it-iq3s-worker@main')).toBe('gemma4-26b-iq3s@main');
  });
  it('logs once-style message on hit', () => {
    const cfg = baseConfig();
    const msgs: string[] = [];
    expandAlias(cfg, 'gemma4-26b-a4b-it-iq3s-worker', (m) => msgs.push(m));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/alias/i);
  });
});

describe('resolveRequestModel', () => {
  it('applies precedence defaults < base < profile', () => {
    const cfg = baseConfig();
    const m = resolveRequestModel(cfg, 'gemma4-26b-iq3s@main');
    expect(m.system_prompt).toBe('main prompt'); // profile wins over defaults
    expect(m.think).toBe(true); // profile
    expect(m.reasoning_effort).toBe('medium'); // profile
    expect(m.sampling).toMatchObject({ temperature: 0.6, top_p: 0.95 }); // from defaults, no profile sampling
  });

  it('merges sampling across layers with profile winning per key', () => {
    const cfg = baseConfig();
    const m = resolveRequestModel(cfg, 'gemma4-26b-iq3s@worker');
    expect(m.sampling).toMatchObject({ temperature: 0.2, top_p: 0.95, stop: '<end_of_turn>' });
    expect(m.think).toBe(false);
    expect(m.reasoning_effort).toBe('none');
  });

  it('resolves through an alias', () => {
    const cfg = baseConfig();
    const m = resolveRequestModel(cfg, 'gemma4-26b-a4b-it-iq3s-worker');
    expect(m.name).toBe('gemma4-26b-iq3s');
    expect(m.reasoning_effort).toBe('none');
  });

  it('falls back to defaults-only when no profile given', () => {
    const cfg = baseConfig();
    const m = resolveRequestModel(cfg, 'gemma4-26b-iq3s');
    expect(m.system_prompt).toBe('default prompt');
    expect(m.think).toBe(false);
  });

  it('throws on unknown profile', () => {
    const cfg = baseConfig();
    expect(() => resolveRequestModel(cfg, 'gemma4-26b-iq3s@nope')).toThrow(/unknown profile/i);
  });

  it('throws on unknown base', () => {
    const cfg = baseConfig();
    expect(() => resolveRequestModel(cfg, 'missing@main')).toThrow(/unknown model/i);
  });
});

describe('resolveSpawnModel', () => {
  it('flattens the spawn block over legacy flat fields', () => {
    const cfg = baseConfig();
    const m = resolveSpawnModel(cfg, 'gemma4-26b-iq3s');
    expect(m.num_ctx).toBe(32768); // spawn beats flat 8192
    expect(m.n_parallel).toBe(4);
    expect(m.type_k).toBe('q8_0');
    expect(m.flash_attn).toBe(true);
  });

  it('applies a spawn profile over the spawn block', () => {
    const cfg = baseConfig();
    const m = resolveSpawnModel(cfg, 'gemma4-26b-iq3s', 'long-context');
    expect(m.num_ctx).toBe(131072);
    expect(m.n_parallel).toBe(1);
    expect(m.type_k).toBe('q8_0'); // inherited from spawn block
  });

  it('legacy-flat model with no spawn block reads its flat fields', () => {
    const cfg: ForgeConfig = {
      models: [
        {
          name: 'legacy',
          provider: 'llama.cpp',
          gguf_path: '/m.gguf',
          num_ctx: 4096,
          n_parallel: 2,
        },
      ],
      active_model: 'legacy',
      llama_server: { binary: 'llama-server' },
    };
    const m = resolveSpawnModel(cfg, 'legacy');
    expect(m.num_ctx).toBe(4096);
    expect(m.n_parallel).toBe(2);
  });

  it('throws on unknown spawn profile', () => {
    const cfg = baseConfig();
    expect(() => resolveSpawnModel(cfg, 'gemma4-26b-iq3s', 'nope')).toThrow(
      /unknown spawn profile/i,
    );
  });
});

describe('deriveStaticCapabilities', () => {
  it('derives vision from mmproj_path', () => {
    const cfg = baseConfig();
    expect(deriveStaticCapabilities(cfg.models[0])).toContain('vision');
  });
  it('derives long-context from a long-context spawn profile', () => {
    const cfg = baseConfig();
    expect(deriveStaticCapabilities(cfg.models[0])).toContain('long-context');
  });
  it('unions explicit capabilities (override wins)', () => {
    const m = { name: 'x', capabilities: ['tool-call' as const] };
    expect(deriveStaticCapabilities(m)).toEqual(['tool-call']);
  });
});

describe('profile listing', () => {
  it('lists all profile names', () => {
    const cfg = baseConfig();
    expect(listProfiles(cfg).sort()).toEqual(['main', 'worker']);
  });
  it('availableProfilesFor returns all profiles for a known base', () => {
    const cfg = baseConfig();
    expect(availableProfilesFor(cfg, 'gemma4-26b-iq3s').sort()).toEqual(['main', 'worker']);
  });
  it('availableProfilesFor throws for unknown base', () => {
    const cfg = baseConfig();
    expect(() => availableProfilesFor(cfg, 'nope')).toThrow(/unknown model/i);
  });
});

describe('groups ("boards") — F7', () => {
  /** Same effective model expressed two ways: via a shared `groups:` board,
   *  and fully flattened onto the model itself. Both must resolve identically. */
  function groupedConfig(): ForgeConfig {
    return {
      models: [
        {
          name: 'gemma4-26b-a4b-it-iq3s',
          provider: 'llama.cpp',
          gguf_path: '/models/gemma.gguf',
          groups: ['llamacpp-gemma', 'workers'],
          sampling: { temperature: 0.55 }, // model field wins over group per-key
        },
      ],
      active_model: 'gemma4-26b-a4b-it-iq3s',
      groups: {
        'llamacpp-gemma': {
          spawn: { n_batch: 512, flash_attn: true, type_k: 'q8_0' },
          sampling: { top_k: 64, temperature: 0.7, min_p: 0.0 },
          num_ctx: 32768,
        },
        workers: {
          think: false,
          tools: ['read_file', 'search_code'],
          tool_call_limits: { run_terminal: 0 },
          max_output_tokens: 8192,
        },
      },
      llama_server: { binary: 'llama-server' },
    };
  }

  function flattenedEquivalent(): ForgeConfig {
    return {
      models: [
        {
          name: 'gemma4-26b-a4b-it-iq3s',
          provider: 'llama.cpp',
          gguf_path: '/models/gemma.gguf',
          spawn: { n_batch: 512, flash_attn: true, type_k: 'q8_0' },
          sampling: { top_k: 64, temperature: 0.55, min_p: 0.0 },
          num_ctx: 32768,
          think: false,
          tools: ['read_file', 'search_code'],
          tool_call_limits: { run_terminal: 0 },
          max_output_tokens: 8192,
        },
      ],
      active_model: 'gemma4-26b-a4b-it-iq3s',
      llama_server: { binary: 'llama-server' },
    };
  }

  it('golden test: a groups-based config resolves identically to its flattened equivalent', () => {
    const grouped = resolveRequestModel(groupedConfig(), 'gemma4-26b-a4b-it-iq3s');
    const flat = resolveRequestModel(flattenedEquivalent(), 'gemma4-26b-a4b-it-iq3s');
    // Drop config-shape-only fields (group/groups) that have no flattened counterpart.
    const { group: _g, groups: _gs, ...groupedRest } = grouped as Record<string, unknown>;
    expect(groupedRest).toEqual(flat);
  });

  it('golden test: spawn-time resolution also matches (num_ctx/spawn merged via group)', () => {
    const grouped = resolveSpawnModel(groupedConfig(), 'gemma4-26b-a4b-it-iq3s');
    const flat = resolveSpawnModel(flattenedEquivalent(), 'gemma4-26b-a4b-it-iq3s');
    expect(grouped.num_ctx).toBe(flat.num_ctx);
    expect(grouped.spawn).toEqual(flat.spawn);
  });

  it('mergeGroupsIntoModel: precedence is defaults < group(s) < model fields', () => {
    const cfg = groupedConfig();
    const model = cfg.models[0];
    const merged = mergeGroupsIntoModel(cfg, model);
    expect(merged.sampling).toMatchObject({ top_k: 64, temperature: 0.55, min_p: 0.0 }); // model wins per-key
    expect(merged.spawn).toMatchObject({ n_batch: 512, flash_attn: true, type_k: 'q8_0' });
    expect(merged.num_ctx).toBe(32768);
    expect(merged.think).toBe(false); // from 'workers' group
    expect(merged.tools).toEqual(['read_file', 'search_code']);
    expect(merged.tool_call_limits).toEqual({ run_terminal: 0 });
    expect(merged.max_output_tokens).toBe(8192);
  });

  it('multiple groups merge in listed order — later group wins per key', () => {
    const cfg: ForgeConfig = {
      models: [{ name: 'm', provider: 'llama.cpp', gguf_path: '/m.gguf', groups: ['a', 'b'] }],
      active_model: 'm',
      groups: {
        a: { num_ctx: 8192, think: true },
        b: { num_ctx: 16384 },
      },
      llama_server: { binary: 'llama-server' },
    };
    const merged = mergeGroupsIntoModel(cfg, cfg.models[0]);
    expect(merged.num_ctx).toBe(16384); // b overrides a
    expect(merged.think).toBe(true); // only a sets it — survives
  });

  it('a config with no groups behaves byte-identically (no-op)', () => {
    const cfg = flattenedEquivalent();
    const merged = mergeGroupsIntoModel(cfg, cfg.models[0]);
    expect(merged).toBe(cfg.models[0]);
  });

  it('single `group:` shorthand resolves the same as a one-element `groups:` array', () => {
    const cfg: ForgeConfig = {
      models: [{ name: 'm', provider: 'llama.cpp', gguf_path: '/m.gguf', group: 'workers' }],
      active_model: 'm',
      groups: { workers: { think: false, num_ctx: 4096 } },
      llama_server: { binary: 'llama-server' },
    };
    const merged = mergeGroupsIntoModel(cfg, cfg.models[0]);
    expect(merged.think).toBe(false);
    expect(merged.num_ctx).toBe(4096);
  });
});

describe('resolveModelName — deterministic fuzzy resolution', () => {
  /** Fixture shaped like the real config: a quant-suffixed name AND a
   *  colon-tagged name both starting with "gemma4", so a bare "gemma4" query
   *  is genuinely ambiguous by prefix — exactly the real-world failure this
   *  resolver fixes ("use gemma4" previously matched nothing at all). */
  function realShapeConfig(withShortName: boolean): ForgeConfig {
    return {
      models: [
        {
          name: 'gemma4-26b-a4b-it-iq3s',
          provider: 'llama.cpp',
          gguf_path: '/m1.gguf',
          ...(withShortName ? { short_name: 'gemma4' } : {}),
        },
        { name: 'gemma4:26b', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
        { name: 'qwen3-30b-worker', provider: 'llama.cpp', gguf_path: '/m2.gguf' },
      ],
      active_model: 'gemma4-26b-a4b-it-iq3s',
      aliases: { 'qwen-worker': 'qwen3-30b-worker' },
      llama_server: { binary: 'llama-server' },
    };
  }

  it('resolves an exact name', () => {
    expect(resolveModelName(realShapeConfig(false), 'gemma4:26b')).toBe('gemma4:26b');
  });

  it('resolves an exact alias', () => {
    expect(resolveModelName(realShapeConfig(false), 'qwen-worker')).toBe('qwen3-30b-worker');
  });

  it('resolves an exact short_name', () => {
    expect(resolveModelName(realShapeConfig(true), 'gemma4')).toBe('gemma4-26b-a4b-it-iq3s');
  });

  it('resolves case-insensitive exact name', () => {
    expect(resolveModelName(realShapeConfig(false), 'QWEN3-30B-WORKER')).toBe('qwen3-30b-worker');
  });

  it('resolves a unique prefix match', () => {
    expect(resolveModelName(realShapeConfig(false), 'qwen3')).toBe('qwen3-30b-worker');
  });

  it('resolves a unique substring match', () => {
    expect(resolveModelName(realShapeConfig(false), '30b-worker')).toBe('qwen3-30b-worker');
  });

  it('"gemma4" is ambiguous when BOTH gemma4-26b-a4b-it-iq3s and gemma4:26b are present and neither has short_name', () => {
    expect(() => resolveModelName(realShapeConfig(false), 'gemma4')).toThrow(AmbiguousModelError);
    try {
      resolveModelName(realShapeConfig(false), 'gemma4');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousModelError);
      const ambiguous = err as AmbiguousModelError;
      expect(ambiguous.candidates.sort()).toEqual(['gemma4-26b-a4b-it-iq3s', 'gemma4:26b'].sort());
      expect(ambiguous.message).toMatch(
        /Ambiguous model "gemma4": matches gemma4-26b-a4b-it-iq3s, gemma4:26b/,
      );
    }
  });

  it('a short_name on one entry disambiguates "gemma4" unambiguously (exact short_name stage wins)', () => {
    expect(resolveModelName(realShapeConfig(true), 'gemma4')).toBe('gemma4-26b-a4b-it-iq3s');
  });

  it('throws a not-found error for a query matching nothing', () => {
    expect(() => resolveModelName(realShapeConfig(false), 'phi4')).toThrow(/unknown model "phi4"/i);
  });

  it('resolveRequestModel accepts a fuzzy base with @profile suffix', () => {
    const cfg = realShapeConfig(true);
    cfg.profiles = { worker: { think: false } };
    const m = resolveRequestModel(cfg, 'gemma4@worker');
    expect(m.name).toBe('gemma4-26b-a4b-it-iq3s');
    expect(m.think).toBe(false);
  });

  it('resolveRequestModel throws AmbiguousModelError (via findBase) for an ambiguous fuzzy base', () => {
    const cfg = realShapeConfig(false);
    expect(() => resolveRequestModel(cfg, 'gemma4')).toThrow(/Ambiguous model "gemma4"/);
  });
});
