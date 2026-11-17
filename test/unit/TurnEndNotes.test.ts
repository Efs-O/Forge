import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  TURN_STOPPED_NOTE,
  undoNote,
  wireTurnEndNotes,
  type TurnEndNotesWiring,
} from '../../src/sidebar/turnEndNotes';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { SidebarProviderEvents } from '../../src/sidebar/providerEvents';

/** The exact sentence the model is entitled to see after an Undo. */
const UNDO_FILES_NOTE = (paths: string) =>
  `[Forge] The user pressed Undo on your last turn. These files are back to how they were ` +
  `before that turn: ${paths}. Your changes to them are gone.`;
const UNDO_NOTHING_NOTE =
  '[Forge] The user pressed Undo on your last turn; no files needed restoring.';

function conversation(id = 'c1'): ConversationRuntime {
  return { id, title: id, createdAt: 0, updatedAt: 0, messages: [] };
}

describe('undoNote', () => {
  const root = path.resolve('forge-undo-note-root');
  const file = path.join(root, 'src', 'a.ts');

  it('names the restored files relative to the workspace', () => {
    expect(undoNote([file], root)).toBe(UNDO_FILES_NOTE('src/a.ts'));
  });

  it('says so when nothing needed restoring', () => {
    expect(undoNote([], root)).toBe(UNDO_NOTHING_NOTE);
  });

  it('keeps undo order and drops duplicate paths', () => {
    const second = path.join(root, 'src', 'b.ts');
    expect(undoNote([second, file, second], root)).toBe(UNDO_FILES_NOTE('src/b.ts, src/a.ts'));
  });

  it('shows an absolute path outside the workspace', () => {
    const outside = path.resolve('outside', 'x.ts');
    expect(undoNote([outside], root)).toBe(
      UNDO_FILES_NOTE(path.relative(root, outside).split(path.sep).join('/')),
    );
  });

  it('uses forward slashes without a workspace root', () => {
    const absolute = path.sep === '\\' ? 'N:\\repo\\src\\a.ts' : '/repo/src/a.ts';
    const shown = path.sep === '\\' ? 'N:/repo/src/a.ts' : '/repo/src/a.ts';
    expect(undoNote([absolute])).toBe(UNDO_FILES_NOTE(shown));
  });

  // The separator conversion only means something on the platform that has them.
  if (path.sep === '\\') {
    it('renders Windows separators as forward slashes', () => {
      expect(undoNote(['N:\\repo\\src\\a.ts'], 'N:\\repo')).toBe(UNDO_FILES_NOTE('src/a.ts'));
    });
  }
});

describe('wireTurnEndNotes', () => {
  function wire(overrides: Partial<TurnEndNotesWiring> = {}) {
    const conv = conversation();
    const events: SidebarProviderEvents = {};
    wireTurnEndNotes(events, {
      lookup: (id) => (id === conv.id ? conv : undefined),
      isCliModel: () => false,
      ...overrides,
    });
    return { conv, events };
  }

  it('tells the model, in one exact sentence, that its turn was stopped', () => {
    const { conv, events } = wire();
    events.onGenerationFinished?.('model-a', 'c1', 'partial answer', 'cancelled');
    expect(conv.messages).toEqual([
      { role: 'user', content: TURN_STOPPED_NOTE, internal: true },
    ]);
    expect(TURN_STOPPED_NOTE).toBe(
      '[Forge] Your last turn was stopped before it finished. The stop was not a new ' +
        'instruction; the next message says what to do.',
    );
  });

  it('stays silent for a steer, a completed turn and an unknown conversation', () => {
    const { conv, events } = wire();
    events.onGenerationFinished?.('model-a', 'c1', 'text', 'interrupted');
    events.onGenerationFinished?.('model-a', 'c1', 'text', 'completed');
    events.onGenerationFinished?.('model-a', 'c1', 'text', 'failed');
    events.onGenerationFinished?.('model-a', undefined, 'text', 'cancelled');
    events.onGenerationFinished?.('model-a', 'no-such-chat', 'text', 'cancelled');
    expect(conv.messages).toEqual([]);
  });

  it('stays silent for a CLI agent, whose transcript the CLI owns', () => {
    const { conv, events } = wire({ isCliModel: () => true });
    events.onGenerationFinished?.('claude', 'c1', 'text', 'cancelled');
    expect(conv.messages).toEqual([]);
  });

  it('still chains the handler it decorated', () => {
    const seen = vi.fn();
    const events: SidebarProviderEvents = { onGenerationFinished: seen };
    wireTurnEndNotes(events, { lookup: () => undefined, isCliModel: () => false });
    events.onGenerationFinished?.('model-a', 'c1', 'text', 'cancelled');
    expect(seen).toHaveBeenCalledWith('model-a', 'c1', 'text', 'cancelled');
  });
});
