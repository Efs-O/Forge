/**
 * Incremental head+tail output cap for a stream that is read as it arrives.
 *
 * `spawnAndWait` (and the background path) consume a child's stdout/stderr in
 * `data` chunks. Accumulating the whole stream in a string lets a command that
 * writes gigabytes pin that much in the extension host's memory for the life of
 * the call. This keeps only the first quarter and the last three quarters of a
 * fixed budget, discarding the middle as it goes, so the retained buffer never
 * grows past `maxChars` no matter how much the child writes — while the pipes
 * keep draining (every chunk is consumed; only the middle is dropped).
 *
 * The head+tail split matches the model-facing formatter (`storedStream` in
 * tools/execHelpers.ts, `STORED_HEAD_SHARE = 0.25`), so what the model
 * eventually sees is a faithful head+tail of the real output. The 200k budget
 * matches the background path's `MAX_BACKGROUND_OUTPUT_CHARS`; the formatter
 * then applies its own smaller bound on what returns to the model.
 */
export const MAX_FOREGROUND_OUTPUT_CHARS = 200_000;

const HEAD_SHARE = 0.25;

export class RollingOutputCap {
  private readonly headSize: number;
  private readonly tailSize: number;
  private head = '';
  private tail = '';
  private total = 0;

  constructor(maxChars: number = MAX_FOREGROUND_OUTPUT_CHARS) {
    this.headSize = Math.floor(maxChars * HEAD_SHARE);
    this.tailSize = maxChars - this.headSize;
  }

  /** Consume a chunk. The buffer is bounded regardless of how much is fed. */
  append(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headSize) {
      const take = Math.min(this.headSize - this.head.length, chunk.length);
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (chunk.length > 0) {
      this.tail += chunk;
      if (this.tail.length > this.tailSize) {
        this.tail = this.tail.slice(this.tail.length - this.tailSize);
      }
    }
  }

  /** Characters discarded from the middle. Zero while under the budget. */
  get dropped(): number {
    return Math.max(0, this.total - this.head.length - this.tail.length);
  }

  /** The retained text, with a marker where the middle was dropped. */
  text(): string {
    if (this.dropped <= 0) return this.head + this.tail;
    const marker = `\n[… ${String(this.dropped)} characters dropped …]\n`;
    return this.head + marker + this.tail;
  }
}
