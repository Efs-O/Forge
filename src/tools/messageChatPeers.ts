/**
 * The other Forge windows on this machine, as a chat sees them.
 *
 * Discovery is disk-based and never cached: `~/.forge/agent-bus/endpoints/*.json`
 * names the live windows, each file carrying that window's url and its own
 * bearer token, and a dead pid is skipped before a socket is opened. Every call
 * re-reads disk, because a window that reloads comes back with a new window id
 * and a new token, and a cached list would keep posting to the one that went
 * away.
 *
 * Auth is possession of that window's token — the same trust `forge.sh` already
 * runs on. It is same-machine trust, not proof of who is asking: any process
 * that can read the bus folder holds every window's token. What a peer request
 * has to get right is the chat id it names, because a message that lands in the
 * wrong chat costs the owner a paid turn, so `postPeerMessage` will not build a
 * request that leaves the chat unnamed.
 */
import { z } from 'zod';
import * as path from 'path';
import type { ChatsReport, ChatsReportChat, PeerViewReport } from '../backend/agentChatReadRoute';
import { MAX_INBOUND_CHARS } from '../agentBus/busContent';
import { getSelfWindow } from '../agentBus/selfWindow';
import { liveWindowEndpoints } from '../agentBus/windowEndpoints';
import {
  PEER_READ_LIMIT_MS,
  PEER_WRITE_LIMIT_MS,
  peerRequest,
  type PeerAnswer,
} from '../agentBus/peerHttp';
import type { ForgeConfig } from '../config/types';
import type { ChatRef } from './chatMessageResolver';

/** The last segment of a window's folder, the way `list` prints it and the way a
 *  `window` is named. `path.win32` on purpose, whatever platform this is: a
 *  peer's path arrives in whatever shape that window's platform wrote it, and
 *  only the Windows rules treat `\` as a separator — on Ubuntu, splitting
 *  `N:\repo\b` by hand would name the whole path, not `b`. */
export function folderName(workspace: string): string {
  return path.win32.basename(workspace.replace(/[\\/]+$/u, '')) || workspace;
}

/** Where this window lives on the bus. Undefined while the bus is off. */
export interface PeerContext {
  busRoot: string;
  windowId: string;
  workspaceRoot: string;
}

/** A reachable peer window, and the chats it just reported. */
export interface PeerWindow {
  windowId: string;
  url: string;
  token: string;
  workspace: string;
  models: string[];
  chats: ChatsReportChat[];
}

/** A peer chat, in the shape the local resolver and guards already accept, plus
 *  the window that holds it. The guards run on this unchanged, which is why the
 *  peer's `/agent/chats` carries `awaitingApproval` and the chain epoch. */
export interface PeerChatRef extends ChatRef {
  peer: PeerWindow;
}

/** A window that was listed but would not answer, and what it said. */
export interface UnreachableWindow {
  windowId: string;
  url: string;
  reason: string;
}

/** `from` is validated as 1-40 characters of letters, digits, space and `. _ -`,
 *  so the sender label has to fit inside that — prefix included. */
const LABEL_LIMIT = 40;
const LABEL_PREFIX = 'peer ';

/** This window's bus address, or nothing while the bus is off. Off here means
 *  `message_chat` keeps the single-window behaviour it had before cross-window
 *  messaging existed, down to the byte-for-byte `list` output. */
export function peerContextFor(getConfig?: () => ForgeConfig | undefined): PeerContext | undefined {
  const self = getSelfWindow();
  if (!self) return undefined;
  if (getConfig?.()?.agent_bus?.enabled !== true) return undefined;
  return { busRoot: self.busRoot, windowId: self.windowId, workspaceRoot: self.workspaceRoot };
}

function normalizeFolder(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** A peer's `GET /agent/chats` answer, checked before it is trusted. A peer on
 *  another Forge build can answer anything at all, and one missing field would
 *  otherwise throw halfway through discovery and take every other window with
 *  it; a peer whose report cannot be read is reported, not crashed on. */
const ChatsReportSchema = z.object({
  windowId: z.string().default(''),
  // A window with no folder open reports an empty workspace. `.min(1)` used to
  // reject that whole report, so such a window showed up as "answered with a chat
  // list this Forge could not read" and could not be addressed at all (BUG-26).
  workspace: z.string().default(''),
  models: z.array(z.string()).default([]),
  // `chats` stays required, with no default: that is what tells a real window that
  // merely has no folder open (it always sends a list, even an empty one) from one
  // answering `{}`, which is reported as unreadable instead of listed as a peer
  // with nothing in it.
  chats: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().default(''),
      running: z.boolean().default(false),
      closed: z.boolean().default(false),
      awaitingApproval: z.boolean().default(false),
      userIntentEpoch: z.number().int().optional(),
      model: z.string().optional(),
    }),
  ),
});

/** One chat as this window read it off a peer's wire: the schema's own shape,
 *  which differs from the report type only in that an optional key the peer
 *  omitted may arrive as an explicit `undefined`. */
type ReadChat = z.infer<typeof ChatsReportSchema>['chats'][number];

/** Every live window that is not this one, with the chats each reports.
 *
 *  A window on the same folder is dropped rather than listed: two windows on one
 *  folder share one chat store, so their chats are the same records, and showing
 *  them twice would offer the same chat under two windows. That check needs the
 *  report, since an endpoint file carries no folder — so it happens after the
 *  read, and a peer that cannot answer is reported instead of guessed at. */
export async function discoverPeers(
  ctx: PeerContext,
  signal?: AbortSignal,
): Promise<{ peers: PeerWindow[]; unreachable: UnreachableWindow[] }> {
  const endpoints = liveWindowEndpoints(ctx.busRoot, ctx.windowId);
  const peers: PeerWindow[] = [];
  const unreachable: UnreachableWindow[] = [];
  await Promise.all(
    endpoints.map(async (endpoint) => {
      const answer = await peerRequest<ChatsReport>(
        'GET',
        endpoint,
        '/agent/chats',
        undefined,
        PEER_READ_LIMIT_MS,
        signal,
      );
      if (!answer.ok) {
        unreachable.push({ windowId: endpoint.windowId, url: endpoint.url, reason: answer.error });
        return;
      }
      const parsed = ChatsReportSchema.safeParse(answer.value);
      if (!parsed.success) {
        unreachable.push({
          windowId: endpoint.windowId,
          url: endpoint.url,
          reason: 'answered with a chat list this Forge could not read',
        });
        return;
      }
      const report = parsed.data;
      // Two windows on one folder share one chat store, so that one is dropped.
      // A window with no folder shares no chat store with anything, so it is kept
      // even though this window's own folder is a real one (BUG-26).
      if (
        report.workspace.trim() &&
        normalizeFolder(report.workspace) === normalizeFolder(ctx.workspaceRoot)
      )
        return;
      peers.push({
        windowId: report.windowId || endpoint.windowId,
        url: endpoint.url,
        token: endpoint.token,
        workspace: report.workspace,
        models: report.models,
        // Written field by field, not spread: a peer that omitted an optional
        // key is copied without it, so an absent epoch never arrives as an
        // explicit `undefined` for the steer guard to compare against.
        chats: report.chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          running: chat.running,
          closed: chat.closed,
          awaitingApproval: chat.awaitingApproval,
          ...(chat.userIntentEpoch !== undefined ? { userIntentEpoch: chat.userIntentEpoch } : {}),
          ...(chat.model !== undefined ? { model: chat.model } : {}),
        })),
      });
    }),
  );
  return { peers, unreachable };
}

/** The peer chat as a local `ChatRef`, so every existing guard runs on it as
 *  written. No position: a peer chat has no tab here. */
export function peerChatRef(peer: PeerWindow, chat: ReadChat): PeerChatRef {
  return {
    id: chat.id,
    title: chat.title,
    position: 0,
    running: chat.running,
    ...(chat.closed ? { closed: true } : {}),
    ...(chat.model ? { model: chat.model } : {}),
    // The two facts the steer guards need, carried on the ref so the guards run
    // on a chat in another window exactly as on one in this one.
    ...(chat.awaitingApproval ? { awaitingApproval: true } : {}),
    ...(chat.userIntentEpoch === undefined ? {} : { userIntentEpoch: chat.userIntentEpoch }),
    peer,
  };
}

/** One window's current word on one of its chats, and nothing when it no longer
 *  holds it. A steer is a request to interrupt, so it aims at what the window
 *  says now rather than at a chat list read a few tool calls ago: a chat that
 *  finished, closed, or stopped on a card in between must not be interrupted on
 *  the strength of the old answer. */
export async function refreshPeerChat(
  peer: PeerWindow,
  conversationId: string,
  signal?: AbortSignal,
): Promise<PeerChatRef | undefined> {
  const answer = await peerRequest<ChatsReport>(
    'GET',
    peer,
    '/agent/chats',
    undefined,
    PEER_READ_LIMIT_MS,
    signal,
  );
  if (!answer.ok) return undefined;
  const parsed = ChatsReportSchema.safeParse(answer.value);
  if (!parsed.success) return undefined;
  const needle = conversationId.toLowerCase();
  const chat = parsed.data.chats.find((candidate) => candidate.id.toLowerCase() === needle);
  if (!chat) return undefined;
  return peerChatRef({ ...peer, workspace: parsed.data.workspace }, chat);
}

/** The `from` a peer request carries. The prefix keeps a chat's label out of the
 *  four names a window routes by session — `claude`, `codex`, `copilot`, `forge`
 *  — so a peer chat can never take over a window's name-based CLI targeting. */
export function chatLabel(title: string): string {
  const cleaned = title
    .replace(/[^0-9A-Za-z ._-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, LABEL_LIMIT - LABEL_PREFIX.length)
    .trim();
  return `${LABEL_PREFIX}${cleaned || 'chat'}`;
}

/** The first thing a peer chat sees: who wrote, and where to answer. The id is
 *  the address, so a reply still lands in the sending chat after that window
 *  reloads — new window id, same chat id. */
export function peerPrompt(
  sender: { id: string; title: string },
  workspaceRoot: string,
  text: string,
): string {
  const folder = folderName(workspaceRoot);
  const quoted = sender.title.replace(/["`]/gu, "'");
  return (
    `From Forge chat "${quoted}" (${sender.id}) in ${folder}. ` +
    `Reply with message_chat {"action":"send","to":"${sender.id}"}.` +
    `\n\n${text}`
  );
}

/** How a window is named in a refusal: the folder the caller can recognise, and
 *  the short id `list` prints for a window that would not answer. */
export function windowLabel(peer: PeerWindow): string {
  return `${windowName(peer.workspace)} (${peer.windowId.slice(0, 8)})`;
}

/** A window with no folder open has no folder name to print; an empty one used
 *  to render as a blank label, leaving the id as the only way to tell them apart. */
export const NO_FOLDER_LABEL = 'no folder';

function windowName(workspace: string): string {
  return workspace.trim() ? folderName(workspace) : NO_FOLDER_LABEL;
}

/** The label the reachable-window list prints and callers can pass back. */
export function peerWindowListLabel(peer: PeerWindow): string {
  return peer.workspace.trim()
    ? `${folderName(peer.workspace)} (${peer.workspace})`
    : `${NO_FOLDER_LABEL} (window ${peer.windowId.slice(0, 8)})`;
}

/** The window a `new` is aimed at: any name this tool prints, or the full id.
 * A unique id prefix is accepted because refusals print one; ambiguity remains
 * a refusal, never a guess that could open a paid turn in the wrong window. */
export function matchPeerWindow(
  peers: PeerWindow[],
  wanted: string,
): { peer: PeerWindow } | { refusal: string } {
  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/[\\/]+$/u, '')
      .replace(/\\/gu, '/')
      .toLowerCase();
  const needle = normalize(wanted);
  if (!needle)
    return {
      refusal: 'Error: `window` needs a value: a folder name, a full folder, or a window id.',
    };
  const matches = peers.filter((peer) => {
    const idPrefix = peer.windowId.slice(0, 8);
    return [
      windowName(peer.workspace),
      peer.workspace,
      peer.windowId,
      idPrefix,
      peerWindowListLabel(peer),
      windowLabel(peer),
    ].some((label) => normalize(label) === needle);
  });
  if (matches.length === 1) return { peer: matches[0] as PeerWindow };
  if (matches.length === 0)
    return {
      refusal: `Error: no other Forge window matches "${wanted}"${
        peers.length === 0
          ? ' — no other window is answering from here'
          : `; the windows here are ${peers.map(windowLabel).join(', ')}`
      }. Nothing was created and no counter was used.`,
    };
  return {
    refusal: `Error: "${wanted}" matches more than one window (${matches
      .map(windowLabel)
      .join(
        ', ',
      )}); name the folder in full or the window id. Nothing was created and no counter was used.`,
  };
}

/** The window a `new` names, with this window's folder (the prompt names it, so
 *  the new chat knows where to answer). The bus-off case is its own refusal:
 *  "no window matches" would be the wrong answer — none is reachable at all. */
export async function peerWindowTarget(
  wanted: string,
  ctx: PeerContext | undefined,
  list: typeof discoverPeers,
  signal?: AbortSignal,
): Promise<{ peer: PeerWindow; selfWorkspace: string } | { refusal: string }> {
  if (!ctx)
    return {
      refusal:
        'Error: `window` needs the agent bus on in this window: set `agent_bus.enabled: true` in .forge/config.yaml of both windows. Nothing was created and no counter was used.',
    };
  const match = matchPeerWindow((await list(ctx, signal)).peers, wanted);
  return 'peer' in match ? { peer: match.peer, selfWorkspace: ctx.workspaceRoot } : match;
}

/** Post to a peer's inbox. A request that does not name a chat is refused here,
 *  in code, rather than relying on a caller to remember: without an id the
 *  receiving window falls back to routing by sender name, which is how a steer
 *  ends up interrupting somebody else's turn. */
export async function postPeerMessage(
  peer: PeerWindow,
  query: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<PeerAnswer<Record<string, unknown>>> {
  if (query['conversation_id'] === undefined && query['new_chat'] === undefined) {
    return {
      ok: false,
      status: 0,
      error: 'a peer request must name its chat: conversation_id or new_chat',
    };
  }
  const search = new URLSearchParams(query).toString();
  return peerRequest<Record<string, unknown>>(
    'POST',
    peer,
    `/agent/message?${search}`,
    body,
    PEER_WRITE_LIMIT_MS,
    signal,
  );
}

/** Read one peer chat's recent answers. Read-only by construction: that route
 *  answers from the window's transcript and writes nothing, and the exchanges
 *  travel raw so the sender renders them with the same function it renders its
 *  own chats with — one format whoever answered. They are checked before they
 *  are rendered: a window that answers with something else is reported as a
 *  failed read, not thrown at the caller as an unhandled error mid-turn. */
const PeerViewReportSchema = z.object({
  windowId: z.string().default(''),
  // Same as the chat list above: a window with no folder open reports an empty
  // workspace, and `view` must still read its transcript (BUG-26).
  workspace: z.string().default(''),
  conversationId: z.string().min(1),
  title: z.string().default(''),
  closed: z.boolean().default(false),
  streaming: z.boolean().default(false),
  // Not defaulted: "this is all there was" and "the rest did not fit" are the
  // two different answers the note text makes, and a window that could not say
  // which is a transcript this Forge cannot report honestly.
  clamped: z.boolean(),
  // Required, and not defaulted to empty: a window that answered with something
  // other than a transcript is a failed read, not a chat with no answers yet.
  exchanges: z.array(z.object({ prompt: z.string(), answer: z.string() })),
});

export async function getPeerView(
  peer: PeerWindow,
  conversationId: string,
  count: number,
  signal?: AbortSignal,
): Promise<PeerAnswer<PeerViewReport>> {
  const answer = await peerRequest<PeerViewReport>(
    'GET',
    peer,
    `/agent/peer-view?conversation_id=${encodeURIComponent(conversationId)}&count=${count}`,
    undefined,
    PEER_READ_LIMIT_MS,
    signal,
  );
  if (!answer.ok || answer.status !== 200) return answer;
  const parsed = PeerViewReportSchema.safeParse(answer.value);
  if (!parsed.success)
    return {
      ok: false,
      status: 200,
      error: 'it answered with a transcript this Forge could not read',
    };
  // The id comes back because it is the only proof the transcript is for the chat
  // this was asked about: a window that answered for another chat would render
  // someone else's answers under this chat's name.
  if (parsed.data.conversationId.toLowerCase() !== conversationId.toLowerCase())
    return {
      ok: false,
      status: 200,
      error: `it answered for a different chat (${parsed.data.conversationId})`,
    };
  return { ...answer, value: parsed.data };
}

/** The cap a peer message must fit inside. Local sends allow more; the bus does
 *  not, and refusing here says so before anything is posted. */
export const PEER_MESSAGE_LIMIT = MAX_INBOUND_CHARS;

/** The `Other windows:` half of `list`, and the honest note about a window that
 *  was listed but would not answer. Empty string when there are no peers, so a
 *  single-window machine keeps printing exactly what it printed before. */
export function formatPeerSection(peers: PeerWindow[], unreachable: UnreachableWindow[]): string {
  if (peers.length === 0 && unreachable.length === 0) return '';
  const lines: string[] = ['', 'Other windows:'];
  for (const peer of peers) {
    lines.push(`${peerWindowListLabel(peer)} — ${peer.chats.length} chat(s):`);
    const ordered = [
      ...peer.chats.filter((chat) => !chat.closed),
      ...peer.chats.filter((chat) => chat.closed),
    ];
    for (const chat of ordered) {
      const state = chat.closed ? 'closed' : chat.running ? 'running' : 'idle';
      const model = chat.model ? ` · ${chat.model}` : '';
      lines.push(`  ${chat.title} · ${state}${model} · id ${chat.id}`);
    }
  }
  if (unreachable.length > 0) {
    lines.push(
      `Not reachable: ${unreachable
        .map((entry) => `${entry.windowId.slice(0, 8)} (${entry.reason})`)
        .join('; ')}.`,
    );
  }
  lines.push('Address a chat in another window by its id; `#N` is this window only.');
  return lines.join('\n');
}
