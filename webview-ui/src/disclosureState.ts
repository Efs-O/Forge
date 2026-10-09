import { useCallback, useState } from 'react';

/**
 * Open/closed choices the reader made by hand, keyed by message id, for the
 * life of the webview. Never persisted (ACTIVITY_VIEW_PLAN § Expand state).
 *
 * Component state alone is not enough: as a turn streams, the same messages
 * move between components - a trailing thinking row folds into the next tool
 * call's step, and a lone step is pulled into a group when a second one
 * arrives. React remounts on each move, so a reasoning bubble the reader had
 * open snapped shut the moment the next tool call landed.
 */
const choices = new Map<string, boolean>();

export type DisclosureKind = 'thinking' | 'thinkingGroup' | 'step' | 'run' | 'group' | 'diff';

function keyOf(kind: DisclosureKind, id: string): string {
  return `${kind}:${id}`;
}

/** The reader's choice for this element, or undefined if they never toggled it. */
export function readDisclosure(kind: DisclosureKind, id: string): boolean | undefined {
  return choices.get(keyOf(kind, id));
}

/**
 * `useState` for a manual open/closed choice that survives remounts. `id` is
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
