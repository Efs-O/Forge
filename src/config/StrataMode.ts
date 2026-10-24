import * as path from 'path';
import { expandAlias, splitModelProfile } from './ConfigResolver';
import { loadConfig } from './ConfigLoader';
import { updateConfigFile } from './ConfigWriter';

export type StrataModeChoice = 'solo' | 'multi' | 'status';

export interface StrataModeResult {
  message: string;
  modelName?: string;
  mode?: 'solo' | 'multi';
  changed?: boolean;
}

/** Read or update start_command[3] for the window-selected model. */
export function runStrataModeCommand(
  configPath: string,
  fallbackModelName: string | undefined,
  choice: StrataModeChoice,
  isBackendRunning: (modelName: string) => boolean,
  runningChatCount: number,
): StrataModeResult {
  const config = loadConfig(path.dirname(configPath));
  const selectedModel = config.active_model ?? fallbackModelName;
  if (!selectedModel) return { message: 'No model is selected for /strataMode.' };

  const modelName = splitModelProfile(expandAlias(config, selectedModel)).base;
  const modelIndex = config.models.findIndex((model) => model.name === modelName);
  const model = config.models[modelIndex];
  const startCommand = model?.start_command;
  const launcherMode = startCommand?.[3];
  if (
    !model ||
    startCommand === undefined ||
    startCommand.length < 4 ||
    (launcherMode !== 'solo' && launcherMode !== 'pair')
  ) {
    return { message: `Forge: ${modelName} has no solo/pair launch mode.`, modelName };
  }

  const configuredMode = launcherMode === 'pair' ? 'multi' : 'solo';
  const backendRunning = isBackendRunning(modelName);
  const runningSuffix =
    runningChatCount > 0
      ? ` ${runningChatCount} chat${runningChatCount === 1 ? '' : 's'} currently running.`
      : '';

  if (choice === 'status') {
    return {
      message: `Strata mode for ${modelName}: ${configuredMode}; backend is ${backendRunning ? 'running' : 'not running'}.${runningSuffix}`,
      modelName,
      mode: configuredMode,
      changed: false,
    };
  }
  if (configuredMode === choice) {
    return {
      message: `Strata mode is already ${choice} for ${modelName}.${runningSuffix}`,
      modelName,
      mode: configuredMode,
      changed: false,
    };
  }

  const launchValue = choice === 'multi' ? 'pair' : 'solo';
  updateConfigFile(configPath, (doc) => {
    doc.setIn(['models', modelIndex, 'start_command', 3], launchValue);
  });

  const summary =
    choice === 'multi'
      ? 'Strata mode set to multi (two chats at once, a lone chat ~10-20% slower). It takes effect at the next start: run /unloadModel when no chat is running.'
      : 'Strata mode set to solo (one chat at once). It takes effect at the next start: run /unloadModel when no chat is running.';
  return {
    message: `${summary}${runningSuffix}`,
    modelName,
    mode: choice,
    changed: true,
  };
}
