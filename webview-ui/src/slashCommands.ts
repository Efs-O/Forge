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
  /**
   * The subcommand this popup row runs, for a command whose host handler takes
   * one. `/approvals reset` and typed `/approvals reset` must reach the host the
   * same way, or picking the row from the menu would list the rules instead of
   * clearing them (`approvalsSlashCommand` below is what the typed form does).
   */
  approvalAction?: 'reset';
}

/**
 * Parse `/approvals` and its one supported subcommand before model dispatch.
 *
 * The command word is matched case-insensitively because the owner typed
 * `/APPROVALS RESET` in the 0.17.117 live test and it went to the model: a
 * command the product has must not depend on the shift key being down. The
 * subcommand word is compared lower-cased for the same reason, while everything
 * a command takes as an argument keeps the case it was typed in.
 */
export function approvalsSlashCommand(
  text: string,
): { commandId: 'approvals'; approvalAction?: 'reset' | 'invalid' } | undefined {
  const trimmed = text.trim();
  if (!/^\/approvals(?:\s|$)/iu.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/u).slice(1);
  return {
    commandId: 'approvals',
    ...(words.length > 0
      ? {
          approvalAction:
            words.length === 1 && words[0]!.toLowerCase() === 'reset' ? 'reset' : 'invalid',
        }
      : {}),
  };
}

/** Parse the target arguments for `/link` without sending the text to a model. */
export function linkSlashCommand(
  text: string,
): { commandId: 'linkAgent'; agentKind?: string; sessionId?: string } | undefined {
  const trimmed = text.trim();
  if (!/^\/link(?:\s|$)/iu.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/u).slice(1);
  return {
    commandId: 'linkAgent',
    ...(words[0] ? { agentKind: words[0] } : {}),
    ...(words.length > 1 ? { sessionId: words.slice(1).join(' ') } : {}),
  };
}

/**
 * A `/word` the composer has no command for, so it can be refused before it
 * reaches the model. An unknown command used to be sent like any prompt: the
 * owner got a whole turn of tokens for a word nothing recognises, and the one
 * thing they needed to know — that the name is wrong — never appeared.
 *
 * Only the FIRST token is judged, and only when it is a slash and letters:
 * `/usr/bin is broken` has a second slash in its first token, so it is prose
 * about a path and still goes to the model. The word is compared against the
 * triggers case-insensitively, exactly as the popup matches it.
 */
export function unknownSlashCommand(
  text: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): { command: string } | undefined {
  const first = text.trim().split(/\s+/u)[0] ?? '';
  const word = /^\/([a-z][a-z-]*)$/iu.exec(first)?.[1];
  if (word === undefined) return undefined;
  const lowered = word.toLowerCase();
  if (commands.some((cmd) => cmd.trigger.toLowerCase() === lowered)) return undefined;
  // The notice quotes what the owner typed, not the lower-case copy it was
  // matched with: they need to see the name they got wrong.
  return { command: first };
}

/**
 * Every slash command the sidebar offers, in alphabetical order by `trigger` —
 * the text the user actually types after the "/". Nothing downstream depends on
 * the order (`InputRow` filters this list and renders it as-is), so it is free
 * to be the order that makes a command findable in a menu of seventeen. Keep
 * new entries in place rather than appending.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'approvals',
    trigger: 'approvals',
    title: 'Chat Approvals',
    description: 'List this chat’s approvals, or reset them with /approvals reset.',
    availableWhileStreaming: true,
  },
  {
    id: 'approvals',
    trigger: 'approvals reset',
    title: 'Reset Chat Approvals',
    description: 'Forget every approval remembered for this chat.',
    availableWhileStreaming: true,
    approvalAction: 'reset',
  },
  {
    id: 'checkin',
    trigger: 'checkin',
    title: 'Check-in Reminder',
    description: 'Set how many minutes before Forge reminds a long-running task, or turn it off.',
  },
  {
    id: 'clanker',
    trigger: 'clanker',
    title: 'Full Clanker',
    description:
      "Toggle full-auto mode — no confirmation prompts until you run /clanker again. Destructive commands, Forge's own guard files, and sending data out after reading a secret still stop.",
    // An in-memory approval-mode flag that touches no backend state. Mid-turn is
    // exactly when it is wanted: the agent is asking for confirmations now.
    availableWhileStreaming: true,
  },
  {
    id: 'clearChat',
    trigger: 'clear',
    title: 'Clear Active Chat',
    description: 'Clear messages in the active tab only (tabs stay open).',
  },
  {
    id: 'compact',
    trigger: 'compact',
    title: 'Compact Chat',
    description: 'Summarize the active chat and replace it with a compact context summary.',
  },
  {
    id: 'config',
    trigger: 'config',
    title: 'Open Config',
    description: 'Open the active Forge config.yaml.',
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
    id: 'initForge',
    trigger: 'init',
    title: 'Init',
    description: 'Have the agent read this repository and fill in its FORGE.md.',
  },
  {
    id: 'initForge',
    trigger: 'initForge',
    title: 'Init Forge',
    description: 'Same as /init.',
  },
  {
    id: 'keep',
    trigger: 'keep',
    title: 'Keep Changes',
    description: 'Dismiss pending checkpoint and keep edits.',
  },
  {
    id: 'linkAgent',
    trigger: 'link',
    title: 'Link Agent Session',
    description: 'Link an existing agent session to this chat.',
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
    id: 'newChat',
    trigger: 'new',
    title: 'New Chat',
    description: 'Open a new conversation tab.',
    availableWhileStreaming: true,
  },
  {
    id: 'reindex',
    trigger: 'reindex',
    title: 'Reindex Codebase',
    description: 'Rebuild the local semantic search index for search_codebase.',
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
    id: 'rename',
    trigger: 'rename',
    title: 'Rename Conversation',
    description: 'Set the active conversation title.',
    availableWhileStreaming: true,
  },
  {
    id: 'restartBackend',
    trigger: 'restart',
    title: 'Restart Backend',
    description: 'Start or reconnect the llama-server connection.',
  },
  {
    id: 'review',
    trigger: 'review',
    title: 'Review Code',
    description: 'Review the selection, current file, or current changes and run immediately.',
  },
  {
    id: 'chatMode',
    trigger: 'chatMode',
    title: 'Chat Mode',
    description: 'Set solo or multi-chat mode for Strata or llama.cpp.',
  },
  {
    id: 'system',
    trigger: 'system',
    title: 'System Status',
    description: 'Report GPU, VRAM by process, RAM and drive space for this machine.',
    // Reads counters and prints a notice row. It touches nothing the turn owns,
    // and mid-turn — when the agent is holding the VRAM — is when it is wanted.
    availableWhileStreaming: true,
  },
  {
    id: 'undo',
    trigger: 'undo',
    title: 'Undo Last Turn',
    description: 'Restore files from the last checkpoint (same as Keep/Undo flow).',
  },
  {
    id: 'unloadModel',
    trigger: 'unload',
    title: 'Unload Model',
    description: "Release this chat's model and stop its configured server; other models stay.",
  },
  {
    id: 'unloadAll',
    trigger: 'unloadall',
    title: 'Unload All Models',
    description: 'Unload every model and stop configured servers in this window.',
  },
];
