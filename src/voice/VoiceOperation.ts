import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { VoiceAudioHandle } from './VoiceTypes';

/**
 * Owns every temp file one utterance creates, and deletes them on every
 * terminal path -- success, rejection, refusal, cancellation, timeout, and a
 * draft that expires unconfirmed.
 *
 * Ownership lives here rather than in a `finally` at each call site because
 * there are six terminal paths and a missed one leaks the user's audio. The
 * operation id it mints is the correlation key for the §20.1 audit rows, so one
 * grep reconstructs an operation from ingress to admission.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §9.2, §20.1.
 */
export class VoiceOperation {
  private readonly owned: string[] = [];
  private disposed = false;

  private constructor(
    readonly id: string,
    private readonly dir: string,
  ) {}

  /**
   * Creates an operation with a private temp directory outside the workspace.
   * Workspace-local temp files would land in the user's repo and, on a mapped
   * network drive, in whatever is being indexed.
   */
  static async create(baseDir = os.tmpdir()): Promise<VoiceOperation> {
    const id = `v_${crypto.randomBytes(4).toString('hex')}`;
    const dir = await fs.mkdtemp(path.join(baseDir, `forge-voice-${id}-`));
    return new VoiceOperation(id, dir);
  }

  /** Absolute path for a new owned file. Nothing is created here. */
  reserve(basename: string): string {
    if (this.disposed) throw new Error(`voice operation ${this.id} is disposed`);
    const target = path.join(this.dir, basename);
    this.owned.push(target);
    return target;
  }

  /** Records a file that already exists on disk as an owned audio handle. */
  async adopt(filePath: string, mediaType: string): Promise<VoiceAudioHandle> {
    if (this.disposed) throw new Error(`voice operation ${this.id} is disposed`);
    if (!this.owned.includes(filePath)) this.owned.push(filePath);
    const stat = await fs.stat(filePath);
    return { path: filePath, bytes: stat.size, mediaType, operationId: this.id };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Deletes every owned file and the operation directory. Idempotent, because
   * the terminal paths overlap: a cancellation during transcription disposes,
   * and so does the ingress `finally` that follows it.
   *
   * Never throws. A failed unlink must not mask the transcription error that is
   * usually the more interesting half of the failure.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      this.owned.map((file) => fs.rm(file, { force: true }).catch(() => undefined)),
    );
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
