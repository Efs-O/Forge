import type { ModelConfig } from '../config/types';
import type { ChatMessage, ContentPart } from '../llm/types';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import { CliAgentDriver } from './CliAgentDriver';
import type { CliAgentSessionOptions } from './CliAgentSession';
import { CliSessionRegistry, type CliSessionKey } from './CliSessionRegistry';
import { resolveCliExecutable } from './resolveCliExecutable';
import { inferCliAgentName, type CliAgentName, type CliAgentRunResult } from './types';
import { snapshotWorkspaceBefore } from './WorkspaceCheckpoint';

export interface PreparedCliChatAgent {
  cliName: CliAgentName;
  executable: string;
}

export interface RunCliChatOptions {
  prepared: PreparedCliChatAgent;
  model: ModelConfig;
  messages: readonly ChatMessage[];
  workspaceRoot: string;
  checkpoint: CheckpointSession;
  signal: AbortSignal;
  onText(text: string): void;
  onStatus(text: string): void;
  driver?: CliAgentDriver;
  sessionId?: string;
}

export interface CliChatResult extends CliAgentRunResult {
  assistantText: string;
}

export interface RunWarmCliChatOptions extends Omit<RunCliChatOptions, 'driver'> {
  registry: CliSessionRegistry;
  key: CliSessionKey;
}

function contentText(content: string | ContentPart[] | null): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : '[Image attachment is present in the Forge conversation but is not embedded here.]',
    )
    .join('\n');
}

export function buildCliChatTask(messages: readonly ChatMessage[]): string {
  const transcript = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${message.role.toUpperCase()}:\n${contentText(message.content)}`)
    .join('\n\n');
  return [
    'You are the selected external coding agent in a Forge sidebar conversation.',
    'Work directly in the current workspace using your own tools. You have full tool access. Perform the latest user request, then give a concise final response for the chat.',
    'Use the transcript for conversational context; do not repeat earlier work unless the latest request requires it.',
    '<forge_conversation>',
    transcript,
    '</forge_conversation>',
  ].join('\n\n');
}

export function buildCliResumeTask(messages: readonly ChatMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === 'user');
  return latest ? contentText(latest.content) : '';
}

export async function prepareCliChatAgent(
  model: ModelConfig,
  workspaceRoot: string,
): Promise<PreparedCliChatAgent> {
  if (!workspaceRoot) throw new Error('Forge: CLI agents require an open workspace folder.');
  if (!model.cli) {
    throw new Error(`Forge: CLI model "${model.name}" is missing its cli executable setting.`);
  }
  const cliName = inferCliAgentName(model.cli);
  return { cliName, executable: await resolveCliExecutable(model.cli, cliName) };
}

function appendFinalText(streamed: string, finalText: string): string {
  if (!finalText || streamed.includes(finalText)) return streamed;
  if (!streamed) return finalText;
  if (finalText.startsWith(streamed)) return finalText;
  return `${streamed.trimEnd()}\n\n${finalText}`;
}

export async function runCliChat(options: RunCliChatOptions): Promise<CliChatResult> {
  const capture = snapshotWorkspaceBefore(options.checkpoint, options.workspaceRoot);
  let streamed = '';
  let result: CliAgentRunResult;
  try {
    result = await (options.driver ?? new CliAgentDriver()).run({
      cliName: options.prepared.cliName,
      executable: options.prepared.executable,
      task: options.sessionId
        ? buildCliResumeTask(options.messages)
        : buildCliChatTask(options.messages),
      access: 'full',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.model.cli_model ? { model: options.model.cli_model } : {}),
      cwd: options.workspaceRoot,
      signal: options.signal,
      onEvent: (event) => {
        if (event.kind === 'status') {
          options.onStatus(event.text);
          return;
        }
        streamed += event.text;
        options.onText(event.text);
      },
    });
  } finally {
    capture.finish();
  }

  const assistantText = appendFinalText(streamed, result.finalText);
  if (assistantText.length > streamed.length) options.onText(assistantText.slice(streamed.length));
  return { ...result, assistantText };
}

export async function runWarmCliChat(options: RunWarmCliChatOptions): Promise<CliChatResult> {
  const capture = snapshotWorkspaceBefore(options.checkpoint, options.workspaceRoot);
  let streamed = '';
  let result: CliAgentRunResult;
  const confirmedId = options.registry.getConfirmedSessionId(options.key) ?? options.sessionId;
  const sessionOptions: CliAgentSessionOptions = {
    cliName: options.prepared.cliName,
    executable: options.prepared.executable,
    access: 'full',
    cwd: options.workspaceRoot,
    ...(options.model.cli_model ? { model: options.model.cli_model } : {}),
    ...(confirmedId ? { confirmedSessionId: confirmedId } : {}),
  };
  try {
    result = await options.registry.run(
      options.key,
      sessionOptions,
      confirmedId ? buildCliResumeTask(options.messages) : buildCliChatTask(options.messages),
      {
        signal: options.signal,
        onEvent: (event) => {
          if (event.kind === 'status') {
            options.onStatus(event.text);
            return;
          }
          streamed += event.text;
          options.onText(event.text);
        },
      },
    );
  } finally {
    capture.finish();
  }
  const assistantText = appendFinalText(streamed, result.finalText);
  if (assistantText.length > streamed.length) options.onText(assistantText.slice(streamed.length));
  return { ...result, assistantText };
}
