import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createCheckpointActions } from '../../src/sidebar/checkpointActions';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { CheckpointReview } from '../../src/sidebar/CheckpointReview';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const root = path.resolve('forge-checkpoint-root');
const file = path.join(root, 'src', 'a.ts');
const UNDO_NOTE =
  '[Forge] The user pressed Undo on your last turn. These files are back to how they were ' +
  `before that turn: src/a.ts. Your changes to them are gone.`;

function conversation(id = 'c1'): ConversationRuntime {
  return { id, title: id, createdAt: 0, updatedAt: 0, messages: [] };
}

function harness(options: { restored?: string[]; open?: boolean } = {}) {
  const restored = options.restored ?? [file];
  const conv = conversation();
  const checkpoints = {
    undo: vi.fn(async () => restored),
    keep: vi.fn(async () => undefined),
    canUndo: vi.fn(() => true),
    pendingSnapshots: vi.fn(() => []),
  } as unknown as CheckpointStack;
  const codeLens = { clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider;
  const review = { open: vi.fn(async () => undefined) } as unknown as CheckpointReview;
  const post = vi.fn();
  const persist = vi.fn();
  const actions = createCheckpointActions({
    checkpoints,
    codeLens,
    review,
    post,
    activeConversationId: () => conv.id,
    findConversation: (id) => (id === conv.id && options.open !== false ? conv : undefined),
    persist,
    workspaceRoot: root,
  });
  return { actions, checkpoints, codeLens, conv, persist, post, review };
}

describe('checkpointActions', () => {
  it('tells the model what Undo gave back, once, and saves it', async () => {
    const { actions, conv, persist } = harness();

    expect(await actions.undo()).toEqual([file]);

    expect(conv.messages).toEqual([
      { role: 'user', content: UNDO_NOTE, internal: true },
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(conv.id);
  });

  it('notes an Undo that restored nothing', async () => {
    const { actions, conv, persist } = harness({ restored: [] });

    await actions.undo();

    expect(conv.messages).toEqual([
      {
        role: 'user',
        content: '[Forge] The user pressed Undo on your last turn; no files needed restoring.',
        internal: true,
      },
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('writes no note for a conversation that is not open', async () => {
    const { actions, conv, persist } = harness({ open: false });

    await actions.undo();

    expect(conv.messages).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it('dismisses the pending checkpoint on both actions', async () => {
    const { actions, checkpoints, codeLens, post } = harness();

    await actions.undo();
    await actions.keep();

    expect(checkpoints.keep).toHaveBeenCalledWith('c1');
    expect(codeLens.clearPending).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith({ type: 'checkpointDismissed', conversationId: 'c1' });
  });

  it('keeps and canUndo leave the transcript alone', async () => {
    const { actions, conv, persist, review, checkpoints } = harness();

    expect(actions.canUndo()).toBe(true);
    await actions.reviewCheckpoint();
    await actions.keep();

    expect(conv.messages).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(review.open).toHaveBeenCalledWith([]);
    expect(checkpoints.pendingSnapshots).toHaveBeenCalledWith('c1');
  });
});
