import { type RefObject, useEffect } from 'react';

/**
 * Escape settles a docked dialog from anywhere on the page, because the user
 * may be reading the transcript above it. But the dialog is no longer modal: an
 * Escape that belongs to another field (renaming a chat, a history menu) must
 * not also deny an approval or dismiss a question.
 */
export function useDockedDialogEscape(
  panelRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        !panelRef.current?.contains(target) &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')
      ) {
        return;
      }
      event.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [panelRef, onEscape]);
}
