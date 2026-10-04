import {
  fileDeliveryRefusal,
  validateWorkspaceFileForDelivery,
} from '../util/fileDeliveryValidation';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteTransportManager } from './RemoteTransportManager';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteFileSendResult } from './types';

export interface RemoteFileDeliveryDeps {
  conversationId: string;
  requestedPath: string;
  caption: string;
  workspaceId: string;
  workspaceRoot?: string;
  isDisposed: () => boolean;
  isEnabled: () => boolean;
  manager: RemoteTransportManager;
  store: RemoteRequestStore;
  auth: RemoteAuth;
}

export async function sendRemoteWorkspaceFile(
  deps: RemoteFileDeliveryDeps,
): Promise<RemoteFileSendResult> {
  if (deps.isDisposed() || !deps.isEnabled()) {
    return { kind: 'refused', error: 'Remote delivery is disabled in this window.' };
  }
  const active = deps.manager.get('telegram');
  if (!active || active.lease.isLost() || !(await active.lease.verify())) {
    return {
      kind: 'refused',
      error: 'This window does not hold the active Telegram transport lease.',
    };
  }
  if (!deps.store.isLoaded()) {
    return { kind: 'refused', error: 'Remote chat bindings are not available in this window.' };
  }
  const bindings = deps.store
    .bindingsForConversation(deps.conversationId, 'telegram')
    .filter((binding) => binding.workspaceId === deps.workspaceId);
  if (bindings.length !== 1) {
    return {
      kind: 'refused',
      error:
        bindings.length === 0
          ? 'The selected Forge chat has no Telegram binding in this workspace.'
          : 'The selected Forge chat has multiple Telegram bindings in this workspace.',
    };
  }
  const binding = bindings[0];
  if (!binding || !(await deps.auth.canDeliver('telegram', binding.chatId))) {
    return {
      kind: 'refused',
      error: 'Telegram delivery is not currently authenticated for the selected chat.',
    };
  }
  const file = await validateWorkspaceFileForDelivery(deps.requestedPath, deps.workspaceRoot);
  if (!file.ok) return { kind: 'refused', error: `File refused: ${fileDeliveryRefusal(file)}.` };
  if (
    deps.manager.get('telegram') !== active ||
    active.lease.isLost() ||
    !(await active.lease.verify())
  ) {
    return { kind: 'refused', error: 'The Telegram transport lease is no longer active.' };
  }
  if (!active.channel.sendPhoto) {
    return { kind: 'refused', error: 'The active Telegram transport cannot send files.' };
  }
  try {
    await active.channel.sendPhoto(binding.chatId, file.absolutePath, deps.caption);
    return { kind: 'sent' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: 'unknown',
      error:
        `Telegram did not confirm whether the file was accepted: ${detail}. ` +
        'No retry was attempted; a manual retry may duplicate the file.',
    };
  }
}
