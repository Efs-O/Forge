import * as path from 'path';
import type { GgufCandidate } from './GgufScanner';

export type ModelFamily = 'qwen3' | 'gemma4' | 'llama' | 'mistral' | 'phi' | 'unknown';

export interface ModelSuggestion {
  family: ModelFamily;
  suggestedName: string;
  numCtx: number;
  nBatch: number;
  flashAttn: boolean;
  temperature: number;
  topP: number;
  topK: number;
}

export function detectFamily(filename: string): ModelFamily {
  const lower = filename.toLowerCase();
  if (lower.includes('qwen3') || lower.includes('qwen3.')) return 'qwen3';
  if (lower.includes('gemma-4') || lower.includes('gemma4')) return 'gemma4';
  if (lower.includes('llama-3') || lower.includes('llama3')) return 'llama';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('phi-3') || lower.includes('phi-4') || lower.includes('phi3') || lower.includes('phi4')) return 'phi';
  return 'unknown';
}

export function deriveModelSuggestion(candidate: GgufCandidate): ModelSuggestion {
  const family = detectFamily(candidate.ggufPath);
  const base = path.basename(candidate.ggufPath, '.gguf');
  const suggestedName = base.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase().slice(0, 40);

  const defaults: ModelSuggestion = {
    family,
    suggestedName,
    numCtx: 32768,
    nBatch: 512,
    flashAttn: true,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
  };

  if (family === 'qwen3') {
    return { ...defaults, numCtx: 98304, nBatch: 1024, temperature: 0.6, topP: 0.95, topK: 20 };
  }
  if (family === 'gemma4') {
    return { ...defaults, numCtx: 98304, nBatch: 512, temperature: 0.6, topP: 0.95, topK: 64 };
  }
  if (family === 'llama') {
    return { ...defaults, numCtx: 32768, nBatch: 512 };
  }
  return defaults;
}
