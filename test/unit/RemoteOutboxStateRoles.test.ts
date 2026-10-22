import { describe, expect, it } from 'vitest';
import {
  EMPTY_REMOTE_STATE,
  OUTBOX_STATE_ROLE,
  OutboxSchema,
  RemoteStateSchema,
} from '../../src/remote/RemoteStoreSchemas';

describe('outbox state roles', () => {
  it('classifies every Zod state and makes only pending deliverable', () => {
    expect(Object.keys(OUTBOX_STATE_ROLE).sort()).toEqual(
      [...OutboxSchema.shape.state.options].sort(),
    );
    expect(
      Object.entries(OUTBOX_STATE_ROLE)
        .filter(([, role]) => role === 'deliverable')
        .map(([state]) => state),
    ).toEqual(['pending']);
    expect(OUTBOX_STATE_ROLE.sending).toBe('in_flight');
    expect(OUTBOX_STATE_ROLE.delivered).toBe('terminal');
    expect(OUTBOX_STATE_ROLE.abandoned).toBe('terminal');
    expect(OUTBOX_STATE_ROLE.coalesced).toBe('terminal');
  });

  it('parses old outbox records without the optional ephemeral field', () => {
    const record = {
      id: 'outbox-1',
      requestId: 'host-1',
      channel: 'telegram',
      chatId: 'chat-1',
      text: 'older state record',
      state: 'pending',
      attempts: 0,
      updatedAt: 1,
    };
    expect(OutboxSchema.parse(record)).toEqual(record);
    expect(
      RemoteStateSchema.parse({
        ...EMPTY_REMOTE_STATE,
        outbox: [record],
      }).outbox,
    ).toEqual([record]);
  });
});
