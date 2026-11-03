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

/** Reads every chat this workspace knows, as the filter wants it. */
export function readRetitleRecords(dirs: RetitleDirs): RetitleConversation[] {
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
  /** The two lines a title would be asked from, from a stored body. */
  const linesOfBody = (
    body: ConversationPersisted | undefined,
  ): { firstUserLine?: string; lastAssistantLine?: string } => {
    const firstUserLine = body ? firstUserLineOf(body.messages) : undefined;
    const lastAssistantLine = body ? lastAssistantLineOf(body.messages) : undefined;
    return {
      ...(firstUserLine ? { firstUserLine } : {}),
      ...(lastAssistantLine ? { lastAssistantLine } : {}),
    };
  };
  const add = (
    id: string,
    record: {
      title: string;
      updatedAt: number;
      titleSource?: 'prompt' | 'user' | 'auto';
      firstUserLine?: string;
      lastAssistantLine?: string;
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
      ...(record.lastAssistantLine ? { lastAssistantLine: record.lastAssistantLine } : {}),
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
    if (row.title_source === 'user' || row.title_source === 'auto') continue;
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

function firstUserLineOf(messages: SlimMessages): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message);
    if (text?.trim()) return text.split('\n')[0]?.trim();
  }
  return undefined;
}

function lastAssistantLineOf(messages: SlimMessages): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = textOf(message);
    if (text?.trim()) return text.split('\n')[0]?.trim();
  }
  return undefined;
}

/** First user line and last answer from a session log (a `source:'log'` row). */
function readLogContent(
  file: string,
): { firstUserLine?: string; lastAssistantLine?: string } | undefined {
  let rows;
  try {
    rows = readSessionLogRows(file);
  } catch {
    return undefined;
  }
  const lineOf = (role: string, from: 'first' | 'last'): string | undefined => {
    const matches = (from === 'first' ? rows : [...rows].reverse()).filter(
      (row) => row['role'] === role && typeof row['content'] === 'string',
    );
    const row = matches[0];
    const text = row ? String(row['content']) : '';
    return text.trim() ? text.split('\n')[0]?.trim() : undefined;
  };
  const firstUserLine = lineOf('user', 'first');
  const lastAssistantLine = lineOf('assistant', 'last');
  return {
    ...(firstUserLine ? { firstUserLine } : {}),
    ...(lastAssistantLine ? { lastAssistantLine } : {}),
  };
}
