import type {
  ModelManagerModelView,
  OrphanGguf,
  ScanCandidateView,
} from '../../../src/sidebar/modelManager/messages';
import type { GroupConfig } from '../../../src/config/types';

export type SortKey = 'name' | 'size' | 'lastUsed';

export interface ModelManagerState {
  models: ModelManagerModelView[];
  groups: Record<string, GroupConfig>;
  orphans: OrphanGguf[];
  totalDiskBytes: number;
  activeModel: string | null;
  modelDirs: string[];
  loaded: boolean;

  selected: string[];
  focused: string | null;
  filter: string;
  sortKey: SortKey;
  sortDesc: boolean;
  unusedOnly: boolean;

  drawerOpen: boolean;
  scanCandidates: ScanCandidateView[] | null;
  groupsEditorOpen: boolean;

  error: string | null;
  errorField: string | null;
  loadingNames: string[];
}

export const initialState: ModelManagerState = {
  models: [],
  groups: {},
  orphans: [],
  totalDiskBytes: 0,
  activeModel: null,
  modelDirs: [],
  loaded: false,
  selected: [],
  focused: null,
  filter: '',
  sortKey: 'name',
  sortDesc: false,
  unusedOnly: false,
  drawerOpen: false,
  scanCandidates: null,
  groupsEditorOpen: false,
  error: null,
  errorField: null,
  loadingNames: [],
};

export type Action =
  | {
      type: 'STATE';
      models: ModelManagerModelView[];
      groups: Record<string, GroupConfig>;
      orphans: OrphanGguf[];
      totalDiskBytes: number;
      activeModel: string | null;
      modelDirs: string[];
    }
  | { type: 'SCAN_RESULT'; candidates: ScanCandidateView[] }
  | { type: 'LOAD_RESULT'; modelName: string; ok: boolean; message?: string }
  | { type: 'ERROR'; message: string; field?: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_FILTER'; value: string }
  | { type: 'SET_SORT'; key: SortKey }
  | { type: 'TOGGLE_UNUSED_ONLY' }
  | { type: 'SET_FOCUS'; name: string | null }
  | { type: 'TOGGLE_SELECT'; name: string }
  | { type: 'SELECT_ONLY'; name: string | null }
  | { type: 'OPEN_DRAWER' }
  | { type: 'CLOSE_DRAWER' }
  | { type: 'OPEN_SCAN_DIALOG' }
  | { type: 'CLOSE_SCAN_DIALOG' }
  | { type: 'OPEN_GROUPS_EDITOR' }
  | { type: 'CLOSE_GROUPS_EDITOR' }
  | { type: 'START_LOADING'; name: string };

export function reducer(state: ModelManagerState, action: Action): ModelManagerState {
  switch (action.type) {
    case 'STATE': {
      const stillExists = new Set(action.models.map((m) => m.name));
      return {
        ...state,
        models: action.models,
        groups: action.groups,
        orphans: action.orphans,
        totalDiskBytes: action.totalDiskBytes,
        activeModel: action.activeModel,
        modelDirs: action.modelDirs,
        loaded: true,
        selected: state.selected.filter((n) => stillExists.has(n)),
        focused: state.focused && stillExists.has(state.focused) ? state.focused : null,
        drawerOpen: state.drawerOpen && Boolean(state.focused && stillExists.has(state.focused)),
      };
    }
    case 'SCAN_RESULT':
      return { ...state, scanCandidates: action.candidates };
    case 'LOAD_RESULT':
      return {
        ...state,
        loadingNames: state.loadingNames.filter((n) => n !== action.modelName),
        error: action.ok ? state.error : (action.message ?? 'load failed'),
        errorField: action.ok ? state.errorField : null,
      };
    case 'ERROR':
      return { ...state, error: action.message, errorField: action.field ?? null };
    case 'CLEAR_ERROR':
      return { ...state, error: null, errorField: null };
    case 'SET_FILTER':
      return { ...state, filter: action.value };
    case 'SET_SORT':
      return state.sortKey === action.key
        ? { ...state, sortDesc: !state.sortDesc }
        : { ...state, sortKey: action.key, sortDesc: false };
    case 'TOGGLE_UNUSED_ONLY':
      return { ...state, unusedOnly: !state.unusedOnly };
    case 'SET_FOCUS':
      return { ...state, focused: action.name };
    case 'TOGGLE_SELECT': {
      const has = state.selected.includes(action.name);
      return {
        ...state,
        selected: has
          ? state.selected.filter((n) => n !== action.name)
          : [...state.selected, action.name],
        focused: action.name,
      };
    }
    case 'SELECT_ONLY':
      return { ...state, selected: action.name ? [action.name] : [], focused: action.name };
    case 'OPEN_DRAWER':
      return { ...state, drawerOpen: true };
    case 'CLOSE_DRAWER':
      return { ...state, drawerOpen: false };
    case 'OPEN_SCAN_DIALOG':
      return { ...state, scanCandidates: [] };
    case 'CLOSE_SCAN_DIALOG':
      return { ...state, scanCandidates: null };
    case 'OPEN_GROUPS_EDITOR':
      return { ...state, groupsEditorOpen: true };
    case 'CLOSE_GROUPS_EDITOR':
      return { ...state, groupsEditorOpen: false };
    case 'START_LOADING':
      return { ...state, loadingNames: [...state.loadingNames, action.name] };
    default:
      return state;
  }
}

export function visibleModels(state: ModelManagerState): ModelManagerModelView[] {
  const q = state.filter.trim().toLowerCase();
  let list = state.models;
  if (q) {
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.raw.short_name ?? '').toLowerCase().includes(q) ||
        (m.raw.category ?? '').toLowerCase().includes(q) ||
        (m.raw.group ?? '').toLowerCase().includes(q),
    );
  }
  if (state.unusedOnly) {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    list = list.filter((m) => {
      if (!m.lastUsed) return true;
      return Date.now() - new Date(m.lastUsed).getTime() > THIRTY_DAYS_MS;
    });
  }
  const dir = state.sortDesc ? -1 : 1;
  return [...list].sort((a, b) => {
    if (state.sortKey === 'size') return dir * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
    if (state.sortKey === 'lastUsed') {
      const at = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const bt = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return dir * (at - bt);
    }
    return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
