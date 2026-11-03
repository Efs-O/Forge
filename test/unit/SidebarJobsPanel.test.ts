/**
 * The sessions panel's Jobs bridge (`src/sidebar/jobPanelUpdates.ts`): what
 * pushes, what gets dropped, and — the two questions this repo asks of every
 * new wait and every new message — what cancels it and what says a message
 * belongs to this panel.
 *
 * These tests use real timers and a real store in a temp directory: the bridge's
 * refresh path is a debounced timer plus real file reads plus `fs.watch`, and a
 * fake timer would fake away exactly the thing under test. Each wait polls until
 * its condition holds, so the suite pays the debounce only where the debounce is
 * what is being measured.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { defaultState, JobStore } from '../../src/jobs/JobStore';
import { JobSchema, JobStateSchema, type Job, type JobFile } from '../../src/jobs/jobSchema';
import { JobsPanelBridge, JOBS_REFRESH_DEBOUNCE_MS } from '../../src/sidebar/jobPanelUpdates';
import { ChatCapacityError, type ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { chatCapMessage } from '../../src/sidebar/sessionTypes';
import type { HostToWebview, JobPanelMeta } from '../../src/sidebar/messageBridge';

let root: string;
let store: JobStore;
let posts: HostToWebview[];
let view: vscode.WebviewView;
let facadeLog: {
  restored: { id: string; activate?: boolean }[];
  created: number;
  sent: { id: string; text: string }[];
};
let bridges: JobsPanelBridge[] = [];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll until `check` holds, so a test waits only as long as the push takes. */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the jobs panel never pushed what the test waited for');
    await sleep(10);
  }
}

function makeView(sink: HostToWebview[]): vscode.WebviewView {
  return {
    webview: { postMessage: (msg: unknown) => sink.push(msg as HostToWebview) },
  } as unknown as vscode.WebviewView;
}

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'alpha',
    name: 'Alpha',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'daily', at: '07:00' },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 100,
    updated_at: 0,
    ...overrides,
  });
}

function state(over: Record<string, unknown> = {}) {
  return JobStateSchema.parse({ ...defaultState(), ...over });
}

/**
 * A host facade that records what the bridge asked it to do. `restoreError` is
 * what `restoreConversation` should throw, because the two reasons it fails are
 * different: an id that no longer resolves is a stale row, while a full chat
 * cap is something the user has to fix themselves.
 */
function fakeFacade(log: typeof facadeLog, restoreError?: Error): ForgeHostFacade {
  return {
    async restoreConversation(id: string, options?: { activate?: boolean }) {
      log.restored.push({ id, ...(options?.activate ? { activate: true } : {}) });
      if (restoreError) throw restoreError;
      return { id };
    },
    async createConversation() {
      log.created += 1;
      return { id: 'new-chat' };
    },
    async send(id: string, text: string) {
      log.sent.push({ id, text });
      return {};
    },
  } as unknown as ForgeHostFacade;
}

/** Every bridge a test opens is disposed in `afterEach`: an open panel holds
 *  three `fs.watch` handles on the temp store, and on Windows a watched
 *  directory cannot be removed, so an undisposed bridge reads as a temp leak.
 */
function makeBridge(options: { restoreError?: Error; storeOverride?: JobStore } = {}) {
  const target = options.storeOverride ?? store;
  const bridge = new JobsPanelBridge({
    store: target,
    getView: () => view,
    hostFacade: () => fakeFacade(facadeLog, options.restoreError),
  });
  bridges.push(bridge);
  return bridge;
}

const snapshots = (): JobPanelMeta[][] =>
  posts
    .filter((msg): msg is Extract<HostToWebview, { type: 'jobsSnapshot' }> => msg.type === 'jobsSnapshot')
    .map((msg) => msg.jobs);
const errors = (): string[] =>
  posts
    .filter((msg): msg is Extract<HostToWebview, { type: 'error' }> => msg.type === 'error')
    .map((msg) => msg.message);
const latestOf = (id: string): JobPanelMeta | undefined =>
  snapshots().at(-1)?.find((row) => row.id === id);

/** A store whose first listing is deliberately slow, to make two reads overlap. */
class SlowFirstReadStore extends JobStore {
  private slow = true;
  override async loadAll(): Promise<JobFile[]> {
    const listed = await super.loadAll();
    if (this.slow) {
      this.slow = false;
      await sleep(120);
    }
    return listed;
  }
}

/** A store whose second listing fails, standing in for a store that becomes unreadable. */
class FailsAfterFirstStore extends JobStore {
  private reads = 0;
  override async loadAll(): Promise<JobFile[]> {
    this.reads += 1;
    if (this.reads === 1) return super.loadAll();
    throw new Error('EACCES: permission denied');
  }
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-panel-bridge-'));
  store = new JobStore(root);
  await store.saveJob(job({ id: 'alpha', name: 'Alpha' }));
  await store.saveJob(
    job({
      id: 'beta',
      name: 'Beta',
      created_at: 200,
      schedule: { kind: 'interval', minutes: 15 },
      action: { kind: 'agent_task', task: 'check the thing', report: 'always' },
    }),
  );
  posts = [];
  view = makeView(posts);
  facadeLog = { restored: [], created: 0, sent: [] };
  bridges = [];
});

afterEach(async () => {
  for (const bridge of bridges) bridge.dispose();
  bridges = [];
  await fs.promises.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

describe('JobsPanelBridge — pushing the store to an open panel', () => {
  it('pushes the store as it reads now the moment the panel opens', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    expect(posts).toContainEqual(
      expect.objectContaining({ type: 'jobsSnapshot', panelId: 1 }),
    );
    expect(snapshots()[0]!.map((row) => row.id)).toEqual(['alpha', 'beta']);
  });

  it('a write through the store arrives as one coalesced snapshot, not one per write', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    const before = snapshots().length;
    // The scheduler's shape: a run row, then the state patch that follows it.
    await store.appendRun('alpha', {
      at: 1_700_000_000_000,
      outcome: 'ok',
      summary: 'nothing changed',
      delivered: 0,
    });
    store.patchState('alpha', {
      last_run_at: 1_700_000_000_000,
      consecutive_failures: 0,
    });
    await waitFor(() => snapshots().length > before);
    expect(snapshots()).toHaveLength(before + 1);
    expect(latestOf('alpha')?.lastOutcomeLabel).toBe('ok');
    expect(latestOf('alpha')?.lastRun?.detail).toBe('nothing changed');
  });

  it('converges on a write made by another window, which never touches this store', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    const before = snapshots().length;
    // Another window: the file changes under us with no write through `store`,
    // so only the directory watcher can carry it to the panel.
    await fs.promises.writeFile(
      path.join(root, 'state', 'alpha.json'),
      JSON.stringify(state({ last_run_at: 1_700_000_000_000, consecutive_failures: 2 })),
    );
    await waitFor(() => snapshots().length > before);
    expect(latestOf('alpha')?.lastOutcomeLabel).toBe('failing ×2');
  });

  it('keeps the last good snapshot and says what went wrong when a read fails', async () => {
    const broken = new FailsAfterFirstStore(root);
    const bridge = makeBridge({ storeOverride: broken });
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await store.saveState('alpha', state({ last_run_at: 1_700_000_000_000 }));
    await waitFor(() => errors().length > 0);
    // The panel is not left looking empty: the earlier snapshot is still the
    // only one the webview has, and the failure is stated, not swallowed.
    expect(snapshots()).toHaveLength(1);
    expect(errors()[0]).toContain('permission denied');
  });

  it('drops the older of two overlapping reads for the same panel', async () => {
    const slow = new SlowFirstReadStore(root);
    const bridge = makeBridge({ storeOverride: slow });
    bridge.openPanel(1); // read A starts and is slow
    bridge.openPanel(1); // read B for the same generation starts and is fast
    await sleep(JOBS_REFRESH_DEBOUNCE_MS + 300);
    // Only B may publish; A landing later must not overwrite it or double-list.
    expect(snapshots()).toHaveLength(1);
  });
});

describe('JobsPanelBridge — what cancels a panel', () => {
  it('a close stops the pushes, and a reopen reads the store afresh', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    const before = snapshots().length;
    bridge.closePanel(1);
    store.patchState('alpha', { last_run_at: 1_700_000_000_000 });
    await sleep(JOBS_REFRESH_DEBOUNCE_MS + 300);
    expect(snapshots()).toHaveLength(before);
    bridge.openPanel(2);
    await waitFor(() => snapshots().length > before);
    expect(posts.filter((msg) => msg.type === 'jobsSnapshot')).toHaveLength(before + 1);
  });

  it('ignores a close from a generation it already replaced', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    bridge.openPanel(2);
    await waitFor(() => snapshots().length > 0);
    bridge.closePanel(1); // the panel that was replaced, not the one open now
    const before = snapshots().length;
    store.patchState('alpha', { last_run_at: 1_700_000_000_000 });
    await waitFor(() => snapshots().length > before);
  });

  it('stops everything on dispose, which is what extension teardown calls', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    const before = snapshots().length;
    bridge.dispose();
    store.patchState('alpha', { last_run_at: 1_700_000_000_000 });
    await sleep(JOBS_REFRESH_DEBOUNCE_MS + 300);
    expect(snapshots()).toHaveLength(before);
  });

  it('publishes nothing once this window has a different sidebar view', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    const before = snapshots().length;
    // A reload hands back a brand-new view; the panel that asked belongs to the
    // old one, and posting into it would be posting into a disposed webview.
    view = makeView(posts);
    store.patchState('alpha', { last_run_at: 1_700_000_000_000 });
    await sleep(JOBS_REFRESH_DEBOUNCE_MS + 300);
    expect(snapshots()).toHaveLength(before);
  });
});

describe('JobsPanelBridge — clicking a job row', () => {
  it('activates the agent_task chat whose id still resolves, without seeding it', async () => {
    await store.saveState('beta', state({ conversation_id: 'conv-9' }));
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'beta');
    expect(facadeLog.restored).toEqual([{ id: 'conv-9', activate: true }]);
    // Clicking a Running row goes to the turn already streaming there; seeding
    // it would start a second turn in the same chat.
    expect(facadeLog.sent).toHaveLength(0);
    expect(facadeLog.created).toBe(0);
    expect(posts).toContainEqual({ type: 'jobOpened', panelId: 1, id: 'beta' });
  });

  it('falls back to the discuss chat when the stored id no longer resolves', async () => {
    await store.saveState('beta', state({ conversation_id: 'gone' }));
    const bridge = makeBridge({
      restoreError: new Error('Forge: conversation could not be restored.'),
    });
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'beta');
    expect(facadeLog.created).toBe(1);
    expect(facadeLog.sent[0]!.id).toBe('new-chat');
    expect(facadeLog.sent[0]!.text).toContain('Job "Beta"');
    // The new id is persisted, so the next click reuses this chat.
    expect((await store.load('beta'))!.state.conversation_id).toBe('new-chat');
    expect(posts).toContainEqual({ type: 'jobOpened', panelId: 1, id: 'beta' });
  });

  it('says the chats are full, not that the job is running, when a restore hits the cap', async () => {
    // A Running job whose stored chat id cannot be restored while every tab is
    // taken. The discuss path would refuse it with "is running" first, so the
    // capacity reason — archive a chat — never reaches the panel.
    await store.saveState(
      'beta',
      state({ conversation_id: 'conv-9', task_run: { started_at: 1 } }),
    );
    const reasons = ['7 running a turn'];
    const bridge = makeBridge({
      restoreError: new ChatCapacityError(reasons, chatCapMessage(reasons)),
    });
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'beta');
    expect(facadeLog.restored).toEqual([{ id: 'conv-9', activate: true }]);
    expect(errors()[0]).toContain('no open chat can be archived');
    expect(errors()[0]).toContain('7 running a turn');
    // Never reaches the discuss path: no chat created, no seed sent, and the
    // panel is not told the job opened.
    expect(facadeLog.created).toBe(0);
    expect(facadeLog.sent).toHaveLength(0);
    expect(posts.some((msg) => msg.type === 'jobOpened')).toBe(false);
  });

  it('opens the discuss chat for a job with no agent action', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'alpha');
    expect(facadeLog.restored).toHaveLength(0);
    expect(facadeLog.created).toBe(1);
    expect(facadeLog.sent[0]!.text).toContain('Job "Alpha"');
  });

  it('says the job is gone rather than navigating on a stale row', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await store.delete('alpha');
    await bridge.clickJob(1, 'alpha');
    expect(facadeLog.restored).toHaveLength(0);
    expect(facadeLog.created).toBe(0);
    expect(errors()[0]).toContain('no longer exists');
    expect(posts.some((msg) => msg.type === 'jobOpened')).toBe(false);
  });

  it('refuses to seed a chat while its task run is in flight', async () => {
    await store.saveState('alpha', state({ task_run: { started_at: 1 } }));
    const bridge = makeBridge();
    bridge.openPanel(1);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'alpha');
    expect(facadeLog.created).toBe(0);
    expect(errors()[0]).toContain('is running');
    expect(posts.some((msg) => msg.type === 'jobOpened')).toBe(false);
  });

  it('navigates nothing for a generation that has closed', async () => {
    const bridge = makeBridge();
    bridge.openPanel(1);
    bridge.openPanel(2);
    await waitFor(() => snapshots().length > 0);
    await bridge.clickJob(1, 'beta'); // a click from the panel that was replaced
    expect(facadeLog.restored).toHaveLength(0);
    expect(facadeLog.created).toBe(0);
  });
});
