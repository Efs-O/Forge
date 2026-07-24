import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { DelegationHold } from '../backend/DelegationGate';
import { streamModelChatCompletion } from '../llm/ChatClient';
import { mergeSampling } from '../llm/SamplingMerge';
import { normalizeRequestForModel } from '../llm/RequestNormalizer';
import type { ChatCompletionRequest } from '../llm/types';
import type { StreamHandlers } from '../llm/OpenAIClient';
import { capResultText } from '../tools/resultCap';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import { runCliDelegation } from './CliDelegationRunner';
import { resolveDelegationTarget } from './eligibility';
import {
  DELEGATION_TIMEOUT_MS,
  MAX_DELEGATION_CONTEXT_BYTES,
  MAX_DELEGATION_CONTEXT_FILE_BYTES,
  MAX_DELEGATION_CONTEXT_FILES,
  MAX_DELEGATION_RESULT_CHARS,
  assertDelegationTaskLength,
  buildConsultationSystemPrompt,
  clampDelegationOutputTokens,
  type DelegationPromptContextFile,
} from './limits';

export interface LocalDelegationRequest {
  primaryModel: string;
  targetModel: string;
  task: string;
  contextFiles?: string[];
  focus?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LocalDelegationResult {
  text: string;
  targetModel: string;
  bestEffort: boolean;
}

export interface LocalDelegationServiceDeps {
  getConfig: () => ForgeConfig;
  backendPool: Pick<IBackendPool, 'canDelegate' | 'acquireForDelegation'>;
  workspaceRoot: string;
  readFile?: (filePath: string, signal: AbortSignal) => Promise<Uint8Array>;
  statFile?: (filePath: string) => Promise<{ size: number; isFile: boolean }>;
  resolvePath?: (filePath: string, workspaceRoot: string) => string;
  /** Symlink-resolving canonicalizer used to re-check workspace containment;
   *  the lexical resolvePath check alone would follow symlinks out. */
  realPath?: (filePath: string) => Promise<string>;
  streamChat?: typeof streamModelChatCompletion;
  makeTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  /** Test-only injection point for the `provider: cli` branch. */
  cliDriver?: CliAgentDriver;
}

class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

function composeSignals(signals: AbortSignal[]): AbortSignal {
  const live = signals.filter(Boolean);
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

function formatContextForUser(files: DelegationPromptContextFile[]): string {
  if (files.length === 0) return '';
  return files
    .map((file) => `<context file="${file.path}">\n${file.content}\n</context>`)
    .join('\n\n');
}

function abortKind(signal: AbortSignal, timeoutSignal: AbortSignal): 'timeout' | 'cancellation' {
  return timeoutSignal.aborted && signal.aborted ? 'timeout' : 'cancellation';
}

async function defaultReadFile(filePath: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const data = await fs.readFile(filePath);
  signal.throwIfAborted();
  return data;
}

async function defaultStatFile(filePath: string): Promise<{ size: number; isFile: boolean }> {
  const stat = await fs.stat(filePath);
  return { size: stat.size, isFile: stat.isFile() };
}

export class LocalDelegationService {
  private readonly readFile: (filePath: string, signal: AbortSignal) => Promise<Uint8Array>;
  private readonly statFile: (filePath: string) => Promise<{ size: number; isFile: boolean }>;
  private readonly resolvePath: (filePath: string, workspaceRoot: string) => string;
  private readonly realPath: (filePath: string) => Promise<string>;
  private readonly streamChat: typeof streamModelChatCompletion;
  private readonly makeTimeoutSignal: (timeoutMs: number) => AbortSignal;
  private readonly cliDriver: CliAgentDriver;

  constructor(private readonly deps: LocalDelegationServiceDeps) {
    this.readFile = deps.readFile ?? defaultReadFile;
    this.statFile = deps.statFile ?? defaultStatFile;
    this.resolvePath =
      deps.resolvePath ??
      ((filePath, workspaceRoot) =>
        resolveWorkspacePath(filePath, { workspaceRoot, mustBeInsideWorkspace: true }));
    this.realPath = deps.realPath ?? ((filePath) => fs.realpath(filePath));
    this.streamChat = deps.streamChat ?? streamModelChatCompletion;
    this.makeTimeoutSignal =
      deps.makeTimeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
    this.cliDriver = deps.cliDriver ?? new CliAgentDriver();
  }

  canDelegate(primaryModel: string, targetModel: string): { ok: boolean; reason?: string } {
    const config = this.deps.getConfig();
    const target = resolveDelegationTarget(config, targetModel);
    const check = this.deps.backendPool.canDelegate(primaryModel, target.resolvedId);
    if (check.safe) return { ok: true };
    return check.reason ? { ok: false, reason: check.reason } : { ok: false };
  }

  async ask(request: LocalDelegationRequest): Promise<LocalDelegationResult> {
    assertDelegationTaskLength(request.task);
    const config = this.deps.getConfig();
    const target = resolveDelegationTarget(config, request.targetModel);
    const timeoutSignal = this.makeTimeoutSignal(DELEGATION_TIMEOUT_MS);
    const signal = composeSignals(
      request.signal ? [request.signal, timeoutSignal] : [timeoutSignal],
    );

    if (target.model.provider === 'cli') {
      try {
        return await runCliDelegation(
          request,
          target,
          this.cliDriver,
          this.deps.workspaceRoot,
          signal,
        );
      } catch (err) {
        if (signal.aborted) {
          const kind = abortKind(signal, timeoutSignal);
          throw new DelegationError(
            kind === 'timeout'
              ? `Delegation timeout: exceeded ${DELEGATION_TIMEOUT_MS}ms.`
              : 'Delegation cancelled by caller.',
          );
        }
        if (err instanceof DelegationError) throw err;
        throw new DelegationError(`Delegation provider error: ${(err as Error).message}`);
      }
    }

    const check = this.deps.backendPool.canDelegate(request.primaryModel, target.resolvedId);
    if (!check.safe) {
      throw new DelegationError(`Delegation capacity error: ${check.reason ?? 'unsafe target'}`);
    }

    let hold: DelegationHold | undefined;
    try {
      const files = await this.readContextFiles(request.contextFiles ?? [], signal);
      const req = this.buildRequest(request, target.model, files);
      hold = await this.acquireHold(request.primaryModel, target.resolvedId, signal);
      const text = await this.streamToBuffer(hold.backend.baseUrl(), req, target.model, signal);
      return {
        text: capResultText(text, MAX_DELEGATION_RESULT_CHARS),
        targetModel: target.resolvedId,
        bestEffort: hold.bestEffort,
      };
    } catch (err) {
      if (signal.aborted) {
        const kind = abortKind(signal, timeoutSignal);
        throw new DelegationError(
          kind === 'timeout'
            ? `Delegation timeout: exceeded ${DELEGATION_TIMEOUT_MS}ms.`
            : 'Delegation cancelled by caller.',
        );
      }
      if (err instanceof DelegationError) throw err;
      throw new DelegationError(`Delegation provider error: ${(err as Error).message}`);
    } finally {
      hold?.release();
    }
  }

  private buildRequest(
    request: LocalDelegationRequest,
    targetModel: ModelConfig,
    files: DelegationPromptContextFile[],
  ): ChatCompletionRequest {
    try {
      const context = formatContextForUser(files);
      const focus = request.focus ? `\nFocus: ${request.focus}` : '';
      const base: ChatCompletionRequest = {
        model: targetModel.name,
        stream: true,
        max_tokens: clampDelegationOutputTokens(request.maxOutputTokens),
        messages: [
          { role: 'system', content: buildConsultationSystemPrompt(files) },
          {
            role: 'user',
            content: [`Task:\n${request.task}${focus}`, context].filter(Boolean).join('\n\n'),
          },
        ],
      };
      const merged = mergeSampling(base, targetModel, { allowPreserveThinking: false });
      return normalizeRequestForModel(merged, targetModel);
    } catch (err) {
      throw new DelegationError(`Delegation template error: ${(err as Error).message}`);
    }
  }

  private async acquireHold(
    primaryModel: string,
    targetModel: string,
    signal: AbortSignal,
  ): Promise<DelegationHold> {
    const acquire = this.deps.backendPool.acquireForDelegation(primaryModel, targetModel);
    try {
      return await Promise.race([
        acquire,
        new Promise<never>((_, reject) => {
          // A listener on an already-aborted signal never fires — check first.
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);
    } catch (err) {
      if (signal.aborted) {
        void acquire.then((lateHold) => lateHold.release()).catch(() => {});
      }
      signal.throwIfAborted();
      throw new DelegationError(`Delegation startup error: ${(err as Error).message}`);
    }
  }

  private async readContextFiles(
    requestedFiles: string[],
    signal: AbortSignal,
  ): Promise<DelegationPromptContextFile[]> {
    if (requestedFiles.length > MAX_DELEGATION_CONTEXT_FILES) {
      throw new DelegationError(
        `Delegation context has too many files: ${requestedFiles.length} exceeds ${MAX_DELEGATION_CONTEXT_FILES}.`,
      );
    }
    let combined = 0;
    const files: DelegationPromptContextFile[] = [];
    const realRoot = requestedFiles.length > 0 ? await this.realPath(this.deps.workspaceRoot) : '';
    for (const requested of requestedFiles) {
      signal.throwIfAborted();
      let resolved: string;
      try {
        resolved = this.resolvePath(requested, this.deps.workspaceRoot);
      } catch (err) {
        throw new DelegationError(`Delegation context path rejected: ${(err as Error).message}`);
      }
      const stat = await this.statFile(resolved);
      if (!stat.isFile) throw new DelegationError(`Delegation context is not a file: ${requested}`);
      // The lexical resolvePath check follows symlinks out of the workspace;
      // re-check containment on the canonical (symlink-resolved) path.
      const real = await this.realPath(resolved);
      const relativeToRoot = path.relative(realRoot, real);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        throw new DelegationError(
          `Delegation context path rejected: "${requested}" resolves outside the workspace (symlink target ${real}).`,
        );
      }
      if (stat.size > MAX_DELEGATION_CONTEXT_FILE_BYTES) {
        throw new DelegationError(
          `Delegation context file "${requested}" is too large: ${stat.size} bytes exceeds ${MAX_DELEGATION_CONTEXT_FILE_BYTES}.`,
        );
      }
      combined += stat.size;
      if (combined > MAX_DELEGATION_CONTEXT_BYTES) {
        throw new DelegationError(
          `Delegation context is too large: ${combined} bytes exceeds ${MAX_DELEGATION_CONTEXT_BYTES}.`,
        );
      }
      const bytes = await this.readFile(resolved, signal);
      files.push({
        path: path.relative(this.deps.workspaceRoot, resolved) || path.basename(resolved),
        content: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      });
    }
    return files;
  }

  private streamToBuffer(
    baseUrl: string,
    request: ChatCompletionRequest,
    model: Parameters<typeof streamModelChatCompletion>[2],
    signal: AbortSignal,
  ): Promise<string> {
    let text = '';
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        // The provider client only reacts to abort events, not a signal that
        // was already aborted before the request started.
        reject(signal.reason ?? new DOMException('Delegation cancelled', 'AbortError'));
        return;
      }
      const handlers: StreamHandlers = {
        onToken: (token) => {
          text += token;
          if (text.length > MAX_DELEGATION_RESULT_CHARS * 2) {
            text = text.slice(0, MAX_DELEGATION_RESULT_CHARS * 2);
          }
        },
        onDone: (finishReason) => {
          if (signal.aborted || finishReason === 'cancelled') {
            reject(signal.reason ?? new DOMException('Delegation cancelled', 'AbortError'));
            return;
          }
          resolve(text);
        },
        onError: (err) => reject(new DelegationError(`Delegation provider error: ${err.message}`)),
      };
      void this.streamChat(baseUrl, request, model, handlers, signal).catch(reject);
    });
  }
}
