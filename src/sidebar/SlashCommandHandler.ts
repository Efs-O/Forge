import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import type { ForgeSlashCommandId } from './messageBridge';
import type { SidebarProviderEvents } from './AgentLoop';
import { runInitForgeCommand } from './initForgeCommand';
import type { HostActivityEvent, HostActivityListener } from './HostActivity';
import {
  runCompaction,
  type CompactionDeps,
  type CompactionEvent,
  type CompactionOutcome,
  type CompactionTrigger,
} from './CompactionService';
import {
  activeFileBlock,
  activeSelectionBlock,
  formatContextBlocks,
} from '../vscode/editorContext';
import { deriveTitle, isUntitled, type ConversationRuntime } from './sessionTypes';
import { collectSystemReport } from '../system/SystemReport';
import { formatSystemReport } from '../system/formatSystemReport';

export interface SlashCommandDeps extends CompactionDeps {
  /** UI-only commands still target the selected tab. */
  getActiveConv: () => ConversationRuntime;
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
  /** Owned by SidebarProvider. Both throw on failure; this handler reports it. */
  unloadModels: () => Promise<void>;
  unloadActiveModel: () => Promise<{ model: string; wasLoaded: boolean }>;
  reindexCodebase: () => Promise<void>;
  newConversation: () => Promise<void>;
  clearMessages: () => void;
  submitPrompt: (text: string) => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  toggleClanker: () => boolean;
  incompleteTurnReason: (conversationId: string) => string | undefined;
  resumeAfterManualCompact: (conversationId: string, reason: string) => Promise<void>;
}

export class SlashCommandHandler {
  /** Remote transports subscribe here to observe compaction progress. */
  readonly compactionListeners = new Set<(event: CompactionEvent) => void>();
  /** Same idea, for state changes a paired chat cannot otherwise learn about. */
  readonly activityListeners = new Set<HostActivityListener>();

  constructor(private readonly deps: SlashCommandDeps) {}

  onCompactionEvent(listener: (event: CompactionEvent) => void): { dispose(): void } {
    this.compactionListeners.add(listener);
    return { dispose: () => this.compactionListeners.delete(listener) };
  }

  onHostActivity(listener: HostActivityListener): { dispose(): void } {
    this.activityListeners.add(listener);
    return { dispose: () => this.activityListeners.delete(listener) };
  }

  /** Fan out to every subscribed transport. No listeners is the normal case:
   *  remote is opt-in, and these commands must not care whether it is up. */
  emitActivity(event: HostActivityEvent): void {
    for (const listener of this.activityListeners) listener(event);
  }

  async handle(commandId: ForgeSlashCommandId): Promise<void> {
    const { deps } = this;
    switch (commandId) {
      case 'unloadModel': // only the active tab's model
        return this.runUnload(async () => {
          const { model, wasLoaded } = await deps.unloadActiveModel();
          return `Forge: ${model} ${wasLoaded ? 'unloaded' : 'was not loaded'}.`;
        });
      case 'unloadAll':
        return this.runUnload(() => deps.unloadModels().then(() => 'Forge: all models unloaded.'));

      case 'restartBackend':
        try {
          await deps.pool.stopAll();
          deps.events.onBackendStopped?.(deps.getConfig().active_model);
          const modelName = deps.getConfig().active_model;
          if (modelName) {
            await deps.pool.acquire(modelName);
            deps.events.onBackendReady?.(modelName);
          }
          const outcome = modelName
            ? 'Forge: backend restarted.'
            : 'Forge: all backends stopped. Pick a model to start again.';
          void vscode.window.showInformationMessage(outcome);
          this.emitActivity({ text: outcome });
        } catch (err) {
          const message = `Forge: ${(err as Error).message}`;
          void vscode.window.showErrorMessage(message);
          // A failed restart is the case a remote user most needs to hear:
          // silence would read as a backend that came back.
          this.emitActivity({ text: `Forge: backend restart failed. ${message}` });
        }
        return;

      case 'reindex':
        await deps.reindexCodebase();
        return;

      case 'newChat':
        await deps.newConversation();
        // Window-scoped on purpose: a chat bound to the old conversation stays
        // bound to it, so this is news about the window, not about that chat's
        // binding. /resume is how a remote user follows the new one.
        this.emitActivity({ text: 'Forge: started a new chat in this window.' });
        return;

      case 'rename':
        await this.renameConversation();
        return;

      case 'context':
        await this.chooseContext();
        return;

      case 'config':
        await vscode.commands.executeCommand('forge.openConfig');
        return;

      case 'logs':
        await vscode.commands.executeCommand('forge.showBackendConsole');
        return;

      case 'clearChat':
        {
          // Conversation-scoped: only the chats bound to this conversation just
          // lost their history, and only they need to know why it is empty.
          const conversationId = deps.getActiveConv().id;
          deps.clearMessages();
          this.emitActivity({ text: 'Forge: chat cleared.', conversationId });
        }
        return;

      case 'review':
        await deps.submitPrompt(this.buildReviewPrompt());
        return;

      case 'compact':
        {
          const conversationId = deps.getActiveConv().id;
          // Capture this before compaction starts. The summarization is
          // background work, not a model turn, and must not make a cleanly
          // idle conversation look like it needs another response.
          const incompleteReason = deps.incompleteTurnReason(conversationId);
          const outcome = await this.compactConversation(conversationId, { auto: false });
          if (outcome === 'compacted' && incompleteReason !== undefined) {
            await deps.resumeAfterManualCompact(conversationId, incompleteReason);
          }
        }
        return;

      case 'undo':
        try {
          const restored = await deps.undo();
          void vscode.window.showInformationMessage(
            `Forge: undid last turn, restored ${restored.length} file(s)`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'keep':
        try {
          await deps.keep();
          void vscode.window.showInformationMessage('Forge: changes kept');
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'reloadWindow':
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;

      case 'system': {
        const report = await collectSystemReport({
          backendProcesses: () => deps.pool.backendProcesses(),
        });
        // A notice row, not a model turn: this costs no tokens and needs no
        // backend, which is the point — it is most useful when the backend is
        // the thing eating the machine.
        deps.post({
          type: 'notice',
          message: formatSystemReport(report, { sidebar: true }),
          conversationId: deps.getActiveConv().id,
          preformatted: true,
        });
        return;
      }

      case 'initForge':
        await runInitForgeCommand(deps);
        return;

      case 'clanker': {
        const on = deps.toggleClanker();
        deps.post({
          type: 'token',
          text: on
            ? '\n> 💥 **Clanker Mode ON** — every tab in this window, and this workspace only. No confirmation prompts until you run `/clanker` again; it survives a reload. Recursive deletes still confirm.\n'
            : '\n> 💥 **Clanker Mode OFF** — confirmation restored in this workspace.\n',
        });
        return;
      }
    }
  }

  private buildReviewPrompt(): string {
    const selection = activeSelectionBlock();
    if (selection)
      return `Review this code. Lead with findings, then risks and test gaps.\n\n${formatContextBlocks([selection])}`;
    const file = activeFileBlock();
    if (file)
      return `Review this file. Lead with findings, then risks and test gaps.\n\n${formatContextBlocks([file])}`;
    return 'Review the current workspace changes. Start by inspecting the most relevant files or git diff. Lead with findings, then risks and test gaps.';
  }

  private async renameConversation(): Promise<void> {
    const conversation = this.deps.getActiveConv();
    const title = await vscode.window.showInputBox({
      prompt: 'Rename active conversation',
      value: isUntitled(conversation.title) ? '' : conversation.title,
      placeHolder: 'Conversation title',
      validateInput: (value) => (value.trim() ? undefined : 'Enter a title.'),
    });
    if (title === undefined) return;

    conversation.title = deriveTitle(title);
    conversation.updatedAt = Date.now();
    this.deps.persistSession();
    this.deps.postSessionSync();
  }

  private async chooseContext(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Current File',
          description: 'Use the active editor file as context.',
          command: 'forge.useCurrentFile',
        },
        {
          label: 'Selection',
          description: 'Use the current editor selection as context.',
          command: 'forge.useSelection',
        },
        {
          label: 'Open Tabs',
          description: 'Use all open editor tabs as context.',
          command: 'forge.useOpenTabs',
        },
        {
          label: 'Pick Files',
          description: 'Choose files to use as context.',
          command: 'forge.pickContextFiles',
        },
      ],
      { title: 'Forge: Add Context', placeHolder: 'Choose context for the next answer' },
    );
    if (pick) await vscode.commands.executeCommand(pick.command);
  }

  /** The owners throw; only this surface swallows into the webview. The notice
   *  is window-scoped: a paired chat that did not run it is just as affected. */
  private async runUnload(unload: () => Promise<string>): Promise<void> {
    try {
      this.emitActivity({ text: await unload() });
    } catch (err) {
      this.deps.post({ type: 'error', message: `Failed to unload: ${(err as Error).message}` });
    }
  }

  /**
   * Runs a compaction. `auto: true` is the threshold-triggered path — the
   * caller decides whether to resume from the returned outcome.
   */
  async compact(options: { auto: boolean } = { auto: false }): Promise<CompactionOutcome> {
    return this.compactConversation(this.deps.getActiveConv().id, options);
  }

  /** Addressed entry point used by background request chains. */
  async compactConversation(
    conversationId: string,
    options: {
      auto: boolean;
      trigger?: CompactionTrigger;
      remoteOrigin?: { channel: string; chatId: string };
    } = { auto: false },
  ): Promise<CompactionOutcome> {
    return runCompaction(this.deps, conversationId, options);
  }
}
