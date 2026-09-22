import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { scanForGgufs } from '../backend/GgufScanner';
import { deriveModelSuggestion } from '../backend/ModelHeuristics';
import {
  makeLlamaCppStarterConfig,
  makeOllamaStarterConfig,
  withCliAgents,
  type FoundCliAgents,
} from '../config/StarterConfig';
import { writeConfigSafely } from '../config/ConfigWriter';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { GgufCandidate } from '../backend/GgufScanner';
import type { ForgeConfig } from '../config/types';

/** True when the CLI resolves on PATH. A miss is an answer here, not an error:
 *  the wizard only decides whether to add the entry. */
async function onPath(name: 'claude' | 'codex'): Promise<boolean> {
  return resolveCliExecutable(name, name).then(
    () => true,
    () => false,
  );
}

async function findCliAgents(): Promise<FoundCliAgents> {
  const [claude, codex] = await Promise.all([onPath('claude'), onPath('codex')]);
  return { claude, codex };
}

/** One line for the reload toast: what was added, or how to add it later. */
function describeCliAgents(found: FoundCliAgents): string {
  const added = [found.claude && 'Claude Code', found.codex && 'Codex'].filter(Boolean);
  if (added.length) {
    return ` Added ${added.join(' and ')} (found on PATH) — log in to each CLI yourself; Forge holds no keys.`;
  }
  return (
    ' Claude Code / Codex were not found on PATH — install and log in, then add ' +
    '`{ name: claude-code, provider: cli, cli: claude }` to models (same for codex).'
  );
}

/** Adds the CLI agents on PATH, writes the config, and finishes the wizard. */
async function writeStarterConfig(
  context: vscode.ExtensionContext,
  target: ConfigTarget,
  config: ForgeConfig,
): Promise<void> {
  const found = await findCliAgents();
  writeConfigSafely(target.path, withCliAgents(config, found));
  await finishWizard(context, target.path, target.isGlobal, describeCliAgents(found));
}

async function promptGlobalPin(configPath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Forge: Pin this config as the global config for all workspaces? (Sets forge.configFile in user settings)`,
    'Pin globally',
    'Skip',
  );
  if (choice === 'Pin globally') {
    await vscode.workspace
      .getConfiguration('forge')
      .update('configFile', configPath, vscode.ConfigurationTarget.Global);
  }
}

async function promptReload(configPath: string, note: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `Forge: config.yaml written to ${configPath}.${note} Reload window to start.`,
    'Reload',
  );
  if (choice === 'Reload') {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
    return true;
  }
  return false;
}

async function finishWizard(
  context: vscode.ExtensionContext,
  configPath: string,
  offerGlobalPin: boolean,
  note: string,
): Promise<void> {
  await context.globalState.update('forge.firstRun.shown', true);
  if (offerGlobalPin) await promptGlobalPin(configPath);
  await promptReload(configPath, note);
}

interface ConfigTarget {
  path: string;
  isGlobal: boolean;
}

async function chooseConfigTarget(
  context: vscode.ExtensionContext,
): Promise<ConfigTarget | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const choices = [
    {
      label: 'Global Forge storage',
      description: context.globalStorageUri.fsPath,
      configDir: context.globalStorageUri.fsPath,
      isGlobal: true,
    },
    ...(workspace
      ? [
          {
            label: 'Current workspace',
            description: path.join(workspace, '.forge'),
            configDir: path.join(workspace, '.forge'),
            isGlobal: false,
          },
        ]
      : []),
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Forge: Where should config.yaml be saved?',
    placeHolder: 'Choose global storage or the current workspace',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  const configPath = path.join(picked.configDir, 'config.yaml');
  if (!fs.existsSync(configPath)) return { path: configPath, isGlobal: picked.isGlobal };
  const replace = await vscode.window.showWarningMessage(
    `Forge: ${configPath} already exists. Replace it? A .bak backup will be created.`,
    { modal: true },
    'Replace config',
  );
  return replace === 'Replace config' ? { path: configPath, isGlobal: picked.isGlobal } : undefined;
}

// ── llama.cpp flow ────────────────────────────────────────────────────────────

async function runLlamaCppFlow(context: vscode.ExtensionContext): Promise<boolean> {
  const scan = await vscode.window.showInformationMessage(
    'Forge: Scan for GGUF model files?',
    { modal: false },
    'Scan',
    'Skip',
  );

  let candidates: GgufCandidate[] = [];
  if (scan === 'Scan') {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Forge: Scanning for GGUF models…' },
      async () => {
        candidates = await scanForGgufs();
      },
    );
    if (candidates.length === 0) {
      const extraDir = await vscode.window.showInputBox({
        title: 'Forge: No GGUF files found',
        prompt:
          'Enter a directory path to search (e.g. D:\\models or /mnt/nas/models), or leave blank to skip',
        placeHolder: 'D:\\models',
        ignoreFocusOut: true,
      });
      if (extraDir?.trim()) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Forge: Scanning…' },
          async () => {
            candidates = await scanForGgufs([extraDir.trim()]);
          },
        );
      }
      if (candidates.length === 0) {
        await vscode.window.showWarningMessage(
          'No GGUF files found. Configure config.yaml manually.',
        );
        return false;
      }
    }
  } else {
    return false;
  }

  const items = candidates.slice(0, 10).map((c) => ({
    label: c.modelName,
    description: `${(c.sizeBytes / 1e9).toFixed(1)} GB — ${c.familyHint}`,
    path: c.ggufPath,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select one or more GGUF models',
    title: 'Forge: Pick your model',
  });
  if (!picked?.length) return false;

  const binResult = await vscode.window.showInputBox({
    prompt: 'Path to llama-server binary (leave blank to search PATH)',
    placeHolder: '/usr/local/bin/llama-server or C:\\llama.cpp\\llama-server.exe',
    ignoreFocusOut: true,
  });

  const selected = picked
    .map((item) => candidates.find((c) => c.ggufPath === item.path))
    .filter((candidate): candidate is GgufCandidate => candidate !== undefined);
  if (!selected.length) return false;
  const target = await chooseConfigTarget(context);
  if (!target) return false;
  const starterConfig = makeLlamaCppStarterConfig(
    selected.map((candidate) => {
      const suggestion = deriveModelSuggestion(candidate);
      return { ggufPath: candidate.ggufPath, modelName: suggestion.suggestedName, suggestion };
    }),
    binResult || 'llama-server',
  );

  await writeStarterConfig(context, target, starterConfig);
  return true;
}

// ── Ollama flow ───────────────────────────────────────────────────────────────

export async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/$/, '').replace(/\/(v1|api)$/, '');
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).filter(Boolean);
}

async function runOllamaFlow(context: vscode.ExtensionContext): Promise<boolean> {
  const endpointInput = await vscode.window.showInputBox({
    title: 'Forge: Ollama endpoint',
    prompt: 'Ollama base URL',
    value: 'http://127.0.0.1:11434',
    ignoreFocusOut: true,
  });
  if (!endpointInput) return false;
  const endpoint = endpointInput.trim().replace(/\/$/, '');

  let modelNames: string[] = [];
  let models: string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Forge: Fetching Ollama models…' },
    async () => {
      models = await fetchOllamaModels(endpoint).catch(() => []);
    },
  );

  if (models.length > 0) {
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m })),
      {
        canPickMany: true,
        title: 'Forge: Pick Ollama models',
        placeHolder: 'Select one or more models',
      },
    );
    modelNames = picked?.map((item) => item.label) ?? [];
  }

  if (!modelNames.length) {
    const modelName = await vscode.window.showInputBox({
      title: 'Forge: Ollama model name',
      prompt: 'Enter exact model tag (e.g. gemma4:e4b)',
      placeHolder: 'gemma4:e4b',
      ignoreFocusOut: true,
    });
    if (modelName) modelNames = [modelName];
  }
  if (!modelNames.length) return false;

  const target = await chooseConfigTarget(context);
  if (!target) return false;
  await writeStarterConfig(context, target, makeOllamaStarterConfig(endpoint, modelNames));
  return true;
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Shown when no config.yaml exists. Guides the user through backend selection
 * and writes a validated starter config.yaml to an explicit global or workspace target.
 * Returns true if a config was written, false if the user cancelled.
 */
export async function runFirstRunWizard(context: vscode.ExtensionContext): Promise<boolean> {
  const backendPick = await vscode.window.showQuickPick(
    [
      {
        label: '$(server) llama.cpp',
        description: 'Run local GGUF files via llama-server',
        value: 'llamacpp',
      },
      {
        label: '$(hubot) Ollama',
        description: 'Connect to a running Ollama instance',
        value: 'ollama',
      },
    ],
    {
      title: 'Forge: How do you want to run models?',
      placeHolder: 'Select a backend',
      ignoreFocusOut: true,
    },
  );

  if (!backendPick) return false;

  if (backendPick.value === 'llamacpp') return runLlamaCppFlow(context);
  return runOllamaFlow(context);
}
