/**
 * Coverage for the request-outcome draft writes moved out of
 * `RemoteRequestStore.finish` (docs/plans/REMOTE_REQUEST_STORE_SPLIT_PLAN.md).
 * The store-level behaviour was already tested end to end by `RemoteCore` and
 * `RemoteRequestStoreScope`; what nothing tested was the announce branch and
 * the conditional reply fields, so they are pinned here at the draft.
 */

import { describe, expect, it } from 'vitest';
import {
  finishRequestInDraft,
  type RemoteRequestFinishPayload,
} from '../../src/remote/remoteRequestOutcome';
import {
  EMPTY_REMOTE_STATE,
  RemoteStateSchema,
  type RemoteStoreState,
} from '../../src/remote/RemoteStoreSchemas';
import type { RemoteBinding, RemoteRequestRecord } from '../../src/remote/types';

let seq = 0;
function request(state: RemoteRequestRecord['state'], claim = true): RemoteRequestRecord {
  seq += 1;
  const id = `r${seq}`;
  return {
    id,
    dedupKey: `fake\u0000chat\u0000${id}`,
    channel: 'fake',
    chatId: 'chat',
    providerMessageId: `m${seq}`,
    conversationId: 'c1',
    text: 'hello',
    receivedAt: 1_000,
    state,
    updatedAt: 1_000,
    ...(claim ? { claimOwner: { token: 'tok', pid: 1, startedAt: 1_000 } } : {}),
  };
}

function draft(...requests: RemoteRequestRecord[]): RemoteStoreState {
  return { ...structuredClone(EMPTY_REMOTE_STATE), requests };
}

const BINDING: RemoteBinding = {
  channel: 'fake',
  chatId: 'chat',
  workspaceId: 'w1',
  conversationId: 'c1',
};

describe('finishRequestInDraft', () => {
  it('settles the row, drops the claim and pushes the reply for that request', () => {
    const state = draft(request('running'));
    finishRequestInDraft(state, state.requests[0].id, 'completed', {
      notification: 'Done.',
      finalText: 'the answer',
    });

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({
      state: 'completed',
      finalText: 'the answer',
    });
    expect(state.requests[0].claimOwner).toBeUndefined();
    expect(state.requests[0].updatedAt).toBeGreaterThanOrEqual(1_000);

    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({
      requestId: state.requests[0].id,
      channel: 'fake',
      chatId: 'chat',
      text: 'Done.',
      state: 'pending',
      attempts: 0,
    });
    expect(state.outbox[0].id).toBeTruthy();
    // The draft still parses, which is what the store does before it writes.
    expect(RemoteStateSchema.parse(state).outbox).toHaveLength(1);
  });

  it('carries the optional reply fields only when the caller passes them', () => {
    const plain = draft(request('running'));
    finishRequestInDraft(plain, plain.requests[0].id, 'failed', {
      notification: 'no.',
      error: 'boom',
    });
    expect(plain.outbox[0].ephemeral).toBeUndefined();
    expect(plain.outbox[0].speedLine).toBeUndefined();
    expect(plain.requests[0]).toMatchObject({ state: 'failed', error: 'boom' });

    const withOpts = draft(request('running'));
    const payload: RemoteRequestFinishPayload = {
      notification: 'gone.',
      ephemeral: true,
      speedLine: '12.3 tok/s',
    };
    finishRequestInDraft(withOpts, withOpts.requests[0].id, 'cancelled', payload);
    expect(withOpts.outbox[0]).toMatchObject({ ephemeral: true, speedLine: '12.3 tok/s' });
    expect(withOpts.requests[0].state).toBe('cancelled');
  });

  it('marks only the binding that is already bound to the announced conversation', () => {
    const told = draft(request('running'));
    const id = told.requests[0].id;
    told.bindings = [
      { ...BINDING, conversationId: 'c1' },
      { ...BINDING, chatId: 'other', conversationId: 'c9' },
    ];
    finishRequestInDraft(told, id, 'completed', {
      notification: 'Done.',
      announceConversationId: 'c1',
    });
    expect(told.bindings[0].announcedConversationId).toBe('c1');
    expect(told.bindings[1].announcedConversationId).toBeUndefined();

    const elsewhere = draft(request('running'));
    elsewhere.bindings = [{ ...BINDING, conversationId: 'c9' }];
    finishRequestInDraft(elsewhere, elsewhere.requests[0].id, 'completed', {
      notification: 'Done.',
      announceConversationId: 'c1',
    });
    expect(elsewhere.bindings[0].announcedConversationId).toBeUndefined();
  });

  it('throws when the row is gone — the caller had it, so that is a bug', () => {
    const state = draft(request('running'));
    expect(() => finishRequestInDraft(state, 'r-missing', 'completed', { notification: 'x' })).toThrow(
      /Forge: remote request r-missing is missing\./,
    );
    expect(state.outbox).toHaveLength(0);
  });
});
