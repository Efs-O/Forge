import * as path from 'path';
import * as YAML from 'yaml';
import { effectiveParallelCapacity } from '../backend/parallelCapacity';
import { DEFAULT_LLAMA_CTX, perSlotContext } from '../util/contextBudget';
import { expandAlias, resolveSpawnModel, splitModelProfile } from './ConfigResolver';
import { loadConfig } from './ConfigLoader';
import { updateConfigFile } from './ConfigWriter';
import type { ForgeConfig } from './types';

export type ChatModeChoice = 'solo' | 'multi';

export interface ChatModeState {
  modelName: string;
  kind: 'strata' | 'llama';
  mode: ChatModeChoice;
  backendRunning: boolean;
  runningChatCount: number;
  /** llama only: effective per-chat context for the configured slot count. */
  perChatContext?: number;
}

export interface ChatModeResult {
  message: string;
  modelName?: string;
  mode?: ChatModeChoice;
  changed?: boolean;
}

type ChatModeRead = ChatModeState | { message: string };

/** Read the supported mode for the window-selected model without writing. */
export function readChatMode(
  configPath: string,
  fallbackModelName: string | undefined,
  isBackendRunning: (modelName: string) => boolean,
  runningChatCount: number,
): ChatModeRead {
  const config = loadConfig(path.dirname(configPath));
  return readChatModeFromConfig(config, fallbackModelName, isBackendRunning, runningChatCount);
}

/** Read or update the selected model's Strata launcher mode or llama slots. */
export function runChatModeCommand(
  configPath: string,
  fallbackModelName: string | undefined,
  choice: ChatModeChoice | 'status',
  isBackendRunning: (modelName: string) => boolean,
  runningChatCount: number,
): ChatModeResult {
  const config = loadConfig(path.dirname(configPath));
  const state = readChatModeFromConfig(
    config,
    fallbackModelName,
    isBackendRunning,
    runningChatCount,
  );
  if ('message' in state) return { message: state.message };

  const runningSuffix = runningChatSuffix(runningChatCount);
  if (choice === 'status') {
    return {
      message: `${statusMessage(config, state)}${runningSuffix}`,
      modelName: state.modelName,
      mode: state.mode,
      changed: false,
    };
  }
  if (state.mode === choice) {
    return {
      message: `Chat mode is already ${choice} for ${state.modelName}.${runningSuffix}`,
      modelName: state.modelName,
      mode: state.mode,
      changed: false,
    };
  }

  const modelIndex = config.models.findIndex((model) => model.name === state.modelName);
  if (state.kind === 'strata') {
    updateConfigFile(configPath, (doc) => {
      doc.setIn(['models', modelIndex, 'start_command', 3], choice);
    });
    return {
      message: `${strataChangeMessage(choice)}${runningSuffix}`,
      modelName: state.modelName,
      mode: choice,
      changed: true,
    };
  }

  const targetParallel = choice === 'multi' ? 2 : 1;
  let sharedModels: string[] = [];
  const written = updateConfigFile(
    configPath,
    (doc) => {
      sharedModels = writeLlamaParallel(doc, modelIndex, config, targetParallel);
    },
    () => {
      const after = loadConfig(path.dirname(configPath));
      return effectiveParallelCapacity(after, state.modelName) === targetParallel;
    },
  );
  if (!written) {
    return {
      message: `n_parallel for ${state.modelName} is set by another config layer; edit it there.`,
      modelName: state.modelName,
      mode: state.mode,
      changed: false,
    };
  }

  const after = loadConfig(path.dirname(configPath));
  const context = llamaContext(after, state.modelName);
  const baseMessage = llamaChangeMessage(choice, context.perChatContext, context.totalContext);
  const sharedSuffix =
    sharedModels.length > 0
      ? ` Also applies to ${sharedModels.join(', ')} (they share one spawn block).`
      : '';
  return {
    message: `${baseMessage}${sharedSuffix}${runningSuffix}`,
    modelName: state.modelName,
    mode: choice,
    changed: true,
  };
}

function readChatModeFromConfig(
  config: ForgeConfig,
  fallbackModelName: string | undefined,
  isBackendRunning: (modelName: string) => boolean,
  runningChatCount: number,
): ChatModeRead {
  const selectedModel = config.active_model ?? fallbackModelName;
  if (!selectedModel) return { message: 'No model is selected for /chatMode.' };

  const modelName = splitModelProfile(expandAlias(config, selectedModel)).base;
  const model = config.models.find((entry) => entry.name === modelName);
  if (!model) return { message: `Forge: ${modelName} has no solo/multi setting.` };

  const launcherMode = model.start_command?.[3];
  if (launcherMode === 'solo' || launcherMode === 'multi') {
    return {
      modelName,
      kind: 'strata',
      mode: launcherMode,
      backendRunning: isBackendRunning(modelName),
      runningChatCount,
    };
  }
  if (launcherMode === 'pair') {
    return {
      message: `Forge: ${modelName} start_command[3] is "pair"; set it to solo or multi.`,
    };
  }

  const spawnModel = resolveSpawnModel(config, modelName);
  if ((spawnModel.provider ?? 'llama.cpp') !== 'llama.cpp') {
    return { message: `Forge: ${modelName} has no solo/multi setting.` };
  }
  const parallel = effectiveParallelCapacity(config, modelName);
  if (parallel !== 1 && parallel !== 2) {
    return { message: `Forge: ${modelName} n_parallel is ${parallel}; /chatMode sets 1 or 2.` };
  }
  return {
    modelName,
    kind: 'llama',
    mode: parallel === 1 ? 'solo' : 'multi',
    backendRunning: isBackendRunning(modelName),
    runningChatCount,
    perChatContext: llamaContext(config, modelName).perChatContext,
  };
}

function llamaContext(
  config: ForgeConfig,
  modelName: string,
): { perChatContext: number; totalContext: number } {
  const model = resolveSpawnModel(config, modelName);
  const parallel = effectiveParallelCapacity(config, modelName);
  const totalContext = model.num_ctx ?? config.llama_server.default_num_ctx ?? DEFAULT_LLAMA_CTX;
  return {
    perChatContext: perSlotContext(
      { ...model, n_parallel: parallel },
      config.llama_server,
      'llama.cpp',
    ),
    totalContext,
  };
}

function statusMessage(config: ForgeConfig, state: ChatModeState): string {
  const backend = state.backendRunning ? 'running' : 'not running';
  if (state.kind === 'strata') {
    return `Chat mode for ${state.modelName}: ${state.mode}; backend is ${backend}.`;
  }
  const parallel = effectiveParallelCapacity(config, state.modelName);
  const context = state.perChatContext ?? 0;
  return `Chat mode for ${state.modelName}: ${state.mode} (${parallel} ${parallel === 1 ? 'chat' : 'chats'}, ${context.toLocaleString('en-US')} tokens each); backend is ${backend}.`;
}

function strataChangeMessage(choice: ChatModeChoice): string {
  return choice === 'multi'
    ? 'Chat mode set to multi (two chats at once, a lone chat ~10-20% slower). It takes effect at the next start: run /unloadModel when no chat is running.'
    : 'Chat mode set to solo (one chat at a time). It takes effect at the next start: run /unloadModel when no chat is running.';
}

function llamaChangeMessage(choice: ChatModeChoice, perChat: number, total: number): string {
  if (choice === 'multi') {
    const contextShare = perChat === total ? 'the full context' : 'half the context';
    return `Chat mode set to multi (two chats at once, each with ${contextShare}: ${perChat.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tokens). It takes effect at the next start: run /unloadModel when no chat is running.`;
  }
  return `Chat mode set to solo (one chat at a time, full ${total.toLocaleString('en-US')}-token context for llama). It takes effect at the next start: run /unloadModel when no chat is running.`;
}

function runningChatSuffix(runningChatCount: number): string {
  return runningChatCount > 0
    ? ` ${runningChatCount} chat${runningChatCount === 1 ? '' : 's'} currently running.`
    : '';
}

function writeLlamaParallel(
  doc: YAML.Document,
  modelIndex: number,
  config: ForgeConfig,
  targetParallel: number,
): string[] {
  const modelNode = doc.getIn(['models', modelIndex], true);
  if (!YAML.isMap(modelNode))
    throw new Error('Forge: selected model config is not a YAML mapping.');

  if (modelNode.has('n_parallel')) {
    modelNode.set('n_parallel', doc.createNode(targetParallel));
    return [];
  }

  const existingSpawn = modelNode.get('spawn', true);
  if (existingSpawn === undefined) {
    modelNode.set('spawn', doc.createNode({ n_parallel: targetParallel }));
    return [];
  }
  const spawnNode = resolveYamlNode(existingSpawn, doc);
  if (!YAML.isMap(spawnNode)) throw new Error('Forge: model spawn config is not a YAML mapping.');
  spawnNode.set('n_parallel', doc.createNode(targetParallel));

  const sharedModels = config.models.flatMap((model, index) => {
    if (index === modelIndex) return [];
    const otherNode = doc.getIn(['models', index, 'spawn'], true);
    return otherNode !== undefined && resolveYamlNode(otherNode, doc) === spawnNode
      ? [model.name]
      : [];
  });
  return sharedModels;
}

function resolveYamlNode(node: unknown, doc: YAML.Document): unknown {
  return YAML.isAlias(node) ? node.resolve(doc) : node;
}
