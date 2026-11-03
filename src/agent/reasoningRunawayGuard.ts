/** Owns request-local reasoning runaway detection.
 * It detects repeated completed units and an optional character cap.
 * This module is pure and has no runtime dependencies.
 * It does not read configuration or control a stream.
 */

export interface ReasoningRepetitionConfig {
  window_chars: number;
  min_unit_chars: number;
  min_coverage: number;
}

export interface ReasoningGuardConfig {
  max_reasoning_chars?: number;
  repetition?: ReasoningRepetitionConfig;
}

export type ReasoningRunaway =
  | { kind: 'repetition'; atChars: number; loopStartChars: number; repeatedUnit: string }
  | { kind: 'cap'; atChars: number };

interface Copy {
  start: number;
  end: number;
}

interface CopyBucket {
  copies: Copy[];
  head: number;
}

interface QueuedCopy {
  unit: string;
  copy: Copy;
}

export class ReasoningRunawayGuard {
  private readonly repetition?: ReasoningRepetitionConfig;
  private readonly maxReasoningChars?: number;
  private readonly units = new Map<string, CopyBucket>();
  private readonly copies: QueuedCopy[] = [];
  private copyHead = 0;
  private tail = '';
  private tailStart = 0;
  private discardingLongTail = false;
  private discardedPunctuation = false;
  private totalChars = 0;
  private didTrip = false;

  constructor(config: ReasoningGuardConfig) {
    if (config.max_reasoning_chars !== undefined) {
      this.positiveInteger(config.max_reasoning_chars, 'max_reasoning_chars');
      this.maxReasoningChars = config.max_reasoning_chars;
    }
    if (config.repetition !== undefined) {
      const { window_chars, min_unit_chars, min_coverage } = config.repetition;
      this.positiveInteger(window_chars, 'window_chars');
      this.positiveInteger(min_unit_chars, 'min_unit_chars');
      if (!Number.isFinite(min_coverage) || min_coverage <= 0 || min_coverage > 1) {
        throw new Error('min_coverage must be in (0, 1]');
      }
      this.repetition = config.repetition;
    }
  }

  get chars(): number {
    return this.totalChars;
  }

  get tripped(): boolean {
    return this.didTrip;
  }

  push(token: string): ReasoningRunaway | null {
    const startChars = this.totalChars;
    this.totalChars += token.length;
    if (this.didTrip) return null;

    if (this.repetition) {
      for (let index = 0; index < token.length; index += 1) {
        const character = token[index];
        const position = startChars + index;
        if (character === '\n') {
          if (!this.discardingLongTail) {
            const trip = this.finishUnit(position, position + 1);
            if (trip) return this.trip(trip);
          }
          this.tail = '';
          this.discardingLongTail = false;
          this.discardedPunctuation = false;
          this.tailStart = position + 1;
          continue;
        }

        if (this.discardingLongTail) {
          if (this.discardedPunctuation && /\s/.test(character)) {
            this.discardingLongTail = false;
            this.discardedPunctuation = false;
            this.tailStart = position + 1;
          } else {
            this.discardedPunctuation = character === '.' || character === '!' || character === '?';
          }
          continue;
        }

        if (/\s/.test(character) && this.tail.length > 0) {
          const last = this.tail[this.tail.length - 1];
          if (last === '.' || last === '!' || last === '?') {
            const trip = this.finishUnit(position, position + 1);
            if (trip) return this.trip(trip);
            this.tailStart = position + 1;
            continue;
          }
        }
        if (this.tail.length === 0) this.tailStart = position;
        this.tail += character;
        if (this.tail.length > this.repetition.window_chars) {
          this.tail = '';
          this.discardingLongTail = true;
          this.discardedPunctuation = character === '.' || character === '!' || character === '?';
        }
      }
      this.pruneExpiredCopies(this.totalChars);
    }

    if (this.maxReasoningChars !== undefined && this.totalChars > this.maxReasoningChars) {
      return this.trip({ kind: 'cap', atChars: this.totalChars });
    }
    return null;
  }

  private positiveInteger(value: number, field: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }

  private finishUnit(end: number, atChars: number): ReasoningRunaway | null {
    this.pruneExpiredCopies(atChars);
    const raw = this.tail;
    const leading = raw.length - raw.trimStart().length;
    const unit = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    const copy: Copy = { start: this.tailStart + leading, end };
    this.tail = '';
    if (!this.repetition || unit.length < this.repetition.min_unit_chars) return null;

    const cutoff = atChars - this.repetition.window_chars;
    if (copy.end <= cutoff) return null;
    let bucket = this.units.get(unit);
    if (!bucket) {
      bucket = { copies: [], head: 0 };
      this.units.set(unit, bucket);
    }
    bucket.copies.push(copy);
    this.copies.push({ unit, copy });
    const count = bucket.copies.length - bucket.head;
    if (
      count >= 2 &&
      (count * unit.length) / this.repetition.window_chars >= this.repetition.min_coverage
    ) {
      return {
        kind: 'repetition',
        atChars,
        loopStartChars: bucket.copies[bucket.head].start,
        repeatedUnit: unit.slice(0, 200),
      };
    }
    return null;
  }

  private pruneExpiredCopies(atChars: number): void {
    if (!this.repetition) return;
    const cutoff = atChars - this.repetition.window_chars;
    while (this.copyHead < this.copies.length && this.copies[this.copyHead].copy.end <= cutoff) {
      const expired = this.copies[this.copyHead];
      this.copyHead += 1;
      const bucket = this.units.get(expired.unit);
      if (bucket) {
        bucket.head += 1;
        if (bucket.head === bucket.copies.length) this.units.delete(expired.unit);
        else if (bucket.head > 64 && bucket.head * 2 > bucket.copies.length) {
          bucket.copies = bucket.copies.slice(bucket.head);
          bucket.head = 0;
        }
      }
    }
    if (this.copyHead > 1024 && this.copyHead * 2 > this.copies.length) {
      this.copies.splice(0, this.copyHead);
      this.copyHead = 0;
    }
  }

  private trip(runaway: ReasoningRunaway): ReasoningRunaway {
    this.didTrip = true;
    return runaway;
  }
}
