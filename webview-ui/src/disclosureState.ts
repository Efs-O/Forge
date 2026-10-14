import { useCallback, useState } from 'react';

/**
 * Open/closed choices keyed by message id, for the
 * life of the webview. Never persisted (ACTIVITY_VIEW_PLAN § Expand state).
 *
 * Component state alone is not enough: as a turn streams, the same messages
 * move between components - a trailing thinking row folds into the next tool
 * call's step, and a lone step is pulled into a group when a second one
 * arrives. React remounts on each move, so a reasoning bubble the reader had
 * open snapped shut the moment the next tool call landed. Only reader choices
 * are stored; live work stays compact until the reader opens it.
 */
const choices = new Map<string, boolean>();

export type DisclosureKind =
  | 'thinking'
  | 'thinkingGroup'
  | 'step'
  | 'run'
  | 'group'
  | 'tool'
  | 'toolGroup'
  | 'diff';

function keyOf(kind: DisclosureKind, id: string): string {
  return `${kind}:${id}`;
}

/** The remembered choice for this element, or undefined if it has none. */
export function readDisclosure(kind: DisclosureKind, id: string): boolean | undefined {
  return choices.get(keyOf(kind, id));
}

/**
 * True when the reader opened any of these reasoning messages, as a lone
 * bubble (`thinking`) or as the run they first appeared in (`thinkingGroup`,
 * keyed on the run's first id). Every container a reasoning run can fold into -
 * a step, a group, a longer run - asks this, so an opened bubble keeps its
 * container open wherever it lands.
 */
export function openedReasoning(thoughts: readonly { id: string }[]): boolean {
  if (thoughts[0] && readDisclosure('thinkingGroup', thoughts[0].id) === true) return true;
  return thoughts.some((thought) => readDisclosure('thinking', thought.id) === true);
}

/**
 * `useState` for an open/closed choice that survives remounts. `id` is
 * the element's first message id - the same id `rowKey` uses - so it is fixed
 * from the moment the element first renders.
 */
export function useDisclosure(
  kind: DisclosureKind,
  id: string,
): [boolean | undefined, (open: boolean) => void] {
  const [choice, setChoice] = useState(() => readDisclosure(kind, id));
  const set = useCallback(
    (open: boolean) => {
      choices.set(keyOf(kind, id), open);
      setChoice(open);
    },
    [kind, id],
  );
  return [choice, set];
}

/** Test hook: forget every choice. */
export function resetDisclosures(): void {
  choices.clear();
}
