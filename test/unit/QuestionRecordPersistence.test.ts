import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationBodyStore } from '../../src/sidebar/ConversationBodyStore';
import { createDefaultSession, runtimeToPersisted } from '../../src/sidebar/sessionTypes';
import { getLogger } from '../../src/util/logger';

describe('display question record persistence', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a conversation when one display record is malformed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-question-record-'));
    directories.push(directory);
    const session = createDefaultSession();
    const conversation = session.conversations[0]!;
    conversation.id = 'chat-question-record';
    conversation.messages = [{ role: 'user', content: 'This message must survive.' }];
    const body = JSON.parse(
      JSON.stringify(runtimeToPersisted(session).conversations[0]),
    ) as Record<string, unknown>;
    const options = Array.from({ length: 10 }, (_value, index) => ({
      label: `Option ${index}`.padEnd(90, 'x'),
      description: 'Long description '.repeat(30),
      addedLater: true,
    }));
    body['display_question_records'] = [
      {
        toolCallId: 'call-valid',
        record: {
          specs: [
            {
              prompt: 'Which option?',
              header: 'Header added without the old limit',
              multiSelect: false,
              options,
              addedLater: 'ignored by an older reader',
            },
          ],
          answer: { answers: [{ picks: [9], note: 'Note '.repeat(900) }] },
          addedLater: true,
        },
      },
      {
        toolCallId: 'call-malformed',
        record: {
          specs: [{ prompt: 'Which?', multiSelect: false, options: [{ label: 'Only' }] }],
          answer: { answers: [{ picks: [8] }] },
        },
      },
    ];
    fs.writeFileSync(path.join(directory, `${conversation.id}.json`), JSON.stringify(body));
    const warning = vi.spyOn(getLogger(), 'warn');

    const loaded = new ConversationBodyStore(directory, 'Open conversations').load(() => 'sig');

    expect(loaded).toHaveLength(1);
    expect(loaded?.[0]?.id).toBe(conversation.id);
    expect(loaded?.[0]?.messages).toMatchObject([
      { role: 'user', content: 'This message must survive.' },
    ]);
    expect(loaded?.[0]?.display_question_records).toHaveLength(1);
    expect(loaded?.[0]?.display_question_records?.[0]?.toolCallId).toBe('call-valid');
    expect(loaded?.[0]?.display_question_records?.[0]?.record.specs[0]?.options).toHaveLength(10);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain('chat-question-record');
    expect(warning.mock.calls[0]?.[0]).toContain('call-malformed');
    expect(fs.readdirSync(directory)).toEqual(['chat-question-record.json']);
  });
});
