import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { RequestFingerprint } from '../sessions/requestFingerprint';
import type { RequestCapture } from '../sessions/requestStats';
import { RequestDumpWriter } from '../sessions/requestDump';
import {
  SessionLogger,
  type CompactionAttemptLogEntry,
  type CompactionLogEntry,
} from './SessionLogger';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { ForgeTurnEndKind } from './turnOutcome';

/** Undefined outside a real host (tests, or an unresolvable extension id). */
function forgeVersion(): string | undefined {
  const version = vscode.extensions.getExtension('Efsoo.forge-llm')?.packageJSON?.['version'];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Owns the per-conversation SessionLogger instances and routes turn,
 * compaction, and tool-request events into the append-only session transcript.
 */
export class SessionLogCoordinator {
  private readonly sessionLoggers = new Map<string, SessionLogger>();
  private readonly requestDumps = new RequestDumpWriter();

  constructor(
    private readonly getSidebar: () => SidebarRuntime,
    private readonly getConfig: () => ForgeConfig,
  ) {}

  /** Records a completed compaction on the same transcript as the turns. */
  logCompaction(convId: string, entry: CompactionLogEntry): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const logger = this.loggerFor(conv);
    logger.updateTitle(conv.title);
    logger.logCompaction(entry, conv.active_model ?? '');
  }

  /** Start, terminal and suppressed rows for one compaction attempt. */
  logCompactionAttempt(convId: string, entry: CompactionAttemptLogEntry): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    this.loggerFor(conv).logCompactionAttempt(entry, conv.active_model ?? '');
  }

  /** Records the tool names and the head of a model request through its session log. */
  logToolsOffered(convId: string, names: readonly string[], fingerprint: RequestFingerprint): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const logger = this.loggerFor(conv);
    logger.updateTitle(conv.title);
    logger.logToolsOffered(names, conv.active_model ?? '');
    logger.logRequestPrefix(fingerprint, conv.active_model ?? '');
  }

  /** Appends request stats and queues an opt-in exact-body dump. */
  logRequestStats(convId: string, capture: RequestCapture): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const model = conv.active_model ?? '';
    const logger = this.loggerFor(conv);
    logger.updateTitle(conv.title);
    const row = logger.logRequestStats(capture.stats, model);
    const settings = this.getConfig().record_requests;
    if (!settings?.enabled) return;
    this.requestDumps.enqueue(
      {
        conversationId: convId,
        request: capture.body,
        url: capture.url,
        model: capture.model,
        sentAtMs: capture.sentAtMs,
        stats: row,
      },
      { maxBytes: settings.max_mb * 1024 * 1024, keepHours: settings.keep_hours },
    );
  }

  /** Records why a turn stopped, next to the rows it produced before stopping. */
  logTurnError(convId: string, message: string): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    this.loggerFor(conv).logTurnError(message, conv.active_model ?? '');
  }

  logTurnStopped(convId: string, kind: 'cancelled' | 'interrupted'): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    this.loggerFor(conv).logTurnStopped(kind, conv.active_model ?? '');
  }

  logTurnEnd(
    convId: string,
    outcome: ForgeTurnEndKind,
    rounds: number,
    finishReason?: string | null,
  ): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv) return;
    this.loggerFor(conv).logTurnEnd(outcome, rounds, finishReason, conv.active_model ?? '');
  }

  private loggerFor(conv: ConversationRuntime): SessionLogger {
    const existing = this.sessionLoggers.get(conv.id);
    if (existing) return existing;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const logger = new SessionLogger(conv.id, conv.title, conv.active_model ?? '', {
      ...(folder ? { workspaceName: folder.name, workspacePath: folder.uri.fsPath } : {}),
      ...(forgeVersion() ? { forgeVersion: forgeVersion()! } : {}),
    });
    this.sessionLoggers.set(conv.id, logger);
    return logger;
  }

  /**
   * Appends new transcript rows to the on-disk log under ~/.forge. Incremental
   * (cursor-based), so it is safe per tool round as well as at turn end.
   * `settledOnly` (the per-round path) holds back a trailing assistant row
   * that may still be streaming: the cursor would move past it, and the log
   * would keep its half-written text for good.
   */
  flushSessionLog(convId: string, settledOnly = false): void {
    const conv = this.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    const last = conv.messages[conv.messages.length - 1];
    const unsettled = settledOnly && last?.role === 'assistant' && !last.tool_calls?.length;
    const messages = unsettled ? conv.messages.slice(0, -1) : conv.messages;
    const logger = this.loggerFor(conv);
    logger.updateTitle(conv.title);
    logger.flush(messages, conv.active_model ?? '', {
      inputTokens: conv.input_tokens ?? 0,
      outputTokens: conv.output_tokens ?? 0,
      requestCount: conv.model_request_count ?? 0,
      ...(conv.active_time_ms !== undefined ? { activeTimeMs: conv.active_time_ms } : {}),
    });
  }
}
