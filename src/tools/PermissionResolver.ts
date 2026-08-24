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

/**
 * Capabilities that are deny-by-default, paired with the key that grants them.
 * `fs.read`, `fs.write` and `git.read` default to true and so can never go
 * dark by omission — they are absent here on purpose.
 */
const DENY_BY_DEFAULT: readonly (readonly [
  string,
  (p: NonNullable<ForgeConfig['permissions']>) => boolean | undefined,
])[] = [
  ['fs.delete', (p) => p.fs?.delete],
  ['exec.terminal', (p) => p.exec?.terminal],
  ['exec.headless', (p) => p.exec?.headless],
  ['net.search', (p) => p.net?.search],
  ['net.fetch', (p) => p.net?.fetch],
  ['git.write', (p) => p.git?.write],
];

/**
 * Capabilities that are off because nobody said anything, NOT because someone
 * chose to deny them. The permissions block is all-or-nothing: naming any one
 * group makes the schema defaults authoritative for EVERY group, so adding
 * `fs.delete` to grant one tool silently revoked `web_search`, and `net.fetch`
 * stayed off because nobody knew to set it. Both cost real turns before anyone
 * worked out why a tool had vanished.
 *
 * An explicit `false` is a decision and is never reported — the shipped
 * example config denies most of these on purpose, and warning about a
 * deliberate choice would train people to ignore the message. Returns config
 * keys so the warning can name the fix rather than the symptom.
 */
export function permissionsSuppressedByBlock(config: ForgeConfig): string[] {
  const configured = config.permissions;
  if (!configured) return [];
  return DENY_BY_DEFAULT.filter(([, read]) => read(configured) === undefined).map(([key]) => key);
}
