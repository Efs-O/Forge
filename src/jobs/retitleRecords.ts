/**
 * The read side of the `retitle` job: every chat this workspace knows, shaped
 * the way `retitleCandidates.ts` wants it. Split out of `retitleRun.ts` because
 * the two halves change for different reasons — this one for where the stores
 * live and what a stored body holds, that one for the gates, the ask and the
 * report — and the runner had run into the repo's 500-line stop.
 *
 * Nothing here reads the live sidebar. The job runs while the owner is doing
 * something else, so it decides from the store files, which is also the only
 * way it can see the archived chats whose bodies are session logs
 * (docs/plans/V1_FINISH_PLAN.md lane 4 phase 2).
 */
import * as fs from 'fs';
import * as path from 'path';
import { conversationPersistedSchema, type ConversationPersisted } from '../sidebar/sessionTypes';
import { readSessionLogRows } from '../sessions/sessionLogRows';
import { OPEN_BODIES_DIR, HISTORY_BODIES_DIR } from '../sidebar/HistoryArchive';
import { ARCHIVE_BODIES_DIR, ArchivedSessions } from '../sidebar/ArchivedSessions';
import type { RetitleConversation } from './retitleCandidates';

/** Where this workspace's conversation stores live. */
export interface RetitleDirs {
  /** The extension storage folder: `open/`, `history/`, `archive/` sit under it. */
  storageDir: string;
  /** `~/.forge/sessions`, for archive rows whose body is the session log. */
  logsDirectory: string;
}

/**
 * Reads every chat this workspace knows, as the filter wants it.
 *
 * `reassessIds` is the owner's list of chats the job already named and wants
 * named again. It only matters for the archive, whose rows are skipped before
 * their content is read — without it a re-ask would never see an archived chat.
 */
export function readRetitleRecords(
  dirs: RetitleDirs,
  options: { reassessIds?: ReadonlySet<string> } = {},
): RetitleConversation[] {
  const found = new Map<string, RetitleConversation>();
  const readBody = (file: string): ConversationPersisted | undefined => {
    try {
      const parsed = conversationPersistedSchema.safeParse(
        JSON.parse(fs.readFileSync(file, 'utf8')),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      // An unreadable or half-written body says nothing; the row is skipped.
      return undefined;
    }
  };
  /** What a title is asked from, from a stored body: the opening line the filter
   *  needs to tell a prompt-name from a person's name, and the two passages the
   *  model is actually shown. */
  const linesOfBody = (
    body: ConversationPersisted | undefined,
  ): Pick<RetitleConversation, 'firstUserLine' | 'firstUserText' | 'lastAssistantText'> => {
    if (!body) return {};
    const firstUser = firstUserOf(body.messages);
    const lastAssistant = lastAssistantOf(body.messages);
    return {
      ...(firstUser.line ? { firstUserLine: firstUser.line } : {}),
      ...(firstUser.text ? { firstUserText: firstUser.text } : {}),
      ...(lastAssistant ? { lastAssistantText: lastAssistant } : {}),
    };
  };
  const add = (
    id: string,
    record: {
      title: string;
      updatedAt: number;
      titleSource?: 'prompt' | 'user' | 'auto';
      firstUserLine?: string;
      firstUserText?: string;
      lastAssistantText?: string;
      open: boolean;
    },
  ): void => {
    found.set(id, {
      id,
      title: record.title,
      updatedAt: record.updatedAt,
      open: record.open,
      ...(record.titleSource ? { titleSource: record.titleSource } : {}),
      ...(record.firstUserLine ? { firstUserLine: record.firstUserLine } : {}),
      ...(record.firstUserText ? { firstUserText: record.firstUserText } : {}),
      ...(record.lastAssistantText ? { lastAssistantText: record.lastAssistantText } : {}),
    });
  };

  // Open chats are skipped by the filter whatever their title, so this only
  // needs the directory listing: the ids are the point, and reading every open
  // body to throw it away would be the expensive half of the scan for nothing.
  for (const id of listJsonNames(path.join(dirs.storageDir, OPEN_BODIES_DIR))) {
    add(id, { title: '', updatedAt: 0, open: true });
  }
  for (const id of listJsonNames(path.join(dirs.storageDir, HISTORY_BODIES_DIR))) {
    const body = readBody(path.join(dirs.storageDir, HISTORY_BODIES_DIR, `${id}.json`));
    if (!body) continue;
    add(id, {
      title: body.title,
      updatedAt: body.updatedAt,
      open: false,
      ...(body.title_source ? { titleSource: body.title_source } : {}),
      ...linesOfBody(body),
    });
  }

  // The overflow archive. Its index rows are the cheap path, and a row whose
  // name a person typed or the job already gave is skipped before any content
  // is read, so a run that will rename little reads little. The logs directory
  // is passed in because a job runs in whichever window holds the scheduler
  // lease, and that folder is the machine's, not the workspace's.
  const archive = new ArchivedSessions(dirs.storageDir, undefined, dirs.logsDirectory);
  for (const row of archive.list()) {
    if (found.has(row.id)) continue;
    // A name a person typed is never touched, so its content is never read. A
    // name the job gave is skipped the same way — except for the ids the owner
    // asked to have named again, which are the whole point of that pass.
    if (row.title_source === 'user') continue;
    if (row.title_source === 'auto' && !options.reassessIds?.has(row.id)) continue;
    const lines =
      row.source === 'log'
        ? readLogContent(path.join(dirs.logsDirectory, `${row.id}.jsonl`))
        : linesOfBody(readBody(path.join(dirs.storageDir, ARCHIVE_BODIES_DIR, `${row.id}.json`)));
    add(row.id, {
      title: row.title,
      updatedAt: row.updatedAt,
      open: false,
      ...(row.title_source ? { titleSource: row.title_source } : {}),
      ...lines,
    });
  }
  return [...found.values()];
}

function listJsonNames(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

type SlimMessages = ConversationPersisted['messages'];

/** The text of a stored message. A stored body keeps plain text, not parts. */
function textOf(message: SlimMessages[number]): string | undefined {
  return typeof message.content === 'string' ? message.content : undefined;
}

const RETITLE_READ_CAP_CHARS = 6000;

function capText(text: string): string {
  return text.length > RETITLE_READ_CAP_CHARS ? text.slice(0, RETITLE_READ_CAP_CHARS) : text;
}

function firstLineOf(text: string): string | undefined {
  return text.split('\n')[0]?.trim() || undefined;
}

/**
 * The opening prompt, both ways it is used: its first line, which the filter
 * compares against the stored title to tell a prompt-name from a person's name,
 * and its whole text, which is what the model is asked to name the chat from.
 * They come from the same message so they cannot drift apart.
 *
 * The first line alone was not enough. A long session opens with "continue" or
 * "commit and push", and a title taken from that names the bookkeeping, not the
 * work (owner review of the first 150 applied titles, 2026-11-06).
 */
function firstUserOf(messages: SlimMessages): {
  line?: string;
  text?: string;
} {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message)?.trim();
    if (!text) continue;
    const line = firstLineOf(text);
    return { ...(line ? { line } : {}), text: capText(text) };
  }
  return {};
}

/** The closing answer in full: its first line is usually a restatement of the
 *  instruction, so the whole answer is what carries the subject. */
function lastAssistantOf(messages: SlimMessages): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = textOf(message)?.trim();
    if (!text) continue;
    return capText(text);
  }
  return undefined;
}

/** Opening prompt and closing answer from a session log (a `source:'log'` row). */
function readLogContent(
  file: string,
): { firstUserLine?: string; firstUserText?: string; lastAssistantText?: string } | undefined {
  let rows;
  try {
    rows = readSessionLogRows(file);
  } catch {
    return undefined;
  }
  const textOfRow = (role: string, from: 'first' | 'last'): string | undefined => {
    const matches = (from === 'first' ? rows : [...rows].reverse()).filter(
      (row) => row['role'] === role && typeof row['content'] === 'string',
    );
    const row = matches[0];
    const text = row ? String(row['content']).trim() : '';
    return text ? capText(text) : undefined;
  };
  const firstUserText = textOfRow('user', 'first');
  const firstUserLine = firstUserText ? firstLineOf(firstUserText) : undefined;
  const lastAssistantText = textOfRow('assistant', 'last');
  return {
    ...(firstUserLine ? { firstUserLine } : {}),
    ...(firstUserText ? { firstUserText } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
  };
}
