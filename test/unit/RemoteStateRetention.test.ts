/**
 * Coverage for the request-table cap moved out of `RemoteRequestStore.enqueue`
 * into its retention owner (docs/plans/REMOTE_REQUEST_STORE_SPLIT_PLAN.md).
 * Nothing tested the cap before; these pin the two rules that matter: only
 * terminal rows go, and work another window owes never does.
 */

import { describe, expect, it } from 'vitest';
import { trimRequestsToRecordCap } from '../../src/remote/remoteStateRetention';
import {
  EMPTY_REMOTE_STATE,
  MAX_RECORDS,
  type RemoteStoreState,
} from '../../src/remote/RemoteStoreSchemas';
import type { RemoteExecutionState, RemoteRequestRecord } from '../../src/remote/types';

function request(id: string, state: RemoteExecutionState): RemoteRequestRecord {
  return {
    id,
    dedupKey: `fake chat ${id}`,
    channel: 'fake',
    chatId: 'chat',
    providerMessageId: `m-${id}`,
    conversationId: 'c1',
    text: 'hello',
    receivedAt: 1_000,
    state,
    updatedAt: 1_000,
  };
}

function draftWith(states: RemoteExecutionState[]): RemoteStoreState {
  const requests = states.map((state, index) => request(`r${index}`, state));
  return { ...structuredClone(EMPTY_REMOTE_STATE), requests };
}

function terminalRows(count: number): RemoteExecutionState[] {
  const rows: RemoteExecutionState[] = [];
  while (rows.length < count) {
    rows.push('completed', 'failed', 'cancelled', 'unknown');
  }
  rows.length = count;
  return rows;
}

describe('trimRequestsToRecordCap', () => {
  it('drops the oldest terminal rows until the table is back at the cap', () => {
    const state = draftWith(['queued', ...terminalRows(MAX_RECORDS + 48), 'running']);
    const before = state.requests;
    expect(before).toHaveLength(MAX_RECORDS + 50);

    trimRequestsToRecordCap(state);

    expect(state.requests).toHaveLength(MAX_RECORDS);
    // The reassignment is the pin: the draft holds a new array, so the schema
    // parse and the write that follow see the trimmed table, not the old one.
    expect(state.requests).not.toBe(before);
    // The queued and running rows survive, at the ends they were written.
    expect(state.requests[0]).toMatchObject({ id: 'r0', state: 'queued' });
    expect(state.requests[MAX_RECORDS - 1]).toMatchObject({
      id: `r${MAX_RECORDS + 49}`,
      state: 'running',
    });
    // Exactly the first 50 terminal rows went, and nothing else.
    const dropped = new Set(before.slice(1, 51).map((item) => item.id));
    expect(state.requests.filter((item) => dropped.has(item.id))).toEqual([]);
    const survivors = new Set(state.requests.map((item) => item.id));
    expect(survivors.has('r51')).toBe(true);
    expect(
      state.requests.filter((item) => item.state === 'queued' || item.state === 'running'),
    ).toHaveLength(2);
  });

  it('leaves a table at or under the cap alone', () => {
    const state = draftWith(['completed', 'queued']);
    const before = state.requests;
    trimRequestsToRecordCap(state);
    expect(state.requests).toHaveLength(2);
    expect(state.requests).toBe(before);
  });

  it('removes nothing when every row is still work, even over the cap', () => {
    const states = Array.from({ length: MAX_RECORDS + 5 }, () => 'queued' as const);
    const state = draftWith(states);
    trimRequestsToRecordCap(state);
    expect(state.requests).toHaveLength(MAX_RECORDS + 5);
  });
});
