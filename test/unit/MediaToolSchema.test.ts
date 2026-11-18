/**
 * Phase 3 acceptance: "`generate_video` / `generate_music` have strict schemas
 * with no blob arg, run in the background, take and always release the lease
 * ..., and unload only overlapping entries through `unloadModel`"
 * (docs/plans/MEDIA_SHIPPED_PLAN.md, Acceptance criteria), and "`media.enabled:
 * false` (default) registers no media tool".
 *
 * The schema half is asserted here: every argument is a named, bounded scalar;
 * nothing accepts a free-form object; and the tools appear only while a config
 * turns media on.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { IndexManager } from '../../src/search/IndexManager';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { lazyGroupForTool, resetLazyToolGroups } from '../../src/tools/lazyToolGroups';
import { makeGenerateMusicTool } from '../../src/tools/media/generateMusicTool';
import { makeGenerateVideoTool } from '../../src/tools/media/generateVideoTool';
import { defaultVideoEngineMessage, resolveVideoEngine } from '../../src/tools/media/mediaEngineSetup';
import type { MediaToolDeps } from '../../src/tools/media/mediaToolDeps';
import { MediaConfigSchema } from '../../src/config/mediaSchema';

const DEPS: MediaToolDeps = {
  getConfig: () => ({
    active_model: 'primary',
    llama_server: { binary: 'llama-server' },
    models: [{ name: 'primary', gguf_path: '/p.gguf' }],
    media: { enabled: true, output_dir: 'media' },
  }),
  adaptersDir: '/ext/resources/media',
  lifecycle: {
    loadedModels: () => [],
    isBusy: () => false,
    unloadModel: async () => ({ unloaded: true }),
  },
};

function parametersOf(name: string): Record<string, unknown> {
  const tool =
    name === 'generate_video' ? makeGenerateVideoTool(DEPS) : makeGenerateMusicTool(DEPS);
  return tool.definition.function.parameters;
}

describe('media tool schemas: strict, structured, no blob argument', () => {
  it('generate_video declares only bounded scalars and requires the prompt', () => {
    const schema = parametersOf('generate_video');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['prompt']);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual([
      'engine',
      'fps',
      'height',
      'image_path',
      'prompt',
      'seconds',
      'seed',
      'width',
    ]);
    expect(properties.prompt.type).toBe('string');
    expect(properties.prompt.maxLength).toBe(2_000);
    for (const [name, spec] of Object.entries(properties)) {
      expect(['object', 'array'], `${name} is a blob`).not.toContain(spec.type);
    }
  });

  it('generate_music requires the lyrics mode, bounds the caption, and refuses a blob', () => {
    const schema = parametersOf('generate_music');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['lyrics']);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual([
      'analyze',
      'engine',
      'lyrics',
      'lyrics_path',
      'replicate',
      'seconds',
      'seed',
      'source_audio_path',
      'style',
    ]);
    expect(properties.lyrics.enum).toEqual(['user', 'agent', 'analysis', 'none']);
    expect(properties.style.maxLength).toBe(2_000);
    for (const [name, spec] of Object.entries(properties)) {
      expect(['object', 'array'], `${name} is a blob`).not.toContain(spec.type);
    }
    // Lyric text is a path, never an inline blob.
    expect(properties.lyrics_path.type).toBe('string');
    expect(Object.keys(properties)).not.toContain('lyrics_text');
  });

  it('offers only the configured engine ids when a conversation reads the schema', () => {
    const tool = makeGenerateMusicTool(DEPS);
    const described = tool.describe!();
    const properties = described.function.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.engine.enum).toBeUndefined();
    const withEngines = makeGenerateMusicTool({
      ...DEPS,
      getConfig: () => ({
        ...DEPS.getConfig(),
        media: {
          ...DEPS.getConfig().media,
          music: { engines: [{ id: 'ace_step', kind: 'ace_standalone' }] },
        },
      }),
    });
    const describedWith = withEngines.describe!();
    const engineSpec = (describedWith.function.parameters.properties as Record<
      string,
      Record<string, unknown>
    >).engine;
    expect(engineSpec.enum).toEqual(['ace_step']);
  });

  it('registers both tools only while media.enabled is true', () => {
    const registry = registryFor({ enabled: true, output_dir: 'media' });
    expect(registry.names()).toContain('generate_video');
    expect(registry.names()).toContain('generate_music');
    const off = registryFor({ enabled: false, output_dir: 'media' });
    expect(off.names()).not.toContain('generate_video');
    expect(off.names()).not.toContain('generate_music');
    const absent = registryFor(undefined);
    expect(absent.names()).not.toContain('generate_music');
  });

  it('members the media lazy group, so a coding turn never pays their schemas', () => {
    resetLazyToolGroups();
    registryFor({ enabled: true, output_dir: 'media' });
    expect(lazyGroupForTool('generate_video')).toBe('media');
    expect(lazyGroupForTool('generate_music')).toBe('media');
    resetLazyToolGroups();
  });

  it('defaults to LTX even when H3 is listed first, and requires an explicit H3 id', () => {
    const both = MediaConfigSchema.parse({
      enabled: true,
      video: {
        engines: [
          { id: 'h3', kind: 'comfyui_workflow', workflow: 'h3.json' },
          { id: 'ltx25', kind: 'ltx25' },
        ],
      },
    });
    expect(resolveVideoEngine(both)?.id).toBe('ltx25');
    const h3Only = MediaConfigSchema.parse({
      enabled: true,
      video: { engines: [{ id: 'h3', kind: 'comfyui_workflow', workflow: 'h3.json' }] },
    });
    expect(resolveVideoEngine(h3Only)).toBeUndefined();
    expect(resolveVideoEngine(h3Only, 'h3')?.id).toBe('h3');
    expect(defaultVideoEngineMessage(h3Only, 'generate_video')).toContain('engine: "h3"');
  });
});

function configWith(media: Record<string, unknown> | undefined): ForgeConfig {
  return {
    active_model: 'primary',
    llama_server: { binary: 'llama-server' },
    models: [{ name: 'primary', gguf_path: '/p.gguf' }],
    ...(media ? { media } : {}),
  } as ForgeConfig;
}

function registryFor(media: Record<string, unknown> | undefined): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = { get: () => undefined, update: async () => undefined } as unknown as vscode.Memento;
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  const indexManager = {
    search: async () => [],
    isEnabled: () => true,
  } as unknown as IndexManager;
  registerAllTools(
    registry,
    workspaceState,
    secrets,
    undefined,
    indexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    undefined,
    () => configWith(media),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { adaptersDir: '/ext/resources/media', lifecycle: DEPS.lifecycle },
  );
  return registry;
}
