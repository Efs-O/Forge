import * as path from 'path';
import type { ForgeConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { describeModelPickerModel } from '../sidebar/ModelPickerGroups';
import { RemoteAttachmentStore } from './RemoteAttachmentStore';
import type { ModelPickerDescriptor } from '../sidebar/ModelPickerGroups';
import { resolveWorkspaceAliases, type WorkspaceAliasTarget } from './RemoteWorkspaceDiscovery';
import { workspaceIdFor } from './RemoteWorkspaceHandoff';

/**
 * What a RemoteController is configured with.
 *
 * Lives with its builder rather than with the class: every field here is
 * produced by `buildRemoteControllerOptions` below from one ForgeConfig read,
 * so a new option added to one and not the other is a type error in this file
 * instead of a silent gap two files apart.
 */
export interface RemoteControllerOptions {
  workspaceId: string;
  queueLimit: number;
  maxMessageChars: number;
  rateLimitPerMinute: number;
  /** Snapshot of grouped model descriptors from the active Forge config. */
  modelEntries: readonly ModelPickerDescriptor[];
  attachmentStore?: RemoteAttachmentStore | undefined;
  attachmentsEnabled: boolean;
  acceptPdfAttachments: boolean;
  workspaceAliases: Readonly<Record<string, string>>;
  /** Alias whose configured path resolves to this window's root, if any. */
  currentWorkspaceAlias?: string | undefined;
  /** Display name of the folder this window has open, alias or not. */
  currentWorkspaceName?: string | undefined;
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  inactivityTimeoutMinutes?: number;
  /** Seconds to keep a recognized /command before deleting it from Telegram; 0/absent disables. */
  deleteCommandMessagesAfter?: number;
  /** Seconds to keep Forge's reply to a /command before deleting it; 0/absent disables. */
  deleteCommandRepliesAfter?: number;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  setRateLimit?: ((perMinute: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  onError?: (message: string) => void;
  /** Global spoken-reply toggle, persisted to config.yaml. */
  voiceToggle?: { get: () => boolean; set: (on: boolean) => Promise<void> };
}

/**
 * Shared by the controller-options builder and the runtime's workspace handoff:
 * discovered siblings merged under explicit config, re-scanned on each use so a
 * project created after this window opened is still reachable.
 */
export function workspaceAliases(
  config: ForgeConfig,
  workspaceRoot: string | undefined,
): Record<string, WorkspaceAliasTarget> {
  return resolveWorkspaceAliases(config.remote?.workspace_aliases ?? {}, workspaceRoot);
}

/**
 * Which alias this window is sitting in, and what to call it. Each alias path
 * is hashed exactly as extension.ts derives workspaceId, so the workspace list
 * can mark the entry the chat is actually in. The name falls back to the open
 * folder when no alias matches, so "where am I?" is never blank just because
 * this project was reached outside the alias list.
 */
export function currentWorkspaceIdentity(
  aliases: Record<string, WorkspaceAliasTarget>,
  workspaceId: string,
  workspaceRoot: string | undefined,
): { alias?: string; name?: string } {
  const current = Object.entries(aliases).find(
    ([, value]) => workspaceIdFor(value.path) === workspaceId,
  );
  if (current) return { alias: current[0], name: current[1].display_name };
  if (workspaceRoot) return { name: path.basename(path.resolve(workspaceRoot)) };
  return {};
}

/** Enabled transport names for a config; empty when remote is off. */
export function transportNames(config: ForgeConfig): string[] {
  if (config.remote?.enabled !== true) return [];
  return (['telegram', 'whatsapp'] as const).filter(
    (name) => config.remote?.[name].enabled === true,
  );
}

/**
 * Dependencies the runtime hands the options builder. Built once and kept
 * stable: the callbacks close over live runtime state (the applied config for
 * the voice toggle, the handoff path) rather than a config snapshot, so a value
 * like `voice.output.enabled` is read at call time, not frozen at build time.
 */
export interface RemoteControllerOptionsDeps {
  workspaceId: string;
  workspaceRoot?: string | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  setRateLimit?: ((perMinute: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  onError: (message: string) => void;
  /** Live read of the applied config's voice output flag. */
  voiceOutputEnabled: () => boolean;
  setVoiceOutput: (on: boolean) => Promise<void>;
  /** True when a config path is wired; enables the persisted /voice toggle. */
  hasConfigPath: boolean;
  /** Bound to the runtime's handoff; the config is applied by the builder. */
  switchWorkspace: (
    config: ForgeConfig,
    alias: string,
    channel: string,
    chatId: string,
  ) => Promise<void>;
}

/**
 * Maps a validated ForgeConfig to the controller's options. Pure with respect
 * to its inputs: no runtime fields beyond the stable deps bundle, so a newly
 * created sibling project appears after a config edit or window reload — not
 * instantly. Making the alias list lazy would have meant a callback type and
 * touching a dozen controller fixtures for a refresh nobody asked for.
 */
export function buildRemoteControllerOptions(
  config: ForgeConfig,
  deps: RemoteControllerOptionsDeps,
): RemoteControllerOptions {
  const remote = config.remote;
  if (!remote) throw new Error('Forge remote configuration is unavailable.');
  const aliases = workspaceAliases(config, deps.workspaceRoot);
  return {
    workspaceId: deps.workspaceId,
    queueLimit: remote.queue_limit,
    maxMessageChars: remote.max_message_chars,
    rateLimitPerMinute: remote.rate_limit_per_minute,
    modelEntries: config.models.map((model) =>
      describeModelPickerModel(mergeGroupsIntoModel(config, model)),
    ),
    ...(deps.workspaceRoot
      ? { attachmentStore: new RemoteAttachmentStore(deps.workspaceRoot) }
      : {}),
    attachmentsEnabled: remote.attachments.enabled,
    acceptPdfAttachments: remote.attachments.accept_pdf,
    workspaceAliases: Object.fromEntries(
      Object.entries(aliases).map(([alias, value]) => [alias, value.display_name]),
    ),
    ...(() => {
      const { alias, name } = currentWorkspaceIdentity(
        aliases,
        deps.workspaceId,
        deps.workspaceRoot,
      );
      return {
        ...(alias ? { currentWorkspaceAlias: alias } : {}),
        ...(name ? { currentWorkspaceName: name } : {}),
      };
    })(),
    // The config is applied here, not by the caller: deps.switchWorkspace is
    // stable and the builder binds the current config at build time.
    switchWorkspace: (alias, channel, chatId) =>
      deps.switchWorkspace(config, alias, channel, chatId),
    inactivityTimeoutMinutes: remote.auth.inactivity_timeout_minutes,
    deleteCommandMessagesAfter: remote.delete_command_messages_after,
    deleteCommandRepliesAfter: remote.delete_command_replies_after,
    setInactivityTimeout: deps.setInactivityTimeout,
    setRateLimit: deps.setRateLimit,
    reloadWindow: deps.reloadWindow,
    onError: deps.onError,
    ...(deps.hasConfigPath
      ? {
          voiceToggle: {
            // Live read, not a snapshot: the applied config can change under a
            // running transport without a rebuild.
            get: () => deps.voiceOutputEnabled(),
            set: (on: boolean) => deps.setVoiceOutput(on),
          },
        }
      : {}),
  };
}
