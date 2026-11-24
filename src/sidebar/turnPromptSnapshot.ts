/**
 * The prompt head, snapshotted once per turn. Split out of `ModelTurn.ts`:
 * everything below is read again by `prepareMessages` on every tool round, so
 * what is captured here is deliberately frozen for the whole turn.
 */
import * as vscode from 'vscode';
import type { ConversationRuntime } from './sessionTypes';
import type { ModelTurnContext } from './ModelTurn';
import {
  freezeTurnContextAndConsumeResumeNote,
  isNewChatFirstTurn,
  type TurnContextState,
} from './turnContext';
import { pinForgeInstructions, type PinnedTurnInstructions } from './forgeInstructionsPin';
import { formatCompactionResumeNote } from './compactionTypes';
import { localDate } from '../util/localClock';
import { terminalCommandTracker } from '../tools/TerminalCommandTracker';

/** The three turn services a prompt head reads: the fields of
 *  `ModelTurnContext` this snapshot needs, so the turn passes itself. */
export type TurnPromptSnapshotSource = Pick<
  ModelTurnContext,
  'remoteReach' | 'forgeLoader' | 'listMemoryLines'
>;

/** The active terminal's working directory, as the block names it. */
function activeTerminalCwd(): string | undefined {
  const cwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
  if (!cwd) return undefined;
  return cwd.scheme === 'file' ? cwd.fsPath : cwd.toString(true);
}

/**
 * Builds the once-per-turn `TurnContextState` and pins the project
 * instructions beside it. `instructions` is returned as well as folded in:
 * the request's system prompt needs `instructions.system` every round.
 *
 * Side effect, and it runs last: `freezeTurnContextAndConsumeResumeNote`
 * writes the snapshot into the transcript and consumes
 * `conv.compaction.resumeNote`, so a later round cannot read it again.
 */
export function snapshotTurnPromptHead(
  ctx: TurnPromptSnapshotSource,
  conv: ConversationRuntime,
  activeFile: string | undefined,
  unattended: boolean,
): { turnContext: TurnContextState; instructions: PinnedTurnInstructions } {
  // Layer C is snapshotted HERE, once per turn, not rebuilt per round.
  // `prepareMessages` runs again on every tool round, so reading `conv.plan`
  // live meant an `update_plan` mid-turn rewrote a message sitting just after
  // the system prompt -- the block folds into the last USER message, and on
  // round N that is the request that opened the turn. Measured on a 4-round
  // turn with three update_plan calls: cache reuse fell from 76% to 39%, and
  // two consecutive 186-token prompt growths re-evaluated 15401 tokens (~20 s).
  // It need not be re-rendered: update_plan's result confirms the write, and the
  // new plan reaches the next USER turn, which extends the prefix anyway. `items`
  // is copied so a later in-place edit of conv.plan cannot reach this prompt.
  const remoteChats = ctx.remoteReach?.(conv.id) ?? 0;
  const userTerminalCommands = terminalCommandTracker.recentUserCommands();
  const terminalCwd = userTerminalCommands.length > 0 ? activeTerminalCwd() : undefined;
  const instructions = pinForgeInstructions(conv, ctx.forgeLoader?.instructionsFor(activeFile));
  const memoryIndex = isNewChatFirstTurn(conv.messages, conv.compaction)
    ? ctx.listMemoryLines?.()
    : undefined;
  const turnContext: TurnContextState = {
    ...(instructions.note ? { forgeInstructionsNote: instructions.note } : {}),
    activeFile,
    currentDate: localDate(),
    ...(userTerminalCommands.length > 0 ? { userTerminalCommands } : {}),
    ...(terminalCwd ? { activeTerminalCwd: terminalCwd } : {}),
    ...(conv.plan ? { plan: { items: [...conv.plan.items], updatedAt: conv.plan.updatedAt } } : {}),
    // Snapshotted with the rest of Layer C: a chat binding that changes
    // mid-turn must not rewrite the prompt near the head and cost this turn's
    // own tool rounds.
    ...(remoteChats > 0 ? { remoteChats } : {}),
    ...(unattended ? { unattended } : {}),
    compactionResume: formatCompactionResumeNote(conv.compaction?.resumeNote),
    ...(memoryIndex && memoryIndex.length > 0 ? { memoryIndex } : {}),
  };
  freezeTurnContextAndConsumeResumeNote(conv.messages, turnContext, conv.compaction);
  return { turnContext, instructions };
}
