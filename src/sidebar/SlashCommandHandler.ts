import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import type { ForgeSlashCommandId } from './messageBridge';
import type { SidebarProviderEvents } from './AgentLoop';
import { runCompaction, type CompactionDeps, type CompactionOutcome } from './CompactionService';
import {
  preferredProjectInstructionsPath,
  resolveInstructionScopeRoot,
} from '../llm/ForgeInstructionsLoader';
import {
  activeFileBlock,
  activeSelectionBlock,
  formatContextBlocks,
} from '../vscode/editorContext';
import { deriveTitle, isUntitled, type ConversationRuntime } from './sessionTypes';

export interface SlashCommandDeps extends CompactionDeps {
  /** UI-only commands still target the selected tab. */
  getActiveConv: () => ConversationRuntime;
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  events: SidebarProviderEvents;
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
  constructor(private readonly deps: SlashCommandDeps) {}

  async handle(commandId: ForgeSlashCommandId): Promise<void> {
    const { deps } = this;
    switch (commandId) {
      case 'unloadModel':
        try {
          await deps.pool.stopAll();
          deps.events.onBackendStopped?.(deps.getConfig().active_model);
          deps.post({
            type: 'backendDown',
            message: 'All models unloaded. Send a prompt to start the backend again.',
          });
        } catch (err) {
          deps.post({
            type: 'error',
            message: `Failed to unload models: ${(err as Error).message}`,
          });
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
          void vscode.window.showInformationMessage(
            modelName
              ? 'Forge: backend restarted.'
              : 'Forge: all backends stopped. Pick a model to start again.',
          );
        } catch (err) {
          void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
        }
        return;

      case 'reindex':
        await deps.reindexCodebase();
        return;

      case 'newChat':
        await deps.newConversation();
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
        deps.clearMessages();
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

      case 'initForge':
        await this.initForge();
        return;

      case 'clanker': {
        const on = deps.toggleClanker();
        deps.post({
          type: 'token',
          text: on
            ? '\n> 💥 **Clanker Mode ON** — no confirmation prompts until you run `/clanker` again. Recursive deletes still confirm.\n'
            : '\n> 💥 **Clanker Mode OFF** — confirmation restored.\n',
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

  private async initForge(): Promise<void> {
    const { deps } = this;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage(
        'Forge: no workspace folder open — cannot generate FORGE.md.',
      );
      return;
    }
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const repositoryRoot = resolveInstructionScopeRoot(root, activeFile);
    const instructionsPath = preferredProjectInstructionsPath(repositoryRoot);
    const instructionsName = path.basename(instructionsPath);
    if (fs.existsSync(instructionsPath)) {
      const answer = await vscode.window.showWarningMessage(
        `Forge: ${instructionsName} already exists. Overwrite it?`,
        'Overwrite',
        'Cancel',
      );
      if (answer !== 'Overwrite') return;
    }

    let content: string;
    try {
      content = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Forge: scanning workspace and generating ${instructionsName}…`,
          cancellable: false,
        },
        async () => {
          const context = this.collectWorkspaceContext(repositoryRoot);
          return deps.runPromptToMarkdown(this.buildInitForgePrompt(repositoryRoot, context));
        },
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Forge: failed to generate ${instructionsName} — ${(err as Error).message}`,
      );
      return;
    }

    const trimmed = this.extractMarkdownFromToolCall(content.trim());
    if (!trimmed) {
      void vscode.window.showWarningMessage(
        `Forge: model returned empty content — ${instructionsName} not written.`,
      );
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(instructionsPath),
        new TextEncoder().encode(trimmed + '\n'),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Forge: could not write ${instructionsName} — ${(err as Error).message}`,
      );
      return;
    }

    void vscode.window.showInformationMessage(
      `Forge: ${instructionsName} created. The agent will use it from the next message.`,
    );
  }

  private extractMarkdownFromToolCall(raw: string): string {
    // Strip outer markdown code fence if present (```json ... ``` or ``` ... ```)
    const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)```[\s\S]*$/);
    const inner = fenceMatch ? fenceMatch[1].trim() : raw;

    // Try to parse as a tool call JSON and extract arguments.content
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(inner) as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const argContent = (parsed?.arguments as Record<string, any>)?.content;
      if (typeof argContent === 'string' && argContent.trim()) {
        return argContent.trim().replace(/\\n/g, '\n');
      }
    } catch {
      /* not JSON — use as-is */
    }

    return inner;
  }

  private collectWorkspaceContext(root: string): string {
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      'out',
      '.next',
      '.turbo',
      'coverage',
      '__pycache__',
      '.venv',
      'venv',
    ]);
    const lines: string[] = [];

    // Top-level directory listing
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => e.name);
      const files = entries.filter((e) => e.isFile()).map((e) => e.name);
      lines.push(`Top-level dirs: ${dirs.join(', ') || '(none)'}`);
      lines.push(`Top-level files: ${files.join(', ') || '(none)'}`);
    } catch {
      /* unreadable root */
    }

    // package.json — name, scripts keys, dependency names
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, 'utf8').slice(0, 2000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pkg = JSON.parse(raw) as Record<string, any>;
        lines.push(`package name: ${pkg.name ?? '(unnamed)'}`);
        if (pkg.scripts) lines.push(`scripts: ${Object.keys(pkg.scripts as object).join(', ')}`);
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        if (deps.length)
          lines.push(`dependencies: ${deps.slice(0, 30).join(', ')}${deps.length > 30 ? '…' : ''}`);
      } catch {
        /* malformed JSON */
      }
    }

    // Detect common config files that indicate stack
    const indicators = [
      'tsconfig.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
      '.eslintrc',
      'vite.config.ts',
      'webpack.config.js',
    ];
    const found = indicators.filter((f) => fs.existsSync(path.join(root, f)));
    if (found.length) lines.push(`config files present: ${found.join(', ')}`);

    // One level deeper into src/ if it exists
    const srcPath = path.join(root, 'src');
    if (fs.existsSync(srcPath)) {
      try {
        const srcEntries = fs.readdirSync(srcPath, { withFileTypes: true });
        const srcDirs = srcEntries.filter((e) => e.isDirectory()).map((e) => e.name);
        const srcFiles = srcEntries.filter((e) => e.isFile()).map((e) => e.name);
        if (srcDirs.length) lines.push(`src/ subdirs: ${srcDirs.join(', ')}`);
        if (srcFiles.length) lines.push(`src/ files: ${srcFiles.join(', ')}`);
      } catch {
        /* unreadable */
      }
    }

    return lines.join('\n');
  }

  private buildInitForgePrompt(root: string, context: string): string {
    return `Generate a FORGE.md repository instructions file. All information you need is provided below — do NOT call any tools or request more files.

Workspace root: ${root}

Workspace scan results:
${context}

Write the FORGE.md now. Use only the information above. Output raw markdown only — no preamble, no explanation, no code fences, no tool calls.

Include these sections (skip any where you have no real information):

## Stack
Languages, frameworks, build tools — one or two lines.

## Workspace Layout
Key directories and what they contain (3-8 entries).

## Key Files
3-6 most important files: entry points, config, core modules.

## Navigation Rules
2-4 rules for where things live in this project.

## Hard Stops
1-3 dangerous operations that need explicit user confirmation before running.

Be specific and factual. Do not invent paths or names not present in the scan results above.`;
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
    options: { auto: boolean } = { auto: false },
  ): Promise<CompactionOutcome> {
    return runCompaction(this.deps, conversationId, options);
  }
}
