/**
 * The fallback wizard's one model pick, checked as data: the order the user
 * sees models in, and that a source which found nothing still leaves the two
 * hand-written ways in. Everything else in `FirstRunWizard.ts` is VS Code UI,
 * so it is not driven here.
 */
import { describe, expect, it } from 'vitest';
import { modelPickItems } from '../../src/sidebar/FirstRunWizard';
import type { GgufCandidate } from '../../src/backend/GgufScanner';

const gguf = (modelName: string, sizeBytes: number): GgufCandidate => ({
  ggufPath: `C:/models/${modelName}.gguf`,
  modelName,
  sizeBytes,
  familyHint: 'unknown',
});

describe('modelPickItems', () => {
  it('lists every GGUF, then every Ollama tag, then the two hand-written ways in', () => {
    const items = modelPickItems([gguf('alpha', 12e9), gguf('beta', 8e9)], ['gemma4:e4b']);
    expect(items.map((item) => item.label)).toEqual([
      'alpha',
      'beta',
      'gemma4:e4b',
      'Browse for a GGUF file…',
      'Type an Ollama model name…',
    ]);
    expect(items.map((item) => item.description)).toEqual([
      '12.0 GB · llama.cpp · unknown',
      '8.0 GB · llama.cpp · unknown',
      'Ollama',
      'llama.cpp',
      'Ollama',
    ]);
    expect(items.map((item) => item.pick.kind)).toEqual([
      'gguf',
      'gguf',
      'ollama',
      'browse-gguf',
      'type-ollama',
    ]);
  });

  it('offers exactly the two hand-written ways when nothing was found', () => {
    expect(modelPickItems([], [])).toEqual([
      {
        label: 'Browse for a GGUF file…',
        description: 'llama.cpp',
        pick: { kind: 'browse-gguf' },
      },
      {
        label: 'Type an Ollama model name…',
        description: 'Ollama',
        pick: { kind: 'type-ollama' },
      },
    ]);
  });

  it('caps the GGUF list at ten and keeps the two ways in', () => {
    const twelve = Array.from({ length: 12 }, (_, index) =>
      gguf(`model${index}`, 1_000_000_000 * (12 - index)),
    );
    const items = modelPickItems(twelve, []);
    expect(items.filter((item) => item.pick.kind === 'gguf')).toHaveLength(10);
    expect(items).toHaveLength(12);
  });
});
