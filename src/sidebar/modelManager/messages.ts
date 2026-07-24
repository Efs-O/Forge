import type { GroupConfig, ModelConfig } from '../../config/types';

/**
 * Typed message bridge for the Model Manager webview panel (F7/§2.3). Mirrors
 * `../messageBridge.ts`'s style (discriminated unions, Host↔Panel suffixed
 * types) but is a separate contract — this panel is a second webview entry
 * point, not the sidebar chat view. See docs/OWNERS.md.
 */

// ── Shared view shapes ──────────────────────────────────────────────────────

/** One model row, assembled fresh on every push — the panel holds no state
 *  of its own (F7/§2.3 "stateless view" requirement). */
export interface ModelManagerModelView {
  name: string;
  /** Exactly as configured — pre-group/defaults merge — so the UI can tell
   *  an explicit override from an inherited value. */
  raw: ModelConfig;
  /** `raw` with `group`/`groups` and `defaults` folded in, for display. */
  resolved: ModelConfig;
  /** Keys present directly on `raw` (besides `name`) — anything in `resolved`
   *  but NOT in this list is inherited (group or defaults) and should render
   *  greyed; anything in this list is an explicit override (bold). */
  overrideKeys: string[];
  provider: string;
  /** Combined gguf_path + mmproj_path size on disk, or null when not a local file. */
  sizeBytes: number | null;
  quant?: string;
  family?: string;
  /** ISO timestamp of last dispatch, or null if never used (state.json). */
  lastUsed: string | null;
  /** True when gguf_path (or mmproj_path) is configured but missing on disk. */
  fileMissing: boolean;
  isActive: boolean;
  isLoaded: boolean;
}

export interface OrphanGguf {
  path: string;
  sizeBytes: number;
}

export interface ScanCandidateView {
  ggufPath: string;
  suggestedName: string;
  sizeBytes: number;
  family: string;
  quant?: string;
  mmprojPath?: string;
  alreadyConfigured: boolean;
}

// ── Host → Panel ─────────────────────────────────────────────────────────────

export interface ModelManagerStateMsg {
  type: 'state';
  models: ModelManagerModelView[];
  groups: Record<string, GroupConfig>;
  orphans: OrphanGguf[];
  totalDiskBytes: number;
  activeModel: string | null;
  modelDirs: string[];
}

export interface ModelManagerErrorMsg {
  type: 'error';
  message: string;
  /** When set, the error is scoped to one in-flight field edit so the panel
   *  can mark just that field red instead of a global toast. */
  field?: string;
  modelName?: string;
}

export interface ModelManagerScanResultMsg {
  type: 'scanResult';
  candidates: ScanCandidateView[];
}

export interface ModelManagerLoadResultMsg {
  type: 'loadResult';
  modelName: string;
  ok: boolean;
  message?: string;
}

export type ModelManagerHostToPanel =
  | ModelManagerStateMsg
  | ModelManagerErrorMsg
  | ModelManagerScanResultMsg
  | ModelManagerLoadResultMsg;

// ── Panel → Host ─────────────────────────────────────────────────────────────

export interface PanelReadyMsg {
  type: 'ready';
}
export interface PanelRefreshMsg {
  type: 'refresh';
}
/** `field` may be a dot-path into a nested object field (e.g. `sampling.temperature`). */
export interface PanelEditFieldMsg {
  type: 'editField';
  modelName: string;
  field: string;
  value: unknown;
}
export interface PanelRemoveModelMsg {
  type: 'removeModel';
  modelName: string;
}
export interface PanelPurgeModelMsg {
  type: 'purgeModel';
  modelName: string;
  /** User-typed confirmation string — must equal `modelName`, re-verified host-side. */
  typedName: string;
}
export interface PanelScanDirectoryMsg {
  type: 'scanDirectory';
}
export interface PanelAddScannedMsg {
  type: 'addScanned';
  picks: Array<{
    ggufPath: string;
    name: string;
    mmprojPath?: string;
  }>;
}
export interface PanelLoadAndTryMsg {
  type: 'loadAndTry';
  modelName: string;
}
export interface PanelRevealInExplorerMsg {
  type: 'revealInExplorer';
  modelName: string;
}
export interface PanelSetGroupFieldMsg {
  type: 'setGroupField';
  groupName: string;
  field: string;
  value: unknown;
}
export interface PanelAddGroupMsg {
  type: 'addGroup';
  groupName: string;
}
export interface PanelRemoveGroupMsg {
  type: 'removeGroup';
  groupName: string;
}
/** Delete one unreferenced GGUF found on disk (orphans section) — pure file
 *  deletion, no config entry involved. */
export interface PanelPurgeOrphanMsg {
  type: 'purgeOrphan';
  path: string;
}

export type ModelManagerPanelToHost =
  | PanelReadyMsg
  | PanelRefreshMsg
  | PanelEditFieldMsg
  | PanelRemoveModelMsg
  | PanelPurgeModelMsg
  | PanelScanDirectoryMsg
  | PanelAddScannedMsg
  | PanelLoadAndTryMsg
  | PanelRevealInExplorerMsg
  | PanelSetGroupFieldMsg
  | PanelAddGroupMsg
  | PanelRemoveGroupMsg
  | PanelPurgeOrphanMsg;
