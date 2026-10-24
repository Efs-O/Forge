import * as vscode from 'vscode';
import { readChatMode, runChatModeCommand, type ChatModeChoice } from '../config/ChatMode';
import { resolveSpawnModel } from '../config/ConfigResolver';
import { perSlotContext } from '../util/contextBudget';
import type { HostActivityEvent } from './HostActivity';
import type { SlashCommandDeps } from './SlashCommandHandler';

/** Picker interaction for `/chatMode`, kept separate from general slash dispatch. */
export async function runChatModePicker(
  deps: SlashCommandDeps,
  emitActivity: (event: HostActivityEvent) => void,
): Promise<void> {
  const configPath = deps.getConfigPath?.();
  if (!configPath) {
    deps.post({ type: 'error', message: 'Chat mode: config path is unavailable.' });
    return;
  }
  const runningChatCount = deps
    .getConversations()
    .filter((conversation) => deps.isStreamingConv(conversation.id)).length;
  try {
    const state = readChatMode(
      configPath,
      deps.getActiveConv().active_model,
      (modelName) => deps.pool.isLoaded(modelName),
      runningChatCount,
    );
    if ('message' in state) {
      deps.post({
        type: 'notice',
        message: state.message,
        conversationId: deps.getActiveConv().id,
      });
      emitActivity({ text: state.message, ephemeral: true });
      return;
    }

    const config = deps.getConfig();
    const spawnModel =
      state.kind === 'llama' ? resolveSpawnModel(config, state.modelName) : undefined;
    const contextAtSlots = (slots: number): number => {
      if (!spawnModel) return 0;
      const withSlots = {
        ...spawnModel,
        n_parallel: slots,
        ...(spawnModel.spawn ? { spawn: { ...spawnModel.spawn, n_parallel: slots } } : {}),
      };
      return perSlotContext(withSlots, config.llama_server, 'llama.cpp');
    };
    const soloDescription =
      state.kind === 'llama'
        ? `One chat at a time. Full ${contextAtSlots(1).toLocaleString('en-US')}-token context.`
        : 'One chat at a time.';
    const multiDescription =
      state.kind === 'strata'
        ? 'Two chats at once. A lone chat ~10-20% slower.'
        : `Two chats at once. ${contextAtSlots(2).toLocaleString('en-US')} tokens each.`;
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: `${state.mode === 'solo' ? '$(check) ' : ''}solo`,
          choice: 'solo' as const,
          description: soloDescription,
        },
        {
          label: `${state.mode === 'multi' ? '$(check) ' : ''}multi`,
          choice: 'multi' as const,
          description: multiDescription,
        },
      ],
      { title: `Chat mode: ${state.modelName} (now ${state.mode})` },
    );
    if (!selection) return;

    const choice: ChatModeChoice = selection.choice;
    const result = runChatModeCommand(
      configPath,
      deps.getActiveConv().active_model,
      choice,
      (modelName) => deps.pool.isLoaded(modelName),
      runningChatCount,
    );
    deps.post({
      type: 'notice',
      message: result.message,
      conversationId: deps.getActiveConv().id,
    });
    emitActivity({ text: result.message, ephemeral: true });
  } catch (error) {
    deps.post({
      type: 'error',
      message: `Chat mode: ${error instanceof Error ? error.message : String(error)}`,
      conversationId: deps.getActiveConv().id,
    });
  }
}
