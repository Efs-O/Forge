import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import { resumeRemoteConversation, type RemotePromptAdmissionDeps } from './RemotePromptAdmission';
import type { RemoteControllerOptions } from './remoteControllerOptions';
import type { RemoteInboundEvent } from './types';

export function workspaceContextOf(
  options: RemoteControllerOptions,
): Pick<RemoteCommandContext, 'currentWorkspaceAlias' | 'currentWorkspaceName'> {
  return {
    ...(options.currentWorkspaceAlias
      ? { currentWorkspaceAlias: options.currentWorkspaceAlias }
      : {}),
    ...(options.currentWorkspaceName ? { currentWorkspaceName: options.currentWorkspaceName } : {}),
  };
}

export interface RemoteCommandDepsSource {
  isNotifyOn(chatId: string): boolean;
  setNotify(chatId: string, on: boolean): void;
  isMirrorOn(chatId: string): boolean;
  setMirror(chatId: string, on: boolean): void;
  /** Read at resume time, not captured at dispatch: options can change in between. */
  promptDeps: () => RemotePromptAdmissionDeps & {
    restoreConversation: (conversationId: string) => Promise<unknown>;
  };
}

export interface RemoteCommandDeps {
  channel: RemoteCommandContext['channel'];
  store: RemoteCommandContext['store'];
  host: RemoteCommandContext['host'];
  signal: AbortSignal;
  commandCleanup: CommandCleanupScheduler;
  options: () => RemoteControllerOptions;
  totpEnrolled: NonNullable<RemoteCommandContext['totpEnrolled']>;
  contactCommands?: RemoteCommandContext['contactCommands'];
}

export function buildRemoteCommandDeps(
  deps: RemoteCommandDeps,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  source: RemoteCommandDepsSource,
): RemoteCommandContext {
  const options = deps.options();
  return {
    channel: deps.commandCleanup.trackReplies(deps.channel, event.text),
    store: deps.store,
    host: deps.host,
    workspaceId: options.workspaceId,
    signal: deps.signal,
    commandCleanup: deps.commandCleanup,
    // Read through deps.options() rather than the `options` captured above, so
    // a command running after a config reload reports through the current
    // options object — the same reason every other option here is read live.
    onError: (message) => deps.options().onError?.(message),
    inactivityTimeoutMinutes: options.inactivityTimeoutMinutes ?? 30,
    rateLimitPerMinute: options.rateLimitPerMinute,
    modelEntries: options.modelEntries,
    workspaceAliases: options.workspaceAliases,
    totpEnrolled: deps.totpEnrolled,
    ...workspaceContextOf(options),
    notifyMute: {
      get: (chatId) => source.isNotifyOn(chatId),
      set: (chatId, on) => source.setNotify(chatId, on),
    },
    mirrorToggle: {
      get: (chatId) => source.isMirrorOn(chatId),
      set: (chatId, on) => source.setMirror(chatId, on),
    },
    ...(options.switchWorkspace ? { switchWorkspace: options.switchWorkspace } : {}),
    ...(options.setInactivityTimeout ? { setInactivityTimeout: options.setInactivityTimeout } : {}),
    ...(options.setRateLimit ? { setRateLimit: options.setRateLimit } : {}),
    ...(options.reloadWindow ? { reloadWindow: options.reloadWindow } : {}),
    ...(options.voiceToggle ? { voiceToggle: options.voiceToggle } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(deps.contactCommands ? { contactCommands: deps.contactCommands } : {}),
    resumeCurrent: (resumeEvent, resumeDedupKey) =>
      resumeRemoteConversation(resumeEvent, resumeDedupKey, source.promptDeps()),
  };
}
