import * as vscode from 'vscode';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import { getMeshOrchestrator } from '../agentMesh/meshContext';
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
import { codexPinIsLive } from '../agentMesh/codexPinLiveness';
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

async function sendToPanelOwnedCodex(
  config: () => ForgeConfig,
  link: AgentLink,
  prompt: string,
  signal: AbortSignal,
  timeoutMessage: string,
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
    const reply = await waitForReply(paths, id, 20 * 60_000, signal);
    if (reply !== undefined) {
      clearExchange(paths, id);
      return { status: 'completed', finalText: reply };
    }
    withdrawQuestion(paths, id);
    return signal.aborted
      ? { status: 'cancelled', finalText: '', mayStillBeWorking: true }
      : { status: 'timed_out', finalText: '', error: timeoutMessage };
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
}): AskAgentRuntime {
  const driver = options.driver ?? new CliAgentDriver();
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
      if (getMeshOrchestrator()?.adapterForSession(agent, link.sessionId)) return true;
      if (agent === 'claude')
        return readClaudeSessions().some((session) => session.sessionId === link.sessionId);
      if (agent === 'codex') {
        const codexCli = busConfig(options.getConfig()).codex_cli;
        return codexPinIsLive(link.sessionId, {
          ...(codexCli ? { codexCli } : {}),
          cwd: link.cwd,
          timeoutMs: 2_000,
        });
      }
      return false;
    },
    sendLive: async (agent, link, prompt, signal, purpose = 'ask', onAccepted) => {
      const adapter = getMeshOrchestrator()?.adapterForSession(agent, link.sessionId);
      if (agent === 'codex') {
        if (purpose === 'reply') return queueCodexReply(options.getConfig, link, prompt, signal);
        if (!adapter || !adapter.observesTurns)
          return sendToPanelOwnedCodex(
            options.getConfig,
            link,
            prompt,
            signal,
            adapter
              ? 'The panel-owned Codex thread did not reply before the wait limit.'
              : 'The linked Codex thread did not reply before the wait limit.',
            onAccepted,
          );
      }
      if (adapter) {
        const pending = adapter.send(prompt, { signal });
        onAccepted?.();
        const result = await pending;
        return {
          status: result.status,
          finalText: result.finalText ?? '',
          ...(result.status === 'failed'
            ? { error: 'The live session did not return a reply.' }
            : {}),
        };
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
            claudeQuestion(paths.script, id, link.title, prompt),
          );
          onAccepted?.();
          const reply = await waitForReply(paths, id, 20 * 60_000, signal);
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
                error: 'The linked Claude session did not reply before the wait limit.',
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
        const result = await driver.run({
          cliName: cliName(agent),
          executable,
          task: prompt,
          cwd: link.cwd,
          ...(createSessionId ? { createSessionId } : { sessionId: link.sessionId }),
          sessionTitle,
          signal,
          ...(onAccepted ? { onSpawned: onAccepted } : {}),
          onSessionId,
          ...(model ? { model } : {}),
        });
        const mapped = toRunResult(result);
        if (mapped.status === 'failed' && isGoneMessage(mapped.error ?? ''))
          return { ...mapped, sessionGone: true };
        return mapped;
      } catch (error) {
        return { status: 'failed', finalText: '', error: String(error) };
      }
    },
  };
}
