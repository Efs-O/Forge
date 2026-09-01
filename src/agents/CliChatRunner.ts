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
  onPrepared?(): void;
  driver?: CliAgentDriver;
  sessionId?: string;
  /** Host-recorded Forge plan supplied on every CLI turn. CLI agents own their
   * tools, so this is context only; it is not a native Forge tool definition. */
  planPrompt?: string;
  /** When false, suppress the disabled-rollback warning — used for resumed
   *  warm turns that already surfaced it on the first prompt. Defaults to
   *  announcing so one-shot callers keep the warning. */
  announceRollback?: boolean;
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
    'Work directly in the current workspace using your own tools. Perform the latest user request, then give a concise final response for the chat.',
    'To consult, ask, or delegate to a peer agent (for example Codex or Claude Code), invoke that agent through its own CLI directly — e.g. `codex exec "<task>"` — and relay the result. Forge exposes no peer-agent API: its local control server (port 8799) serves models to worker fleets, not sidebar agents, so do not probe it for this.',
    'Use the transcript for conversational context; do not repeat earlier work unless the latest request requires it.',
    '<forge_conversation>',
    transcript,
    '</forge_conversation>',
  ].join('\n\n');
}

export function buildCliResumeTask(messages: readonly ChatMessage[], planPrompt?: string): string {
  const latest = [...messages].reverse().find((message) => message.role === 'user');
  const latestText = latest ? contentText(latest.content) : '';
  return planPrompt ? `${planPrompt}\n\n${latestText}` : latestText;
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
  reportDisabledRollback(options);
  const capture = await snapshotWorkspaceBefore(
    options.checkpoint,
    options.workspaceRoot,
    options.signal,
    checkpointProgressReporter(options.onStatus),
  );
  let streamed = '';
  let result: CliAgentRunResult;
  try {
    options.onPrepared?.();
    result = await (options.driver ?? new CliAgentDriver()).run({
      cliName: options.prepared.cliName,
      executable: options.prepared.executable,
      task: options.sessionId
        ? buildCliResumeTask(options.messages, options.planPrompt)
        : buildCliChatTask(options.messages),
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
    await capture.finish();
  }

  const assistantText = appendFinalText(streamed, result.finalText);
  if (assistantText.length > streamed.length) options.onText(assistantText.slice(streamed.length));
  return { ...result, assistantText };
}

export async function runWarmCliChat(options: RunWarmCliChatOptions): Promise<CliChatResult> {
  reportDisabledRollback(options);
  const capture = await snapshotWorkspaceBefore(
    options.checkpoint,
    options.workspaceRoot,
    options.signal,
    checkpointProgressReporter(options.onStatus),
  );
  let streamed = '';
  let result: CliAgentRunResult;
  const confirmedId = options.registry.getConfirmedSessionId(options.key) ?? options.sessionId;
  const sessionOptions: CliAgentSessionOptions = {
    cliName: options.prepared.cliName,
    executable: options.prepared.executable,
    cwd: options.workspaceRoot,
    ...(options.model.cli_model ? { model: options.model.cli_model } : {}),
    ...(confirmedId ? { confirmedSessionId: confirmedId } : {}),
  };
  try {
    options.onPrepared?.();
    result = await options.registry.run(
      options.key,
      sessionOptions,
      confirmedId
        ? buildCliResumeTask(options.messages, options.planPrompt)
        : buildCliChatTask(options.messages),
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
    await capture.finish();
  }
  const assistantText = appendFinalText(streamed, result.finalText);
  if (assistantText.length > streamed.length) options.onText(assistantText.slice(streamed.length));
  return { ...result, assistantText };
}

function checkpointProgressReporter(
  onStatus: (text: string) => void,
): (progress: import('../checkpoint/DiskCheckpointStore').CheckpointProgress) => void {
  let lastReport = 0;
  return (progress) => {
    const now = Date.now();
    const complete = progress.totalFiles > 0 && progress.completedFiles >= progress.totalFiles;
    if (!complete && now - lastReport < 500) return;
    lastReport = now;
    const detail = `${progress.completedFiles}/${progress.totalFiles || progress.completedFiles} files`;
    onStatus(
      progress.phase === 'finalize'
        ? `Finalizing rollback checkpoint (${detail})`
        : `Preparing rollback checkpoint (${detail})`,
    );
  };
}

function reportDisabledRollback(options: RunCliChatOptions): void {
  if (options.announceRollback === false) return;
  if (!options.checkpoint.externalCliRollbackEnabled) {
    options.onStatus(
      'Warning: external CLI rollback protection is disabled. Keep/Undo will not cover CLI file changes.',
    );
  }
}
