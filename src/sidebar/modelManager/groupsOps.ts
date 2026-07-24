import * as YAML from 'yaml';
import { updateConfigFile } from '../../config/ConfigWriter';

/**
 * Groups ("boards") editor write path for the Model Manager toolbar (F7/§2.3
 * "Groups editor"). Thin wrapper over the top-level `groups:` map using the
 * same comment-preserving Document API as every other write here. See
 * docs/OWNERS.md.
 */

function ensureGroupsMap(doc: YAML.Document): YAML.YAMLMap {
  const existing = doc.get('groups', true);
  if (existing && YAML.isMap(existing)) return existing;
  const map = doc.createNode({}) as YAML.YAMLMap;
  doc.set('groups', map);
  return map;
}

/** Create a new, empty group. No-op if it already exists (idempotent add). */
export function addGroup(configPath: string, groupName: string): void {
  updateConfigFile(configPath, (doc) => {
    const groups = ensureGroupsMap(doc);
    if (!groups.has(groupName)) groups.set(groupName, doc.createNode({}));
  });
}

/** Set (or delete, when `value` is `undefined`) one field on a group. Throws
 *  if the group does not exist. */
export function setGroupField(
  configPath: string,
  groupName: string,
  field: string,
  value: unknown,
): void {
  updateConfigFile(configPath, (doc) => {
    const groups = doc.get('groups', true);
    const group = groups && YAML.isMap(groups) ? groups.get(groupName, true) : undefined;
    if (!group || !YAML.isMap(group)) {
      throw new Error(`Forge: group "${groupName}" not found in config`);
    }
    if (value === undefined) group.delete(field);
    else group.set(field, value);
  });
}

/** Remove a group entirely. Any model still referencing it will fail the next
 *  config load's group-reference validation (ConfigLoader) — surfaced to the
 *  user as a normal reload error, same as a hand-edit mistake. */
export function removeGroup(configPath: string, groupName: string): void {
  updateConfigFile(configPath, (doc) => {
    const groups = doc.get('groups', true);
    if (groups && YAML.isMap(groups)) groups.delete(groupName);
  });
}
