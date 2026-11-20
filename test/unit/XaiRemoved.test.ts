import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ForgeConfigSchema } from '../../src/config/schema';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import { XAI_REMOVED_MESSAGE } from '../../src/config/schemaShared';

const MESSAGE =
  'provider "xai" was removed in Forge 0.17.207. To keep using Grok, set provider: openai-compatible, endpoint: https://api.x.ai/v1 and api_key_secret (store the key with "Forge: Set Cloud Provider Token"), or delete the entry.';

function configWithModel(provider: string) {
  return ForgeConfigSchema.safeParse({
    active_model: 'm',
    models: [{ name: 'm', provider, endpoint: 'https://api.x.ai/v1' }],
  });
}

function configWithGroup(provider: string) {
  return ForgeConfigSchema.safeParse({
    active_model: 'm',
    models: [{ name: 'm', group: 'g' }],
    groups: { g: { provider } },
  });
}

function configWithBackend(provider: string) {
  return ForgeConfigSchema.safeParse({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    image_generation: { backends: [{ name: 'b', provider, model: 'img' }] },
  });
}

function imageBackend(provider: string) {
  return ImageGenerationConfigSchema.safeParse({
    backends: [{ name: 'b', provider, model: 'img' }],
  });
}

function issuesFor(result: { success: false; error: { issues: unknown[] } }, path: string[]) {
  return (result.error.issues as { path: (string | number)[]; message: string }[]).filter(
    (issue) => issue.path.join('.') === path.join('.'),
  );
}

describe('the removed xai provider', () => {
  it('names the openai-compatible replacement, exactly', () => {
    expect(XAI_REMOVED_MESSAGE).toBe(MESSAGE);
  });

  it('refuses a model with provider: xai', () => {
    const result = configWithModel('xai');
    expect(result.success).toBe(false);
    const issues = issuesFor(result as never, ['models', 0, 'provider']);
    expect(issues.map((issue) => issue.message)).toEqual([MESSAGE]);
  });

  it('refuses a group with provider: xai', () => {
    const result = configWithGroup('xai');
    expect(result.success).toBe(false);
    const issues = issuesFor(result as never, ['groups', 'g', 'provider']);
    expect(issues.map((issue) => issue.message)).toEqual([MESSAGE]);
  });

  it('refuses an image backend with provider: xai', () => {
    const result = imageBackend('xai');
    expect(result.success).toBe(false);
    const issues = issuesFor(result as never, ['backends', 0, 'provider']);
    expect(issues.map((issue) => issue.message)).toEqual([MESSAGE]);
  });

  it('refuses it through the whole config too', () => {
    const result = configWithBackend('xai');
    expect(result.success).toBe(false);
    const issues = issuesFor(result as never, ['image_generation', 'backends', 0, 'provider']);
    expect(issues.map((issue) => issue.message)).toEqual([MESSAGE]);
  });

  it('keeps zod\'s own message for any other unknown provider', () => {
    const result = configWithModel('grok');
    expect(result.success).toBe(false);
    const issues = issuesFor(result as never, ['models', 0, 'provider']);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).not.toBe(XAI_REMOVED_MESSAGE);
  });

  it('still accepts every remaining provider', () => {
    expect(
      ForgeConfigSchema.safeParse({
        active_model: 'm',
        models: [
          {
            name: 'm',
            provider: 'openrouter',
            api_key_secret: 'forge.openrouter',
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('Forge no longer reads another app\u2019s credentials', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..');
  const SOURCES = ['src', path.join('webview-ui', 'src')];

  function sourceFiles(dir: string): string[] {
    return fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath ?? dir, entry.name));
  }

  it('has no XaiAuth module and no source names it or OpenCode\u2019s auth file', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'llm', 'XaiAuth.ts'))).toBe(false);
    const files = SOURCES.flatMap((dir) => sourceFiles(path.join(REPO_ROOT, dir)));
    // A walk that found nothing would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
    const offenders = files
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return /xaiauth/i.test(text) || /opencode auth/i.test(text);
      })
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
