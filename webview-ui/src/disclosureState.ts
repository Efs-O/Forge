import { useCallback, useState } from 'react';

/**
 * Open/closed choices keyed by message id for the life of the webview. Never
 * persisted; user preferences live in VS Code settings, while row choices are
 * intentionally temporary.
 *
 * Component state alone is not enough: rows can remount as transcripts update
 * or the user switches conversations. Display defaults come from the current
 * setting; this map stores explicit reader choices.
 */
const choices = new Map<string, boolean>();

export interface FoldChoice {
  collapsed?: boolean;
  showAll?: boolean;
}

const foldChoices = new Map<string, FoldChoice>();

export type DisclosureKind =
  | 'step'
  | 'run'
  | 'group'
  | 'tool'
  | 'toolGroup'
  | 'diff'
  | 'command'
  | 'gap';

export function readFoldChoice(id: string): FoldChoice | undefined {
  return foldChoices.get(id);
}

export function writeFoldChoice(id: string, choice: FoldChoice): void {
  foldChoices.set(id, choice);
}

export function useFoldChoice(id: string): [FoldChoice, (choice: FoldChoice) => void] {
  const [choice, setChoice] = useState(() => readFoldChoice(id) ?? {});
  const set = useCallback(
    (next: FoldChoice) => {
      const merged = { ...(readFoldChoice(id) ?? {}), ...next };
      writeFoldChoice(id, merged);
      setChoice(merged);
    },
    [id],
  );
  return [choice, set];
}

function keyOf(kind: DisclosureKind, id: string): string {
  return `${kind}:${id}`;
}

/** The remembered choice for this element, or undefined if it has none. */
export function readDisclosure(kind: DisclosureKind, id: string): boolean | undefined {
  return choices.get(keyOf(kind, id));
}

/**
 * Store a choice without a component, for one control that opens several
 * elements at once (a step's diff link opens every diff in the step).
 */
export function writeDisclosure(kind: DisclosureKind, id: string, open: boolean): void {
  choices.set(keyOf(kind, id), open);
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
      writeDisclosure(kind, id, open);
      setChoice(open);
    },
    [kind, id],
  );
  return [choice, set];
}

/** Test hook: forget every choice. */
export function resetDisclosures(): void {
  choices.clear();
  foldChoices.clear();
}
