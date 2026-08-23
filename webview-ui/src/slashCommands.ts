import type { ForgeSlashCommandId } from '../../src/sidebar/messageBridge';

export interface SlashCommand {
  id: ForgeSlashCommandId;
  trigger: string;
  title: string;
  description: string;
  /**
   * Safe to run without changing the active turn or its backend resources.
   *
   * Everything else is still LISTED while a turn streams, just disabled — the
   * host guards refuse them anyway (`/compact` and `/clear` no-op while
   * streaming, `/review` errors), and several would corrupt the turn outright:
   * `/unload` and `/restart` stop the server mid-stream, `/undo` and `/keep`
   * move files the agent is still writing.
   */
  availableWhileStreaming?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'unloadModel',
    trigger: 'unload',
    title: 'Unload Model',
    description: 'Stop the backend and release the active model from memory.',
  },
  {
    id: 'restartBackend',
    trigger: 'restart',
    title: 'Restart Backend',
    description: 'Start or reconnect the llama-server connection.',
  },
  {
    id: 'reindex',
    trigger: 'reindex',
    title: 'Reindex Codebase',
    description: 'Rebuild the local semantic search index for search_codebase.',
  },
  {
    id: 'newChat',
    trigger: 'new',
    title: 'New Chat',
    description: 'Open a new conversation tab.',
    availableWhileStreaming: true,
  },
  {
    id: 'rename',
    trigger: 'rename',
    title: 'Rename Conversation',
    description: 'Set the active conversation title.',
    availableWhileStreaming: true,
  },
  {
    id: 'context',
    trigger: 'context',
    title: 'Add Context',
    description: 'Choose a file, selection, open tabs, or files for the next answer.',
    availableWhileStreaming: true,
  },
  {
    id: 'config',
    trigger: 'config',
    title: 'Open Config',
    description: 'Open the active Forge config.yaml.',
    availableWhileStreaming: true,
  },
  {
    id: 'logs',
    trigger: 'logs',
    title: 'Show Logs',
    description: 'Open the Forge backend output channel.',
    availableWhileStreaming: true,
  },
  {
    id: 'clearChat',
    trigger: 'clear',
    title: 'Clear Active Chat',
    description: 'Clear messages in the active tab only (tabs stay open).',
  },
  {
    id: 'review',
    trigger: 'review',
    title: 'Review Code',
    description: 'Review the selection, current file, or current changes and run immediately.',
  },
  {
    id: 'compact',
    trigger: 'compact',
    title: 'Compact Chat',
    description: 'Summarize the active chat and replace it with a compact context summary.',
  },
  {
    id: 'undo',
    trigger: 'undo',
    title: 'Undo Last Turn',
    description: 'Restore files from the last checkpoint (same as Keep/Undo flow).',
  },
  {
    id: 'keep',
    trigger: 'keep',
    title: 'Keep Changes',
    description: 'Dismiss pending checkpoint and keep edits.',
  },
  {
    id: 'reloadWindow',
    trigger: 'reload',
    title: 'Reload Window',
    description: 'Run Reload Window (reloads Cursor / VS Code).',
    // Ends the turn by design, and works regardless of what the agent is doing.
    availableWhileStreaming: true,
  },
  {
    id: 'initForge',
    trigger: 'initForge',
    title: 'Init Forge',
    description: 'Scan this workspace and generate an AGENTS.md instructions file.',
  },
  {
    id: 'clanker',
    trigger: 'clanker',
    title: 'Full Clanker',
    description:
      'Toggle full-auto mode — no confirmation prompts until you run /clanker again. Recursive deletes still confirm.',
    // An in-memory approval-mode flag that touches no backend state. Mid-turn is
    // exactly when it is wanted: the agent is asking for confirmations now.
    availableWhileStreaming: true,
  },
];
