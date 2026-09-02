import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../llm/types';

const SESSIONS_DIR = path.join(os.homedir(), '.forge', 'sessions');

/**
 * Session-to-date token totals, as accumulated on the conversation by
 * `applyUsage`. Cumulative rather than per-turn: they survive a window reload
 * (`sessionPersistence` round-trips them), so a reader can take the last
 * `usage` line in the file and have the whole session's total.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  /**
   * Accumulated model work + tool execution, excluding approval waits. Not
   * recoverable from the line timestamps, which cannot tell a turn that took
   * ten minutes from one that sat waiting for a confirmation click.
   */
  activeTimeMs?: number;
}

/**
 * Written once into `session_start`. `~/.forge/sessions` is flat, so a reader
 * has no parent folder to attribute a session to the way one file per project
 * would give it — without the workspace recorded here every Forge session is
 * indistinguishable from every other. `forgeVersion` is for the reader that
 * meets a format change years from now.
 */
/** One completed compaction, as recorded in the session transcript. */
export interface CompactionLogEntry {
  /** How many times this conversation has been compacted, including this one. */
  generation: number;
  /** Index into `conv.messages` from which the model still sees real turns. */
  fromIndex: number;
  /** Exact server-reported context at the moment of the cut, prompt + completion. */
  usedTokens: number;
  /** Per-slot window, 0 when the model has no configured context. */
  maxTokens: number;
  /** Size of the summary that replaced the cut turns. */
  summaryChars: number;
  /** Which path started this compaction. */
  trigger: string;
  /** Configured `auto_compact.at` when the event fired; absent when unset. */
  threshold?: number;
}

export interface SessionContext {
  workspaceName?: string;
  workspacePath?: string;
  forgeVersion?: string;
}

/**
 * How much of the file's tail is scanned for the resume cursor. The cursor is
 * appended at the end of every flush that wrote anything, so it sits within a
 * few hundred bytes of EOF in practice; the window only has to be wider than
 * one turn's worth of trailing lines.
 */
const CURSOR_SCAN_BYTES = 1024 * 1024;

/**
 * Recover `writtenCount` from a file an earlier run left behind.
 *
 * Returns 0 when there is nothing to recover, which reproduces the old
 * behaviour (re-write the history) rather than risking the opposite error of
 * skipping messages that were never logged.
 */
function readResumeCursor(filePath: string): number {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return 0;
    const start = Math.max(0, size - CURSOR_SCAN_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line || !line.includes('"cursor"')) continue;
      const parsed = JSON.parse(line) as { type?: string; written_count?: unknown };
      if (parsed.type === 'cursor' && typeof parsed.written_count === 'number') {
        return parsed.written_count;
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* non-fatal */
      }
    }
  }
}

export class SessionLogger {
  private readonly filePath: string;
  private writtenCount: number;
  private headerWritten = false;
  private lastUsage: SessionUsage | null = null;

  constructor(
    private readonly sessionId: string,
    private title: string,
    _model: string,
    private readonly context: SessionContext = {},
  ) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    } catch {
      /* non-fatal */
    }
    this.filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    // A reload builds a fresh logger over the *same* file, since the path comes
    // from the persisted conversation id. With the cursor living only in
    // memory, `messages.slice(0)` then re-appended the entire conversation on
    // the first flush of every run: one audited session had seven copies of its
    // own history, 14 MB of a 20 MB file, and every per-tool failure rate read
    // off it was inflated sevenfold.
    //
    // Seeding from disk is safe because `conv.messages` is append-only —
    // compaction is non-destructive (it records a summary and a cut index; see
    // CompactionService), so the array the cursor indexes into never shrinks.
    this.writtenCount = readResumeCursor(this.filePath);
  }

  updateTitle(title: string): void {
    this.title = title;
  }

  /**
   * Writes `session_start` once per run. Extracted from `flush` because a
   * compaction row can be the first thing this run appends, and a file whose
   * first row for a run carries no `forge_version` cannot be attributed to a
   * build afterwards.
   */
  private ensureHeader(model: string): void {
    if (this.headerWritten) return;
    const { workspaceName, workspacePath, forgeVersion } = this.context;
    this.append({
      type: 'session_start',
      session_id: this.sessionId,
      title: this.title,
      model,
      timestamp_ms: Date.now(),
      ...(workspaceName ? { workspace_name: workspaceName } : {}),
      ...(workspacePath ? { workspace_path: workspacePath } : {}),
      ...(forgeVersion ? { forge_version: forgeVersion } : {}),
    });
    this.headerWritten = true;
  }

  /**
   * Records one completed compaction.
   *
   * Nothing else on disk marks a compaction. `applyCompactionWindow` builds the
   * replacement context at request time and never mutates `conv.messages`, so
   * the summary preamble is not persisted, and the only surviving trace was the
   * `RESUME_PROMPT` user row — absent entirely for a manual `/compact` or when
   * `auto_compact.resume` is off.
   *
   * `used_tokens` is the exact pre-compaction figure the inference server
   * reported. The post-compaction size is deliberately NOT recorded: it does
   * not exist yet at this point (see `opResetReportedContext`) and the only way
   * to produce one would be the chars-per-token estimate that
   * `util/contextBudget` forbids from reaching a consumer. The next `usage`
   * row is the exact "after", so pair on that instead.
   *
   * `threshold` is the configured `auto_compact.at` at the moment of the
   * event, which is what makes a fraction-triggered compaction distinguishable
   * from one the context-exhaustion path forced below the threshold — without
   * threading a reason through five files to get here.
   */
  logCompaction(entry: CompactionLogEntry, model: string): void {
    this.ensureHeader(model);
    this.append({
      type: 'compaction',
      generation: entry.generation,
      from_index: entry.fromIndex,
      used_tokens: entry.usedTokens,
      max_tokens: entry.maxTokens,
      summary_chars: entry.summaryChars,
      trigger: entry.trigger,
      ...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
      timestamp_ms: Date.now(),
      model,
    });
  }

  flush(messages: ChatMessage[], model: string, usage?: SessionUsage): void {
    const startedAt = this.writtenCount;
    this.ensureHeader(model);

    const newMessages = messages.slice(this.writtenCount);
    for (const msg of newMessages) {
      this.writtenCount++;
      if (msg.role === 'system') continue;

      if (msg.tool_calls?.length) {
        const toolLine: Record<string, unknown> = {
          role: msg.role,
          content: null,
          tool_calls: msg.tool_calls.map((tc) => ({
            name: tc.function.name,
            input: (() => {
              try {
                return JSON.parse(tc.function.arguments) as unknown;
              } catch {
                return {};
              }
            })(),
          })),
          timestamp_ms: Date.now(),
          model,
        };
        // Reasoning belongs on tool-call turns most of all: that is where the
        // model decides what to do, and where it goes wrong. `ToolCallingLoop`
        // deliberately carries it onto these messages, and this branch dropped
        // it — so a 56-round session persisted thinking for exactly one turn,
        // the final one. Reviewing why an agent spiralled meant reading tool
        // calls and guessing at the reasoning behind them.
        if (msg.reasoning) toolLine['reasoning'] = msg.reasoning;
        this.append(toolLine);
        continue;
      }

      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'text')
                .map((p) => ('text' in p ? p.text : ''))
                .join('\n')
            : null;

      // A turn that produced only reasoning — cut off, refused, or interrupted
      // mid-thought — still says why. Requiring content dropped those entirely.
      if (!content && !msg.reasoning) continue;

      const line: Record<string, unknown> = {
        role: msg.role,
        content: content ?? '',
        timestamp_ms: Date.now(),
        model,
      };
      if (msg.reasoning) line['reasoning'] = msg.reasoning;
      this.append(line);
    }

    this.appendUsage(usage, model);
    // Written last so the value is only durable once the lines it accounts for
    // are. A reader that does not know this row can skip it the way it skips
    // `usage`; a crash between the two loses at most one turn to a re-write.
    if (this.writtenCount !== startedAt) {
      this.append({
        type: 'cursor',
        written_count: this.writtenCount,
        timestamp_ms: Date.now(),
      });
    }
  }

  /**
   * Forge has always had exact counters — the server reports them per round and
   * the context bar reads them — but they stopped at the sidebar and never
   * reached the transcript on disk. Anything reading these files afterwards had
   * to estimate generated volume from character counts, which cannot see
   * thinking tokens at all. One line per change closes that.
   *
   * Written only when a total actually moved, so re-flushing an idle
   * conversation does not pad the file with identical lines.
   */
  private appendUsage(usage: SessionUsage | undefined, model: string): void {
    if (!usage) return;
    if (usage.outputTokens <= 0 && usage.inputTokens <= 0) return;
    if (
      this.lastUsage &&
      this.lastUsage.inputTokens === usage.inputTokens &&
      this.lastUsage.outputTokens === usage.outputTokens &&
      this.lastUsage.requestCount === usage.requestCount
    ) {
      return;
    }
    this.lastUsage = { ...usage };
    this.append({
      type: 'usage',
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      model_request_count: usage.requestCount,
      // Carried on the line but deliberately not part of the change check
      // above: active time moves continuously, and gating on it would append a
      // line every flush whether or not the model did anything.
      ...(usage.activeTimeMs !== undefined ? { active_time_ms: usage.activeTimeMs } : {}),
      timestamp_ms: Date.now(),
      model,
    });
  }

  private append(obj: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(obj) + '\n', 'utf8');
    } catch {
      /* non-fatal */
    }
  }
}
