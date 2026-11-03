import type { RequestCapture } from './requestStats';
import { requestStatsRow } from './requestStats';

/** One turn's server-reported totals, summed over only the requests that reported them. */
export interface TurnSpeedTotals {
  generatedTokens: number;
  generatedMs: number;
  readTokens: number;
  readMs: number;
}

/**
 * Per-conversation turn speed state, owned by the turn runner.
 *
 * The turn runner is where every model request of a turn already passes
 * (`onRequestStats`), so it is where the sums are built: the Telegram code
 * cannot see requests, and a collector in the transport would have to be told
 * which request belongs to which turn.
 */
export interface TurnSpeedLedger {
  /** One request settled. Only its numbers are read; nothing is stored per request. */
  record(conversationId: string, capture: RequestCapture): void;
  /** A turn starts: anything left from a turn that never ended is dropped. */
  beginTurn(conversationId: string): void;
  /**
   * A turn ended with an answer. Sums what reported, clears the running totals,
   * and keeps the line for the reply that will carry it. Undefined when no
   * request of this turn reported server timings.
   */
  finishTurn(conversationId: string): string | undefined;
  /** A turn ended without an answer, so there is no reply to carry a line. */
  abandonTurn(conversationId: string): void;
  /**
   * The line for this turn's reply, handed out once. The second ask gets
   * undefined, so a turn cannot deliver its speed twice — once as an echoed
   * answer and again as the queue's own notification.
   */
  takeLine(conversationId: string): string | undefined;
}

/**
 * The one line a Telegram reply ends with, or undefined when there is nothing
 * honest to say. A wall-clock estimate is never shown: without server timings
 * there is no line at all.
 *
 * Example: `Speed: 1,830 tokens at 41.7 tok/s · read 12,400 at 820.0 tok/s`.
 * Each half appears only when that side reported; a turn that reported only
 * generation says only generation. Rates carry one decimal, like `/speed`
 * already does, and token counts carry thousands separators.
 */
export function formatSpeedLine(totals: TurnSpeedTotals): string | undefined {
  const parts: string[] = [];
  const generated = generationPart(totals);
  if (generated) parts.push(generated);
  const read = readPart(totals);
  if (read) parts.push(read);
  return parts.length ? `Speed: ${parts.join(' · ')}` : undefined;
}

function generationPart(totals: TurnSpeedTotals): string | undefined {
  const rate = tokensPerSecond(totals.generatedTokens, totals.generatedMs);
  return rate === undefined
    ? undefined
    : `${count(totals.generatedTokens)} tokens at ${rate} tok/s`;
}

function readPart(totals: TurnSpeedTotals): string | undefined {
  const rate = tokensPerSecond(totals.readTokens, totals.readMs);
  return rate === undefined ? undefined : `read ${count(totals.readTokens)} at ${rate} tok/s`;
}

/** Tokens per second, one decimal, undefined when either number or a positive time is missing. */
function tokensPerSecond(tokens: number, milliseconds: number): string | undefined {
  if (!Number.isFinite(tokens) || !Number.isFinite(milliseconds)) return undefined;
  if (tokens <= 0 || milliseconds <= 0) return undefined;
  return ((tokens / milliseconds) * 1_000).toFixed(1);
}

const thousands = new Intl.NumberFormat('en-US');

function count(value: number): string {
  return thousands.format(Math.round(value));
}

/**
 * The ledger itself. State exists only between a turn's start and its end, so
 * there is nothing to expire and no per-conversation cleanup to forget: a turn
 * that dies mid-flight is dropped by the next turn's `beginTurn`, and a
 * conversation that is evicted mid-turn simply loses its in-flight sums.
 */
export function createTurnSpeedLedger(): TurnSpeedLedger {
  interface TurnState {
    totals: TurnSpeedTotals;
    /** Set by `finishTurn`; `takeLine` hands it out once and clears it. */
    line?: string | undefined;
  }
  const turns = new Map<string, TurnState>();

  const stateFor = (conversationId: string): TurnState => {
    const existing = turns.get(conversationId);
    if (existing) return existing;
    const fresh: TurnState = {
      totals: { generatedTokens: 0, generatedMs: 0, readTokens: 0, readMs: 0 },
    };
    turns.set(conversationId, fresh);
    return fresh;
  };

  return {
    record: (conversationId, capture) => {
      addRequest(turns.get(conversationId) ?? stateFor(conversationId), capture);
    },
    beginTurn: (conversationId) => {
      turns.delete(conversationId);
    },
    finishTurn: (conversationId) => {
      const state = turns.get(conversationId);
      const line = state ? formatSpeedLine(state.totals) : undefined;
      if (!state) return undefined;
      state.line = line;
      state.totals = { generatedTokens: 0, generatedMs: 0, readTokens: 0, readMs: 0 };
      return line;
    },
    abandonTurn: (conversationId) => {
      turns.delete(conversationId);
    },
    takeLine: (conversationId) => {
      const state = turns.get(conversationId);
      if (!state || state.line === undefined) return undefined;
      const line = state.line;
      // Handed out once: the answer of a chat-originated turn is delivered by
      // one path or the other, never by both, and the second caller must not
      // put the same speed line on a second message.
      state.line = undefined;
      return line;
    },
  };
}

/**
 * Adds one request's server numbers to the turn's sums.
 *
 * `requestStatsRow` is reused rather than re-mapping keys here: it already
 * knows that llama.cpp and Strata report `predicted_n` / `predicted_ms` /
 * `prompt_n` / `prompt_ms` inside `timings`, that `prompt_n` counts only the
 * tokens actually processed (a cached prompt arrives as `cache_n`, so these are
 * the newly read tokens the line wants), and that native Ollama reports
 * `eval_count` / `prompt_eval_count` as usage and its times as nanosecond
 * durations. A second table of provider key names here would drift from the one
 * the session log already uses the first time a provider changed its shape.
 */
function addRequest(state: { totals: TurnSpeedTotals }, capture: RequestCapture): void {
  const row = requestStatsRow(capture.stats, capture.model, capture.sentAtMs);
  const totals = state.totals;
  const server = row.server;
  if (server) {
    if (typeof server.predicted_n === 'number' && typeof server.predicted_ms === 'number') {
      totals.generatedTokens += server.predicted_n;
      totals.generatedMs += server.predicted_ms;
    }
    if (typeof server.prompt_n === 'number' && typeof server.prompt_ms === 'number') {
      totals.readTokens += server.prompt_n;
      totals.readMs += server.prompt_ms;
    }
  }
  const ollama = row.ollama;
  if (ollama) {
    if (typeof ollama.eval_ms === 'number' && typeof row.completion_tokens === 'number') {
      totals.generatedTokens += row.completion_tokens;
      totals.generatedMs += ollama.eval_ms;
    }
    if (typeof ollama.prompt_eval_ms === 'number' && typeof row.prompt_tokens === 'number') {
      totals.readTokens += row.prompt_tokens;
      totals.readMs += ollama.prompt_eval_ms;
    }
  }
}
