import type { JobPanelMeta } from '../jobs/jobPanelSnapshot';

/**
 * The wire shapes for the sessions panel's Jobs section. Kept out of
 * `messageBridge.ts` the way `conversationMessages.ts` and `openMessages.ts`
 * are: the bridge sits at this repo's 500-line gate, and the bridge stays the
 * single import for message shapes by re-exporting these.
 *
 * Panel-scoped, not conversation-scoped: `panelId` is the webview's open-panel
 * generation. The host stamps every snapshot with the generation it was opened
 * for, and the webview drops snapshots and acknowledgements from any other —
 * a close/reopen race cannot make a stale jobs list paint over a fresh panel,
 * and a stale `openJob` click cannot navigate after the panel was replaced.
 */
export type { JobPanelMeta };

/** The panel opened; the host starts pushing and subscribes to store changes. */
export interface JobsPanelOpenedMsg {
  type: 'jobsPanelOpened';
  panelId: number;
}
/** The panel closed; the host stops pushing and releases every listener. */
export interface JobsPanelClosedMsg {
  type: 'jobsPanelClosed';
  panelId: number;
}
/** A job row was clicked; the host navigates and answers with `jobOpened`. */
export interface OpenJobMsg {
  type: 'openJob';
  panelId: number;
  id: string;
}
/** The whole jobs list, as the store read it for this panel generation. */
export interface JobsSnapshotMsg {
  type: 'jobsSnapshot';
  panelId: number;
  jobs: JobPanelMeta[];
}
/** Navigation for `id` succeeded; the webview may collapse the panel. */
export interface JobOpenedMsg {
  type: 'jobOpened';
  panelId: number;
  id: string;
}
