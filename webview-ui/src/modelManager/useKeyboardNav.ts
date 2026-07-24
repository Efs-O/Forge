import { useEffect } from 'react';

export interface KeyboardNavHandlers {
  models: string[];
  focused: string | null;
  onFocus: (name: string) => void;
  onToggleSelect: (name: string) => void;
  onOpenDrawer: (name: string) => void;
  onRemove: (name: string) => void;
  onPurge: (name: string) => void;
  onFocusFilter: () => void;
  onEscape: () => void;
  /** True while a modal (scan/groups/purge dialog) is open — suppresses list
   *  navigation so the modal owns keyboard input. */
  modalOpen: boolean;
}

const PAGE_SIZE = 10;

/** Global keydown handling for the Model Manager master list (§2.3): ↑/↓
 *  move, PgUp/PgDn page, Home/End jump, Space multi-select, Enter open
 *  detail, Del remove-from-config, Ctrl+Del purge, `/` focuses filter, Esc
 *  closes drawer/clears selection. Inactive while typing in a field or while
 *  a modal is open. */
export function useKeyboardNav(handlers: KeyboardNavHandlers): void {
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (handlers.modalOpen) return;
      if (e.key === 'Escape') {
        handlers.onEscape();
        return;
      }
      if (isEditableTarget(e.target)) return;

      if (e.key === '/') {
        e.preventDefault();
        handlers.onFocusFilter();
        return;
      }

      const { models, focused } = handlers;
      if (models.length === 0) return;
      const index = focused ? models.indexOf(focused) : -1;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          handlers.onFocus(models[Math.min(index + 1, models.length - 1)] ?? models[0]);
          break;
        case 'ArrowUp':
          e.preventDefault();
          handlers.onFocus(models[Math.max(index - 1, 0)] ?? models[0]);
          break;
        case 'PageDown':
          e.preventDefault();
          handlers.onFocus(models[Math.min(index + PAGE_SIZE, models.length - 1)] ?? models[0]);
          break;
        case 'PageUp':
          e.preventDefault();
          handlers.onFocus(models[Math.max(index - PAGE_SIZE, 0)] ?? models[0]);
          break;
        case 'Home':
          e.preventDefault();
          handlers.onFocus(models[0]);
          break;
        case 'End':
          e.preventDefault();
          handlers.onFocus(models[models.length - 1]);
          break;
        case ' ':
          if (focused) {
            e.preventDefault();
            handlers.onToggleSelect(focused);
          }
          break;
        case 'Enter':
          if (focused) {
            e.preventDefault();
            handlers.onOpenDrawer(focused);
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (focused) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) handlers.onPurge(focused);
            else handlers.onRemove(focused);
          }
          break;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });
}
