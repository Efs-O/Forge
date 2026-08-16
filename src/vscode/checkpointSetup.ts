/**
 * Reading `forge.checkpoint.*` settings into a CheckpointStack.
 *
 * Split out of `extension.ts`. Every value is validated rather than defaulted:
 * a checkpoint stack built on a wrong storage path or an unbounded size limit
 * silently stops protecting the user's files, so activation fails loudly
 * instead.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { CheckpointStack } from '../checkpoint/CheckpointStack';

export function createCheckpointStack(context: vscode.ExtensionContext): CheckpointStack {
  const settings = vscode.workspace.getConfiguration('forge.checkpoint');
  const externalCliRollbackEnabled = settings.get<boolean>('externalCliEnabled');
  const maxBytes = settings.get<number>('maxBytes');
  const maxFiles = settings.get<number>('maxFiles');
  const storageSetting = settings.get<string>('storagePath');
  if (
    typeof externalCliRollbackEnabled !== 'boolean' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes === undefined ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles === undefined ||
    maxFiles < 1 ||
    storageSetting === undefined
  ) {
    throw new Error('Forge checkpoint settings are invalid. Review forge.checkpoint.* settings.');
  }
  const configured = storageSetting.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('forge.checkpoint.storagePath must be an absolute path when configured.');
  }
  return new CheckpointStack({
    storageRoot: configured
      ? path.resolve(configured)
      : path.join(context.globalStorageUri.fsPath, 'checkpoints'),
    limits: { maxBytes, maxFiles },
    externalCliRollbackEnabled,
  });
}
