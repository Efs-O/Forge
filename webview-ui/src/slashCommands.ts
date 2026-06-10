import type { ForgeSlashCommandId } from '../../src/sidebar/messageBridge';

export interface SlashCommand {
  id: ForgeSlashCommandId;
  trigger: string;
  title: string;
  description: string;
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
  },
  {
    id: 'initForge',
    trigger: 'initForge',
    title: 'Init Forge',
    description: 'Scan this workspace and generate a FORGE.md agent instructions file.',
  },
  {
    id: 'clanker',
    trigger: 'clanker',
    title: 'Full Clanker',
    description: 'Toggle full-auto mode — no confirmation prompts until you run /clanker again. Recursive deletes still confirm.',
  },
];
