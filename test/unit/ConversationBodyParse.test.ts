/**
 * A saved chat whose only bad field is its compaction notes must still load.
 *
 * The bound that started this was fixed separately (7036eb38 widened the reader
 * to match the writer); what this file guards is the damage that bound did
 * while it was wrong — four chats thrown away whole because one entry inside
 * `compaction` was too long, next to hundreds of messages that were fine.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationBodyStore } from '../../src/sidebar/ConversationBodyStore';
import { ArchivedSessions } from '../../src/sidebar/ArchivedSessions';
import { parseConversationBody } from '../../src/sidebar/conversationBodyParse';
import { getLogger } from '../../src/util/logger';

/** Longer than the reader's `FIRST_REQUEST_MAX_CHARS + 40` (12 040) cap. */
const TOO_LONG = 'x'.repeat(20000);

const MESSAGES = [
  { role: 'user', content: 'the first message' },
  { role: 'assistant', content: 'the second message' },
];

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chat-keep-me',
    title: 'Keep me',
    createdAt: 1,
    updatedAt: 2,
    messages: MESSAGES,
    ...overrides,
  };
}

const BAD_COMPACTION = {
  summary: 'notes from an earlier round',
  fromIndex: 1,
  userMessages: [TOO_LONG],
};

describe('parseConversationBody', () => {
  it('accepts a valid body and drops nothing', () => {
    const parsed = parseConversationBody(body());
    if (!parsed.ok) throw new Error(`rejected: ${parsed.issue}`);
    expect(parsed.dropped).toBeNull();
    expect(parsed.issue).toBeNull();
    expect(parsed.body.id).toBe('chat-keep-me');
    expect(parsed.body.compaction).toBeUndefined();
  });

  it('keeps every message when only the compaction notes are too long', () => {
    const parsed = parseConversationBody(body({ compaction: BAD_COMPACTION }));
    if (!parsed.ok) throw new Error(`rejected: ${parsed.issue}`);
    expect(parsed.dropped).toBe('compaction');
    expect(parsed.body.messages).toEqual(MESSAGES);
    expect(parsed.body.compaction).toBeUndefined();
    expect(parsed.issue).toContain('userMessages');
  });

  it('refuses a body whose messages are invalid', () => {
    const parsed = parseConversationBody(body({ messages: 'nope' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('accepted an invalid messages field');
    expect(parsed.issue).toContain('messages');
  });

  it('refuses a body missing its id, and one that is not an object', () => {
    const noId = parseConversationBody(body({ compaction: BAD_COMPACTION }));
    delete noId['id'];
    expect(parseConversationBody(noId).ok).toBe(false);
    expect(parseConversationBody('not an object').ok).toBe(false);
    expect(parseConversationBody(null).ok).toBe(false);
    expect(parseConversationBody(MESSAGES).ok).toBe(false);
  });

  it('refuses a body bad somewhere other than compaction', () => {
    const parsed = parseConversationBody(
      body({ messages: 'nope', compaction: BAD_COMPACTION }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe('loading a damaged body from disk', () => {
  let directory: string;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('ConversationBodyStore keeps the chat, its file and a copy of the damage', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-body-parse-'));
    const raw = JSON.stringify(body({ compaction: BAD_COMPACTION }));
    const target = path.join(directory, 'chat-keep-me.json');
    fs.writeFileSync(target, raw);
    const error = vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);

    const loaded = new ConversationBodyStore(directory, 'History').load(() => 'sig');

    expect(loaded?.map((conversation) => conversation.id)).toEqual(['chat-keep-me']);
    expect(loaded?.[0]?.messages).toEqual(MESSAGES);
    expect(loaded?.[0]?.compaction).toBeUndefined();
    // Copied, not renamed: the live body is still where the next save expects it.
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(raw);
    const asides = fs.readdirSync(directory).filter((name) => name.startsWith('chat-keep-me.corrupt-'));
    expect(asides).toHaveLength(1);
    expect(asides[0]).toMatch(/^chat-keep-me\.corrupt-\d+\.json\.bad$/);
    expect(fs.readFileSync(path.join(directory, asides[0]!), 'utf8')).toBe(raw);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('chat-keep-me with its compaction notes dropped'),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('userMessages'));
  });

  it('ConversationBodyStore still quarantines a body whose messages are invalid', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-body-parse-'));
    const target = path.join(directory, 'chat-keep-me.json');
    fs.writeFileSync(target, JSON.stringify(body({ messages: 'nope', compaction: BAD_COMPACTION })));
    vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);

    const loaded = new ConversationBodyStore(directory, 'History').load(() => 'sig');

    expect(loaded).toEqual([]);
    // Renamed away, as before: nothing here is loadable.
    expect(fs.existsSync(target)).toBe(false);
    expect(
      fs
        .readdirSync(directory)
        .some((name) => /^chat-keep-me\.corrupt-\d+\.json\.bad$/.test(name)),
    ).toBe(true);
  });

  it('ArchivedSessions reads the chat and logs the field it dropped', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-archived-parse-'));
    const archive = new ArchivedSessions(directory);
    fs.mkdirSync(archive.directory, { recursive: true });
    fs.writeFileSync(
      path.join(archive.directory, 'chat-keep-me.json'),
      JSON.stringify(body({ compaction: BAD_COMPACTION })),
    );
    fs.writeFileSync(
      path.join(archive.directory, 'index.json'),
      JSON.stringify([
        {
          id: 'chat-keep-me',
          title: 'Keep me',
          createdAt: 1,
          updatedAt: 2,
          messageCount: MESSAGES.length,
          source: 'body',
        },
      ]),
    );
    const error = vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);

    const conversation = archive.read('chat-keep-me');

    expect(conversation?.messages).toEqual(MESSAGES);
    expect(conversation?.compaction).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('chat-keep-me.json'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('compaction notes dropped'));
  });
});
