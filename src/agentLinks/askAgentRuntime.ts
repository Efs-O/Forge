import * as vscode from 'vscode';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import { codexThreadIsLive } from './codexThreadLiveness';
import { readClaudeSessions, sendPeerMessage } from '../agentBus/claudePeer';
import { queueToCodex } from '../agentBus/codexDelivery';
import {
  busPaths,
  clearExchange,
  ensureBus,
  newBusId,
  replyFile,
  waitForReply,
  withdrawQuestion,
  writeQuestion,
} from '../agentBus/agentBus';
import { claudeQuestion } from '../agentBus/busContent';
import { codexMessage } from '../agentBus/codexDelivery';
import type { ForgeConfig } from '../config/types';
import type { AgentKind, AgentLink } from './chatAgentLinks';
import type { AskAgentRunResult, AskAgentRuntime } from './askAgentService';

export interface AskAgentPanelCommands {
  getCommands(): PromiseLike<string[]>;
  executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  openExternal(uri: vscode.Uri): Thenable<boolean>;
}

export function makeAskAgentPanelOpener(commands: AskAgentPanelCommands) {
  return async (agent: AgentKind, sessionId: string): Promise<'opened' | 'unavailable'> => {
    if (agent === 'copilot') return 'unavailable';
    if (agent === 'claude') {
      if (!(await commands.getCommands()).includes('claude-vscode.editor.open'))
        return 'unavailable';
      await commands.executeCommand(
        'claude-vscode.editor.open',
        sessionId,
        undefined,
        undefined,
        undefined,
        undefined,
        { programmatic: 'honor-preferred-location' },
      );
      return 'opened';
    }
    await commands.openExternal(vscode.Uri.parse(`vscode://openai.chatgpt/local/${sessionId}`));
    return 'opened';
  };
}

function cliFor(config: ForgeConfig, agent: AgentKind): string {
  const bus = config.agent_bus;
  if (!bus) throw new Error('agent_bus is disabled');
  return agent === 'claude' ? bus.claude_cli : agent === 'codex' ? bus.codex_cli : bus.copilot_cli;
}

function busConfig(config: ForgeConfig) {
  if (!config.agent_bus?.enabled) throw new Error('agent_bus is disabled');
  return config.agent_bus;
}

function cliName(agent: AgentKind): 'claude' | 'codex' | 'copilot' {
  return agent;
}

function toRunResult(result: Awaited<ReturnType<CliAgentDriver['run']>>): AskAgentRunResult {
  return {
    status: result.status,
    finalText: result.finalText,
    ...(result.error ? { error: result.error } : {}),
  };
}

function isGoneMessage(message: string): boolean {
  return /(?:session|thread).{0,60}(?:not found|does not exist|unknown)|no (?:conversation|thread).{0,60}(?:found|exists)/iu.test(
    message,
  );
}

/**
 * Codex refuses a second writer on a thread another process still holds
 * (`thread-store conflict: thread <id> already has an active writer`, then
 * `thread/resume failed … (code -32600)`). The thread exists, so this is not
 * "gone"; matched on Codex's own two phrases only, never on a bare -32600.
 * Resume-only: a run that starts its own session has no thread to conflict with.
 */
function isWriterConflictMessage(message: string): boolean {
  return /thread-store conflict|already has an active writer/iu.test(message);
}

async function sendToPanelOwnedCodex(
  config: () => ForgeConfig,
  link: AgentLink,
  prompt: string,
  signal: AbortSignal,
  waitMs: number,
  onAccepted?: () => void,
): Promise<AskAgentRunResult> {
  const paths = busPaths();
  ensureBus(paths);
  const id = newBusId();
  writeQuestion(paths, id, link.title, prompt);
  try {
    const message = codexMessage(replyFile(paths, id), id, link.title, prompt);
    await queueToCodex(busConfig(config()).codex_cli, link.sessionId, message, signal);
    onAccepted?.();
    const reply = await waitForReply(paths, id, waitMs, signal);
    if (reply !== undefined) {
      clearExchange(paths, id);
      return { status: 'completed', finalText: reply };
    }
    withdrawQuestion(paths, id);
    return signal.aborted
      ? { status: 'cancelled', finalText: '', mayStillBeWorking: true }
      : {
          status: 'timed_out',
          finalText: '',
          error: `The linked Codex thread ${link.sessionId} did not reply before the wait limit (exchange ${id}).`,
        };
  } catch (error) {
    withdrawQuestion(paths, id);
    const detail = String(error);
    return {
      status: 'failed',
      finalText: '',
      error: detail,
      ...(isGoneMessage(detail) ? { sessionGone: true } : {}),
    };
  }
}

async function queueCodexReply(
  config: () => ForgeConfig,
  link: AgentLink,
  prompt: string,
  signal: AbortSignal,
): Promise<AskAgentRunResult> {
  await queueToCodex(busConfig(config()).codex_cli, link.sessionId, prompt, signal);
  return { status: 'completed', finalText: '' };
}

export function makeAskAgentRuntime(options: {
  getConfig: () => ForgeConfig;
  driver?: CliAgentDriver;
  panelCommands?: AskAgentPanelCommands;
  /**
   * How long one ask may run, live or headless. Unset: a live session gets
   * 20 minutes and a headless run the CLI driver's own default.
   */
  waitLimitMs?: number;
}): AskAgentRuntime {
  const driver = options.driver ?? new CliAgentDriver();
  const liveWaitMs = options.waitLimitMs ?? 20 * 60_000;
  const open = makeAskAgentPanelOpener(
    options.panelCommands ?? {
      getCommands: () => vscode.commands.getCommands(true),
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      openExternal: (uri) => vscode.env.openExternal(uri),
    },
  );
  return {
    openPanel: open,
    isLive: async (agent, link) => {
      if (agent === 'claude')
        return readClaudeSessions().some((session) => session.sessionId === link.sessionId);
      if (agent === 'codex') {
        const codexCli = busConfig(options.getConfig()).codex_cli;
        return codexThreadIsLive(link.sessionId, {
          ...(codexCli ? { codexCli } : {}),
          cwd: link.cwd,
          timeoutMs: options.getConfig().agent_links.codex_liveness_timeout_ms,
        });
      }
      return false;
    },
    sendLive: async (agent, link, prompt, signal, purpose = 'ask', onAccepted, origin) => {
      if (agent === 'codex') {
        if (purpose === 'reply') return queueCodexReply(options.getConfig, link, prompt, signal);
        return sendToPanelOwnedCodex(
          options.getConfig,
          link,
          prompt,
          signal,
          liveWaitMs,
          onAccepted,
        );
      }
      const session =
        agent === 'claude'
          ? readClaudeSessions().find((item) => item.sessionId === link.sessionId)
          : undefined;
      if (session) {
        if (purpose === 'reply') {
          await sendPeerMessage(session, 'Forge', prompt);
          return { status: 'completed', finalText: '' };
        }
        const paths = busPaths();
        ensureBus(paths);
        const id = newBusId();
        writeQuestion(paths, id, link.title, prompt);
        try {
          await sendPeerMessage(
            session,
            'Forge',
            claudeQuestion(paths.script, id, link.title, prompt, origin),
          );
          onAccepted?.();
          const reply = await waitForReply(paths, id, liveWaitMs, signal);
          if (reply !== undefined) {
            clearExchange(paths, id);
            return { status: 'completed', finalText: reply };
          }
          withdrawQuestion(paths, id);
          return signal.aborted
            ? { status: 'cancelled', finalText: '', mayStillBeWorking: true }
            : {
                status: 'timed_out',
                finalText: '',
                error: `The linked Claude session ${session.sessionId} did not reply before the wait limit (exchange ${id}).`,
              };
        } catch (error) {
          withdrawQuestion(paths, id);
          return { status: 'failed', finalText: '', error: String(error) };
        }
      }
      return {
        status: 'failed',
        finalText: '',
        error: 'The linked live session disappeared before delivery.',
      };
    },
    runHeadless: async ({
      agent,
      link,
      prompt,
      createSessionId,
      startNew,
      sessionTitle,
      signal,
      onAccepted,
      onSessionId,
    }) => {
      try {
        const config = options.getConfig();
        const executable = await resolveCliExecutable(cliFor(config, agent), cliName(agent));
        const model =
          agent === 'codex'
            ? config.agent_bus?.codex_model
            : agent === 'copilot'
              ? busConfig(config).copilot_model
              : undefined;
        // Which session the CLI runs on: an id Forge pre-created, nothing at all
        // when the caller asked for a new session (`startNew`, which wins over
        // the link — the CLI names the session and reports it back), or the
        // linked session to resume. A non-UUID handed to `codex exec resume` is
        // read as a thread NAME, so a placeholder link must never reach it.
        const sessionArgs = createSessionId
          ? { createSessionId }
          : startNew
            ? {}
            : { sessionId: link.sessionId };
        const result = await driver.run({
          cliName: cliName(agent),
          executable,
          task: prompt,
          cwd: link.cwd,
          ...sessionArgs,
          sessionTitle,
          signal,
          ...(onAccepted ? { onSpawned: onAccepted } : {}),
          onSessionId,
          ...(model ? { model } : {}),
          ...(options.waitLimitMs ? { timeoutMs: options.waitLimitMs } : {}),
        });
        const mapped = toRunResult(result);
        if (mapped.status === 'failed' && isGoneMessage(mapped.error ?? ''))
          return { ...mapped, sessionGone: true };
        if (
          mapped.status === 'failed' &&
          agent === 'codex' &&
          !createSessionId &&
          !startNew &&
          isWriterConflictMessage(mapped.error ?? '')
        )
          return { ...mapped, sessionLocked: true };
        return mapped;
      } catch (error) {
        return { status: 'failed', finalText: '', error: String(error) };
      }
    },
  };
}
