import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview, ForgeSlashCommandId } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { SidebarProviderEvents } from './AgentLoop';
import { activeFileBlock, activeSelectionBlock, formatContextBlocks } from '../vscode/editorContext';

export interface SlashCommandDeps {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
  newConversation: () => Promise<void>;
  clearMessages: () => void;
  submitPrompt: (text: string) => Promise<void>;
  undo: () => string[];
  keep: () => void;
  post: (msg: HostToWebview) => void;
  getActiveConv: () => ConversationRuntime;
  persistSession: () => void;
  postSessionSync: () => void;
  postTokenBudget: () => void;
  runPromptToMarkdown: (text: string) => Promise<string>;
  isStreaming: () => boolean;
}

export class SlashCommandHandler {
  constructor(private readonly deps: SlashCommandDeps) {}

  async handle(commandId: ForgeSlashCommandId): Promise<void> {
    const { deps } = this;
    switch (commandId) {
      case 'unloadModel':
        try {
          await deps.pool.stopAll();
          deps.events.onBackendStopped?.(deps.getConfig().active_model);
          deps.post({ type: 'backendDown', message: 'All models unloaded. Send a prompt to start the backend again.' });
        } catch (err) {
          deps.post({ type: 'error', message: `Failed to unload models: ${(err as Error).message}` });
        }
        return;

      case 'restartBackend':
        try {
          await deps.pool.stopAll();
          deps.events.onBackendStopped?.(deps.getConfig().active_model);
          const modelName = deps.getConfig().active_model;
          if (modelName) {
            await deps.pool.acquire(modelName);
            deps.events.onBackendReady?.(modelName);
          }
          void vscode.window.showInformationMessage(modelName
            ? 'Forge: backend restarted.'
            : 'Forge: all backends stopped. Pick a model to start again.');
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'newChat':
        await deps.newConversation();
        return;

      case 'clearChat':
        deps.clearMessages();
        return;

      case 'review':
        await deps.submitPrompt(this.buildReviewPrompt());
        return;

      case 'compact':
        await this.compact();
        return;

      case 'undo':
        try {
          const restored = deps.undo();
          void vscode.window.showInformationMessage(`Forge: undid last turn, restored ${restored.length} file(s)`);
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'keep':
        try {
          deps.keep();
          void vscode.window.showInformationMessage('Forge: changes kept');
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'reloadWindow':
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
    }
  }

  private buildReviewPrompt(): string {
    const selection = activeSelectionBlock();
    if (selection) return `Review this code. Lead with findings, then risks and test gaps.\n\n${formatContextBlocks([selection])}`;
    const file = activeFileBlock();
    if (file) return `Review this file. Lead with findings, then risks and test gaps.\n\n${formatContextBlocks([file])}`;
    return 'Review the current workspace changes. Start by inspecting the most relevant files or git diff. Lead with findings, then risks and test gaps.';
  }

  private async compact(): Promise<void> {
    const { deps } = this;
    if (deps.isStreaming()) {
      void vscode.window.showInformationMessage('Forge: wait for the current response to finish before compacting.');
      return;
    }
    const conv = deps.getActiveConv();
    const compactable = conv.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    if (compactable.length < 2) {
      void vscode.window.showInformationMessage('Forge: not enough conversation history to compact.');
      return;
    }
    const transcript = compactable.map((m) => {
      const reasoning = m.reasoning ? `\nReasoning summary:\n${m.reasoning}` : '';
      return `${m.role.toUpperCase()}:\n${m.content}${reasoning}`;
    }).join('\n\n');

    const summary = await deps.runPromptToMarkdown(
      `Summarize this conversation for continued work in the same repository.\n\nRequirements:\n- Preserve user goals, constraints, decisions, open questions, and unfinished tasks.\n- Mention relevant files, commands, errors, and risks.\n- Keep it concise but specific.\n- Do not add facts not present in the conversation.\n\nConversation:\n${transcript}`,
    );
    const trimmed = summary.trim();
    if (!trimmed) { void vscode.window.showWarningMessage('Forge: compaction returned no summary.'); return; }

    conv.messages = [
      { role: 'user', content: 'Conversation summary. Use this as the working context for future turns in this chat.' },
      { role: 'assistant', content: trimmed },
    ];
    conv.updatedAt = Date.now();
    deps.persistSession();
    deps.postSessionSync();
    deps.postTokenBudget();
    void vscode.window.showInformationMessage('Forge: active chat compacted.');
  }
}
