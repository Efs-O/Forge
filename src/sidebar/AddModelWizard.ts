import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GgufCandidate } from '../backend/GgufScanner';
import { deriveModelSuggestion } from '../backend/ModelHeuristics';
import { writeConfigSafely } from '../config/ConfigWriter';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { fetchOllamaModels } from './FirstRunWizard';

/** Adds only new model names while preserving every other config field. */
export function mergeAddedModels(config: ForgeConfig, additions: ModelConfig[]): ForgeConfig {
  const existing = new Set(config.models.map((model) => model.name));
  const unique = additions.filter((model) => !existing.has(model.name));
  return unique.length === 0 ? config : { ...config, models: [...config.models, ...unique] };
}

/** Add discovered models to an existing config after preview/confirmation. */
export async function runAddModelWizard(
  config: ForgeConfig,
  configPath: string,
): Promise<ForgeConfig | null> {
  const backend = await vscode.window.showQuickPick(['llama.cpp', 'Ollama'], {
    title: 'Forge: Add Models',
    placeHolder: 'Select a backend',
  });
  if (!backend) return null;

  const additions = backend === 'llama.cpp' ? await pickGgufModels() : await pickOllamaModels();
  if (!additions.length) return null;

  const next = mergeAddedModels(config, additions);
  const unique = next.models.slice(config.models.length);
  if (!unique.length) {
    void vscode.window.showInformationMessage('Forge: all selected models already exist.');
    return null;
  }
  const choice = await vscode.window.showInformationMessage(
    `Forge will add: ${unique.map((model) => model.name).join(', ')}. A config.yaml.bak backup will be created.`,
    { modal: true },
    'Add models',
  );
  if (choice !== 'Add models') return null;
  writeConfigSafely(configPath, next);
  return next;
}

async function pickGgufModels(): Promise<ModelConfig[]> {
  const files = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    filters: { 'GGUF models': ['gguf'] },
    title: 'Select GGUF models to add',
  });
  return (files ?? []).map((uri) => {
    const candidate: GgufCandidate = {
      ggufPath: uri.fsPath,
      modelName: path.basename(uri.fsPath, '.gguf'),
      sizeBytes: fs.statSync(uri.fsPath).size,
      familyHint: 'unknown',
    };
    const suggestion = deriveModelSuggestion(candidate);
    return {
      name: suggestion.suggestedName,
      provider: 'llama.cpp',
      gguf_path: uri.fsPath,
      spawn: {
        num_ctx: suggestion.numCtx,
        n_batch: suggestion.nBatch,
        flash_attn: suggestion.flashAttn,
      },
    };
  });
}

async function pickOllamaModels(): Promise<ModelConfig[]> {
  const endpoint = await vscode.window.showInputBox({
    value: 'http://127.0.0.1:11434',
    prompt: 'Ollama endpoint',
  });
  if (!endpoint) return [];
  const names = await fetchOllamaModels(endpoint);
  const picked = await vscode.window.showQuickPick(
    names.map((name) => ({ label: name })),
    { canPickMany: true, title: 'Select Ollama models to add' },
  );
  return (picked ?? []).map(({ label }) => ({
    name: label,
    provider: 'ollama',
    endpoint,
    num_ctx: 32768,
  }));
}
