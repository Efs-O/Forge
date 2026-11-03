import * as vscode from 'vscode';
import { CodexDiscovery, type DiscoveredThread } from '../agentMesh/codexDiscovery';
import { readClaudeSessions, type ClaudeSession } from '../agentBus/claudePeer';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { findBySession, parseAgentIdentity, type AgentKind } from '../agentLinks/chatAgentLinks';
import type { ForgeConfig } from '../config/types';

/**
 * The chat header's 🔗 button and `/link`: after the kind is picked, list the
 * sessions of that kind that belong to this workspace folder, newest first, so
 * the owner picks a name instead of hunting for a 32-character id (owner
 * feedback, 2026-10-27: "if I want to link it to a Claude session I have to
 * somehow find the 329402309fhksk… number"). The raw-id path stays as the last
 * item, because a session this list cannot see — a past Claude transcript, or
 * one started in another folder — can still be linked by id.
 *
 * Only what each lister can really see is offered: Claude Code's own registry
 * of live interactive sessions (`readClaudeSessions`) and the Codex daemon's
 * live thread list (`CodexDiscovery`, the same source `codexThreadIsLive`
 * uses). Copilot has no lister, so it goes straight to the by-hand box.
 *
 * Out of scope on purpose: Claude sessions that are no longer running. Their
 * transcripts live under `~/.claude/projects` and would need a new reader;
 * such a session links itself the first time it messages Forge.
 */

/** The last item of every list, whatever the listing found or failed to find. */
const BY_HAND: vscode.QuickPickItem = {
  label: 'Enter a session ID by hand…',
  description: 'For a session this list cannot see',
};

/** A list item that carries what picking it links: the id, and the name the
 *  chat header shows once the link is stored. */
interface SessionPickItem extends vscode.QuickPickItem {
  sessionId: string;
  title: string;
}

export interface PickedSession {
  sessionId: string;
  /** The session's own name. Absent for the by-hand path, which keeps the id. */
  title?: string;
}

/** What a list needs to know about the window it is listing for. */
export interface SessionListDeps {
  workspaceFolder: string;
  activeConversationId: string;
  conversations: readonly { id: string; title?: string }[];
}

/** Injectable, so a test hands in fakes instead of a real CLI, daemon or registry. */
export interface AgentSessionListers {
  claude?: () => ClaudeSession[];
  codex?: (config: ForgeConfig) => Promise<DiscoveredThread[]>;
}

/** Bound on the throwaway app-server round trip, so a daemon that is not
 *  answering costs the picker a few seconds and a message, not the click. */
const CODEX_DISCOVERY_TIMEOUT_MS = 8_000;

/** Same folder, compared the way the platform does it: Windows paths are
 *  case-insensitive and mix `\` and `/`, POSIX paths are taken literally. */
export function sameFolder(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = (value: string): string => {
    const normalized = value.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/\/$/u, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return Boolean(left && right) && fold(left) === fold(right);
}

/** A session's own name becomes the stored link's title, so it has to fit what
 *  the persisted link schema accepts: one line, at most 200 characters. */
function linkTitle(raw: string, fallback: string): string {
  const oneLine = raw.replace(/[\r\n]+/gu, ' ').trim();
  return (oneLine || fallback).slice(0, 200);
}

/**
 * "20 min ago". The two sources disagree on units by design: Claude Code's
 * registry writes epoch milliseconds and the Codex app-server sends epoch
 * seconds, and the registry is undocumented, so read whichever it is and say
 * nothing when the number is not a plausible date.
 */
function ago(epoch: number | undefined): string {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return '';
  const ms = epoch > 1e11 ? epoch : epoch > 1e9 ? epoch * 1000 : 0;
  if (!ms) return '';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Names the chat that already holds this session, so the row says it before
 *  the owner picks instead of answering afterwards in a dialog. Picking it
 *  still goes through `link()`, which now adds this chat to the session's set
 *  rather than refusing it — so this line names the chat that session last
 *  addressed, which keeps its link and stays reachable with `--to`. */
function alreadyLinkedNote(sessionId: string, deps: SessionListDeps): string | undefined {
  const owner = findBySession(sessionId);
  if (!owner || owner === deps.activeConversationId) return undefined;
  const title = deps.conversations.find((item) => item.id === owner)?.title ?? owner;
  return `linked to chat "${title}"`;
}

function toItem(
  sessionId: string,
  name: string,
  state: string,
  deps: SessionListDeps,
): SessionPickItem {
  const title = linkTitle(name, sessionId);
  const linked = alreadyLinkedNote(sessionId, deps);
  return {
    sessionId,
    title,
    label: title,
    description: state,
    detail: [sessionId, linked].filter(Boolean).join(' · '),
  };
}

/** Claude sessions started in this folder, newest first, skipping the
 *  programmatic (`sdk`) launches the registry reader says never to pick. The
 *  registry itself is already newest-first; sorting here keeps that promise
 *  local to this module instead of inheriting it from an undocumented file. */
export function claudeSessionItems(
  sessions: readonly ClaudeSession[],
  deps: SessionListDeps,
): SessionPickItem[] {
  return sessions
    .filter((session) => !session.sdk && Boolean(session.sessionId?.trim()))
    .filter((session) => sameFolder(session.cwd, deps.workspaceFolder))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((session) => {
      const started = ago(session.startedAt);
      return toItem(
        session.sessionId as string,
        session.name,
        started ? `running · started ${started}` : 'running',
        deps,
      );
    });
}

/** Codex threads started in this folder, newest first. A thread with no
 *  user-facing name is labelled by its first message, which is what the daemon
 *  has; the id appears only when there is nothing else to read. */
export function codexThreadItems(
  threads: readonly DiscoveredThread[],
  deps: SessionListDeps,
): SessionPickItem[] {
  return threads
    .filter((thread) => sameFolder(thread.cwd, deps.workspaceFolder))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((thread) => {
      const updated = ago(thread.updatedAt);
      return toItem(
        thread.id,
        thread.name ?? thread.preview ?? thread.id,
        updated ? `thread · updated ${updated}` : 'thread',
        deps,
      );
    });
}

/** Today's input box, unchanged: it still validates the id against the kind. */
async function byHandInput(kind: AgentKind): Promise<PickedSession | undefined> {
  const sessionId = await vscode.window.showInputBox({
    title: `Link ${kind} session`,
    prompt: 'Enter the session id',
    validateInput: (value) => {
      try {
        parseAgentIdentity(kind, value);
        return undefined;
      } catch {
        return `Enter a valid ${kind} session id.`;
      }
    },
  });
  if (sessionId === undefined) return undefined;
  return { sessionId };
}

async function listCodexThreads(config: ForgeConfig): Promise<DiscoveredThread[]> {
  const executable = await resolveCliExecutable(config.agent_bus?.codex_cli ?? 'codex', 'codex');
  const discovery = new CodexDiscovery({
    executable,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    timeoutMs: CODEX_DISCOVERY_TIMEOUT_MS,
  });
  // `discover()` bounds its own round trip and disposes the throwaway
  // app-server in its `finally`, so nothing here has to clean up after it.
  const { threads } = await discovery.discover();
  return threads;
}

/**
 * Pick a session of this kind, or `undefined` when the owner backs out. A
 * listing that fails says so in the placeholder and still offers the by-hand
 * item, so a broken lister cannot block a link (acceptance criterion 8).
 */
export async function pickAgentSession(
  kind: AgentKind,
  options: { config: ForgeConfig; deps: SessionListDeps; listers?: AgentSessionListers },
): Promise<PickedSession | undefined> {
  const deps = options.deps;
  // Copilot has no lister at all, so it keeps today's behaviour: the box, with
  // nothing to pick first.
  if (kind === 'copilot') return byHandInput(kind);
  let items: SessionPickItem[] = [];
  let problem: string | undefined;
  if (kind === 'claude') {
    const list = options.listers?.claude ?? readClaudeSessions;
    items = claudeSessionItems(list(), deps);
  } else if (kind === 'codex') {
    const discover =
      options.listers?.codex ??
      ((config: ForgeConfig): Promise<DiscoveredThread[]> => listCodexThreads(config));
    const run = async (): Promise<SessionPickItem[]> => {
      try {
        return codexThreadItems(await discover(options.config), deps);
      } catch (error) {
        problem = `Could not list Codex sessions: ${error instanceof Error ? error.message : String(error)}`;
        return [];
      }
    };
    // Discovery spawns a throwaway app-server and can take seconds, so the
    // wait is shown in the window status bar rather than looking like a hang.
    items =
      typeof vscode.window.withProgress === 'function'
        ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: 'Looking for Codex sessions in this folder…',
            },
            run,
          )
        : await run();
  }
  const picked = await vscode.window.showQuickPick([...items, BY_HAND], {
    title: `Link ${kind} session`,
    placeHolder: problem
      ? `${problem}. You can still enter the id by hand.`
      : items.length
        ? 'Pick the session to link, or enter an id by hand'
        : `No running ${kind} session found in this folder. Enter an id by hand.`,
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  const chosen = picked as Partial<SessionPickItem>;
  if (!chosen.sessionId) return byHandInput(kind);
  return {
    sessionId: chosen.sessionId,
    ...(typeof chosen.title === 'string' ? { title: chosen.title } : {}),
  };
}
