import type { ForgeConfig } from '../config/types';
import type { ToolPermission } from './ToolRegistry';

// Pre-permissions legacy surface for configs with no permissions block.
// 'delegate' is deliberately absent: delegation is opt-in even for legacy
// configs and is only granted via an explicit agents.delegate: true.
const LEGACY_PERMISSIONS: readonly ToolPermission[] = [
  'read',
  'write',
  'delete',
  'terminal',
  'headless',
  'search',
  'fetch',
  'git-read',
  'git-write',
];

/**
 * Resolve config switches into the exact capabilities exposed to the model.
 * An omitted permissions block preserves pre-permissions Forge behavior.
 * Once a group is present, its schema defaults and explicit values are
 * authoritative for every capability in that group.
 */
export function resolveToolPermissions(config: ForgeConfig): Set<ToolPermission> {
  const configured = config.permissions;
  if (!configured) return new Set(LEGACY_PERMISSIONS);

  const allowed = new Set<ToolPermission>();
  if (configured.fs?.read ?? true) allowed.add('read');
  if (configured.fs?.write ?? true) allowed.add('write');
  if (configured.fs?.delete ?? false) allowed.add('delete');
  if (configured.net?.search ?? false) allowed.add('search');
  if (configured.net?.fetch ?? false) allowed.add('fetch');
  if (configured.exec?.terminal ?? false) allowed.add('terminal');
  if (configured.exec?.headless ?? false) allowed.add('headless');
  if (configured.git?.read ?? true) allowed.add('git-read');
  if (configured.git?.write ?? false) allowed.add('git-write');
  if (configured.agents?.delegate ?? false) allowed.add('delegate');
  // agents.cloud_workers is still accepted by the schema so existing configs
  // keep booting, but dispatch_workers no longer exists — it grants nothing
  // and is deliberately not resolved into a capability.
  return allowed;
}
