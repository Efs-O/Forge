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
export interface SessionContext {
  workspaceName?: string;
  workspacePath?: string;
  forgeVersion?: string;
}

export class SessionLogger {
  private readonly filePath: string;
  private writtenCount = 0;
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
  }

  updateTitle(title: string): void {
    this.title = title;
  }

  flush(messages: ChatMessage[], model: string, usage?: SessionUsage): void {
    if (!this.headerWritten) {
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
