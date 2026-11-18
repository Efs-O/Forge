/**
 * The desktop's job runner for laptop media (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md):
 * the queue, the standing-consent gate, the job-scoped tool instances, and the
 * sweep. The files a job owns live in `remoteMediaJobStore.ts`, what the desktop
 * advertises in `remoteMediaCapabilities.ts`, the HTTP shape in
 * `remoteMediaRoutes.ts`. The jobs live here and not in `CloudRelayServer`: a
 * relay restart on a port or body-cap change must not touch a running render.
 */
import { createReadStream } from 'fs';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { SdServerBackend } from '../backend/SdServerBackend';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { isProcessAlive } from '../util/processLiveness';
import { isPathInside } from '../util/pathContainment';
import { backendCostTag, pickBackend } from '../tools/imageGeneration/generateImageToolFormat';
import {
  makeGenerateImageTool,
  type GenerateImageDeps,
} from '../tools/imageGeneration/generateImageTool';
import {
  makeUpscaleImageTool,
  type UpscaleImageDeps,
} from '../tools/imageGeneration/upscaleImageTool';
import type { RegisteredTool } from '../tools/ToolRegistry';
import {
  REMOTE_MEDIA_PATH_ARGS,
  REMOTE_MEDIA_TEXT,
  type RemoteMediaCapabilities,
  type RemoteMediaJobRequest,
  type RemoteMediaTool,
} from './remoteMediaContract';
import { buildCapabilities } from './remoteMediaCapabilities';
import {
  Job,
  JobNotifier,
  errText,
  isPlainRelative,
  kindOf,
  mimeOf,
  readRecord,
  recordOf,
  statusOf,
  writeFileRecord,
  type JobRecord,
  type JobState,
  type StoredFile,
} from './remoteMediaJobStore';
import { desktopPathsToNames, toolResultText } from './remoteMediaResultText';
import { jsonReply, type MediaReply, type RemoteMediaPort } from './remoteMediaRoutes';

const log = getLogger();

/** How often to sweep; a finished job's files stay fetchable until `job_ttl_minutes` expires. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** Phase 1: the other two tools answer 400 with the reason. */
const SERVED_TOOLS: readonly RemoteMediaTool[] = ['generate_image', 'upscale_image'];

/** The contract's `result` ceiling; a longer tool answer is cut, not refused. */
const MAX_RESULT_CHARS = 20_000;

export interface RemoteMediaJobsDeps {
  getConfig: () => ForgeConfig;
  /** `<globalStorage>/remote-media`; every job owns one folder inside it. */
  root: string;
  /** The desktop's own secrets, for a paid backend it is allowed to render. */
  secrets: vscode.SecretStorage | undefined;
  /** The window's live `sd-server` handles, shared with desktop chats. */
  sdServers?: () => ReadonlyMap<string, SdServerBackend>;
  /**
   * Merged into the job-scoped tool deps. Production passes nothing; a unit
   * test injects `generate` / `generateLocal` / `run` so a job needs no GPU and
   * no network key, and can prove nothing was spawned for a refused call.
   */
  imageDeps?: Partial<GenerateImageDeps>;
  upscaleDeps?: Partial<UpscaleImageDeps>;
  /** Injectable clock, for the TTL sweep. */
  now?: () => number;
}

/** What the standing-consent gate knows about one call. */
interface Consent {
  name: string;
  /** The `cloud_relay.media` field that has to list it, named in the refusal. */
  list: string;
  listed: boolean;
  /** Whether listing is required at all for this call. */
  required: boolean;
  /** The approval detail, so the refusal says what was about to happen. */
  detail: string;
}

export class RemoteMediaJobs implements RemoteMediaPort {
  private readonly active = new Map<string, Job>();
  private waiting: Job[] = [];
  private running: Job | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: RemoteMediaJobsDeps) {
    this.timer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    // The plan's ledger: the jobs the previous owner left behind are reclaimed
    // here, at the start of the window that takes over the relay.
    void this.runSweep();
  }

  /** Off unless the relay itself and its media block are both on. */
  enabled(): boolean {
    const relay = this.deps.getConfig().cloud_relay;
    return relay?.enabled === true && relay.media?.enabled === true;
  }

  /** A config change that turns either switch off aborts the running render
   *  and fails everything queued (`failed: disabled`). */
  applyConfig(): void {
    if (this.disposed || this.enabled()) return;
    this.failAll('disabled');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.failAll('disabled');
  }

  private failAll(reason: string): void {
    const queued = this.waiting;
    this.waiting = [];
    for (const job of queued) this.finish(job, 'failed', reason);
    if (this.running) {
      this.running.controller.abort();
      this.finish(this.running, 'failed', reason);
    }
  }

  // ── The five things the routes ask for ────────────────────────────────────

  capabilities(): RemoteMediaCapabilities {
    return buildCapabilities(this.deps.getConfig(), (root) => ({
      generate_image: this.imageTool(root, () => undefined),
      upscale_image: this.upscaleTool(root, () => undefined),
    }));
  }

  async create(request: RemoteMediaJobRequest): Promise<MediaReply> {
    const media = this.deps.getConfig().cloud_relay?.media;
    if (!media?.enabled) return jsonReply(404, { error: REMOTE_MEDIA_TEXT.off });
    if (!SERVED_TOOLS.includes(request.tool)) {
      return jsonReply(400, { error: `${request.tool} is not served yet` });
    }
    const paths = this.rewritePathArgs(request);
    if (!paths.ok) return jsonReply(400, { error: paths.text });
    // A spent queue slot leaves no folder behind, so the cap is checked before
    // anything is written, and before the approval gate reads anything.
    if (this.waiting.length >= media.queue_limit) {
      return jsonReply(429, { error: REMOTE_MEDIA_TEXT.queueFull(media.queue_limit) });
    }
    const job = new Job(randomUUID(), request.tool, request.client, paths.args, this.deps.root);
    const consent = await this.consentFor(
      request.tool,
      paths.args,
      this.toolFor(job, () => {}),
    );
    if (consent?.required && !consent.listed) {
      return jsonReply(403, {
        error: REMOTE_MEDIA_TEXT.notListed(consent.detail, consent.name, consent.list),
      });
    }
    await this.accept(job, request);
    return jsonReply(202, { id: job.id });
  }

  async status(id: string): Promise<MediaReply> {
    const record = await this.recordFor(id);
    return record ? jsonReply(200, statusOf(record)) : jsonReply(404, { error: `no job ${id}` });
  }

  /** This window's own answer for a job it owns (its disk write may still be in
   *  flight), or the folder's record for any other job. */
  private async recordFor(id: string): Promise<JobRecord | undefined> {
    const job = this.active.get(id);
    return job ? recordOf(job) : readRecord(path.join(this.deps.root, id));
  }

  async file(id: string, name: string): Promise<MediaReply> {
    const dir = path.join(this.deps.root, id);
    const record = await this.recordFor(id);
    if (!record) return jsonReply(404, { error: `no job ${id}` });
    // A file is fetchable only once the job is done, and only by a name the job
    // listed: nothing else in the folder is reachable from the laptop.
    const listed = (record.files ?? []).find((entry) => entry.name === name);
    const absolute = listed ? path.resolve(dir, ...listed.path.split(/[\\/]/u)) : '';
    if (record.state !== 'done' || !listed || !isPathInside(dir, absolute)) {
      return jsonReply(404, { error: `job ${id} has no finished file ${name}` });
    }
    return {
      status: 200,
      file: { stream: createReadStream(absolute), contentType: mimeOf(listed.name) },
    };
  }

  async cancel(id: string): Promise<MediaReply> {
    const job = this.active.get(id);
    if (job) {
      this.waiting = this.waiting.filter((entry) => entry !== job);
      if (!job.terminal) {
        job.controller.abort();
        this.finish(job, 'failed', 'cancelled');
      }
      return jsonReply(200, { state: job.state });
    }
    // Not in this window's memory: either it never existed, or the window that
    // owned it is gone — and then marking it is the whole of cancelling it.
    const dir = path.join(this.deps.root, id);
    const record = await readRecord(dir);
    if (!record) return jsonReply(404, { error: `no job ${id}` });
    if (record.state === 'queued' || record.state === 'running') {
      await writeFileRecord(dir, {
        ...record,
        state: 'failed',
        error: 'cancelled',
        ended_at: this.now(),
      });
      return jsonReply(200, { state: 'failed' });
    }
    return jsonReply(200, { state: record.state });
  }

  // ── Accepting and running one job ─────────────────────────────────────────

  /** Write the job's folders, its inputs and its `job.json`, then queue it. */
  private async accept(job: Job, request: RemoteMediaJobRequest): Promise<void> {
    await fs.mkdir(job.outDir, { recursive: true });
    await fs.mkdir(job.inputsDir, { recursive: true });
    for (const input of request.inputs ?? []) {
      await fs.writeFile(path.join(job.inputsDir, input.name), Buffer.from(input.base64, 'base64'));
    }
    this.active.set(job.id, job);
    this.waiting.push(job);
    await writeFileRecord(job.dir, recordOf(job));
    this.pump();
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.running = next;
    void this.run(next);
  }

  /** One job at a time: the desktop has one GPU, and two renders on it lie. */
  private async run(job: Job): Promise<void> {
    job.state = 'running';
    // A record that cannot be written is not the render's failure, but it must
    // not escape as an unhandled rejection: the terminal write is what matters.
    await writeFileRecord(job.dir, recordOf(job)).catch((err: unknown) =>
      log.warn(`remote media job ${job.id}: ${errText(err)}`),
    );
    const tool = this.toolFor(job, (absolute) => job.delivered.add(absolute));
    const context = {
      beforeMutate: (): void => undefined,
      abortSignal: job.controller.signal,
      conversationId: `remote-media:${job.id}`,
    };
    try {
      const result = await tool.handler(job.args, context);
      // A cancel or a disable already settled this job; its files stay listed.
      if (job.terminal) return;
      job.result = desktopPathsToNames(toolResultText(result), job.dir).slice(0, MAX_RESULT_CHARS);
      job.files = await this.listFiles(job);
      this.finish(job, 'done');
    } catch (error) {
      if (job.terminal) return;
      this.finish(
        job,
        'failed',
        job.controller.signal.aborted ? 'cancelled' : `the render failed: ${errText(error)}`,
      );
    } finally {
      this.running = undefined;
      this.pump();
    }
  }

  private finish(job: Job, state: JobState, error?: string): void {
    job.state = state;
    job.error = error;
    job.terminal = true;
    void writeFileRecord(job.dir, recordOf(job)).catch((err: unknown) =>
      log.warn(`remote media job ${job.id}: ${errText(err)}`),
    );
  }

  /** The files the job delivered: listed, and only these, are fetchable. */
  private async listFiles(job: Job): Promise<StoredFile[]> {
    const stored: StoredFile[] = [];
    for (const absolute of job.delivered) {
      const inside = path.relative(job.dir, absolute);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue;
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) continue;
        const name = path.basename(absolute);
        // One name, one file: a second file behind it is unreachable by name,
        // so it is left out rather than shadowing the first.
        if (stored.some((entry) => entry.name === name)) continue;
        stored.push({ name, bytes: stat.size, kind: kindOf(name), path: inside });
      } catch {
        // A file the tool stopped writing is not listed, so it stays unservable.
      }
    }
    return stored;
  }

  // ── Job-scoped tool instances ─────────────────────────────────────────────

  /**
   * A FRESH instance per job, with the job's own root as its workspace root, a
   * reveal that opens no desktop editor tab, and the window's real `sd-server`
   * handles, so a laptop render keeps one server warm for the desktop chats too.
   */
  private toolFor(job: Job, record: (absolutePath: string) => void): RegisteredTool {
    return job.tool === 'upscale_image'
      ? // `upscale_image` names its output beside the input and refuses a path
        // outside `workspaceRoot`, so its root is the job folder, not `out/`.
        this.upscaleTool(job.dir, record)
      : this.imageTool(job.outDir, record);
  }

  private imageTool(workspaceRoot: string, record: (path: string) => void): RegisteredTool {
    return makeGenerateImageTool({
      getConfig: this.deps.getConfig,
      secrets: this.deps.secrets,
      notifications: new JobNotifier(record),
      ...(this.deps.sdServers ? { sdServers: this.deps.sdServers } : {}),
      workspaceRoot,
      reveal: async () => undefined,
      ...this.deps.imageDeps,
    });
  }

  private upscaleTool(workspaceRoot: string, record: (path: string) => void): RegisteredTool {
    return makeUpscaleImageTool({
      getConfig: this.deps.getConfig,
      notifications: new JobNotifier(record),
      workspaceRoot,
      ...this.deps.upscaleDeps,
    });
  }

  // ── Standing consent ──────────────────────────────────────────────────────

  /**
   * What the owner has agreed to, for this call.
   *
   * The approval gate lives in the sidebar, so a direct `handler()` call never
   * reaches it: this file calls `tool.approval(args)` itself and treats the
   * `cloud_relay.media` listing as the standing consent that replaces the card.
   */
  private async consentFor(
    tool: RemoteMediaTool,
    args: Record<string, unknown>,
    instance: RegisteredTool,
  ): Promise<Consent | undefined> {
    const media = this.deps.getConfig().cloud_relay?.media;
    if (!media) return undefined;
    if (tool === 'upscale_image') {
      return {
        name: 'upscale_image',
        list: 'upscale',
        listed: media.upscale,
        required: true,
        detail: 'The configured local ESRGAN upscale',
      };
    }
    const image = this.deps.getConfig().image_generation;
    if (!image) return undefined;
    const backend = pickBackend(image, args['backend']);
    if (!backend) return undefined;
    // A paid provider bills the desktop's key, so it is served only by name,
    // even when the tool's own gate calls the call harmless.
    const approval = await instance.approval?.(args);
    return {
      name: backend.name,
      list: 'image_backends',
      listed: media.image_backends.includes(backend.name),
      required: approval?.dangerous === true || backend.provider !== 'sdcpp',
      detail: approval?.detail ?? `${backend.name} (${backendCostTag(backend)})`,
    };
  }

  // ── Path arguments ────────────────────────────────────────────────────────

  /**
   * Apply `REMOTE_MEDIA_PATH_ARGS` and rewrite what passes.
   *
   * An input argument's value must be the bare name of an uploaded input, and
   * becomes a path inside the job; an output argument must be a plain relative
   * path. Nothing else is accepted, so a refusal reads no desktop file.
   */
  private rewritePathArgs(
    request: RemoteMediaJobRequest,
  ): { ok: true; args: Record<string, unknown> } | { ok: false; text: string } {
    const args = { ...request.args };
    const uploaded = new Set((request.inputs ?? []).map((input) => input.name));
    for (const [arg, direction] of Object.entries(REMOTE_MEDIA_PATH_ARGS[request.tool])) {
      const value = args[arg];
      if (value === undefined) continue;
      if (direction === 'output') {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || !isPlainRelative(text)) {
          return { ok: false, text: REMOTE_MEDIA_TEXT.outputRefused(arg) };
        }
        continue;
      }
      if (direction === 'input-list') {
        const names = Array.isArray(value) ? value : [];
        if (!names.every((name) => typeof name === 'string' && uploaded.has(name))) {
          return { ok: false, text: REMOTE_MEDIA_TEXT.pathRefused(arg) };
        }
        args[arg] = names.map((name) => this.inputLink(request.tool, name as string));
        continue;
      }
      const name = typeof value === 'string' ? value.trim() : '';
      if (!uploaded.has(name)) return { ok: false, text: REMOTE_MEDIA_TEXT.pathRefused(arg) };
      args[arg] = this.inputLink(request.tool, name);
    }
    return { ok: true, args };
  }

  /**
   * How an uploaded input is named from the root that tool resolves against.
   *
   * `generate_image` gets `out/` as its root (the plan's choice), so its inputs
   * sit one level up. `upscale_image` cannot: its output name is derived beside
   * the input, so its root is the job folder and the input needs no `..`.
   */
  private inputLink(tool: RemoteMediaTool, name: string): string {
    return tool === 'upscale_image' ? `inputs/${name}` : `../inputs/${name}`;
  }

  private now = (): number => this.deps.now?.() ?? Date.now();

  /**
   * The plan's ledger sweep: a folder with a corrupt or missing `job.json` is
   * deleted, a finished job past `job_ttl_minutes` is deleted, and a job its
   * dead window left behind is failed. Runs at start and every 10 minutes.
   */
  async runSweep(): Promise<{ deleted: number; failed: number }> {
    const ttl = (this.deps.getConfig().cloud_relay?.media?.job_ttl_minutes ?? 60) * 60_000;
    const now = this.now();
    let deleted = 0;
    let failed = 0;
    let entries: string[];
    try {
      entries = await fs.readdir(this.deps.root);
    } catch {
      return { deleted, failed };
    }
    for (const entry of entries) {
      const dir = path.join(this.deps.root, entry);
      const record = await readRecord(dir);
      if (!record) {
        await fs.rm(dir, { recursive: true, force: true });
        deleted += 1;
        continue;
      }
      // A job this window is still running is never swept; one it has finished
      // is, so its folder and its memory cannot outlive the TTL.
      const owned = this.active.get(record.id);
      if (owned && !owned.terminal) continue;
      if (record.state === 'queued' || record.state === 'running') {
        if (!isProcessAlive(record.pid)) {
          await writeFileRecord(dir, {
            ...record,
            state: 'failed',
            error: 'desktop window closed',
            ended_at: now,
          });
          failed += 1;
        }
        continue;
      }
      if (now - (record.ended_at ?? record.created_at) >= ttl) {
        await fs.rm(dir, { recursive: true, force: true });
        if (owned) this.active.delete(record.id);
        deleted += 1;
      }
    }
    return { deleted, failed };
  }
}
