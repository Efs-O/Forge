import * as path from 'path';
import * as os from 'os';
import { realPathOfNearestAncestor } from '../util/realPath';
import { pathApiFor } from '../util/drivePath';
import { normalizePathForMatch } from './secretPaths';
import type { OwnerOnlySet } from './ownerPaths';

/** Built-in file-tool roots that the owner may edit without a config entry. */
export function openForgeFileRoots(home: string = os.homedir()): readonly string[] {
  return [path.join(home, '.forge', 'memories'), path.join(home, '.forge', 'skills')];
}

/** One line, in the owner's words, saying why a skill write is on a card. It goes
 *  on the card as its reason and into an unattended refusal unchanged, so the
 *  owner reads the same sentence on both surfaces. */
export const SKILL_WRITE_REASON =
  'This writes a Forge skill file under ~/.forge/skills. CLI agents later run skill scripts with full permissions, so every skill write needs your approval, also in Clanker mode.';

/** Which of the two open areas a target sits in, if either. */
type OpenForgeArea = 'memories' | 'skills';

/** Whether a ~/.forge target is one of the two owner-approved editable areas. */
export function isOpenForgeWriteTarget(target: string, set: OwnerOnlySet): boolean {
  return openForgeAreaOf(target, set) !== undefined;
}

/** Whether this target belongs to the skills area alone. Skills stay open to the
 *  file tools (the owner edits them without a config entry), but each write is
 *  asked for on a card in every mode: a skill's own scripts are later run by CLI
 *  agents with full permissions, so the owner is the only thing that should
 *  decide a skill changed. */
export function isForgeSkillsWriteTarget(target: string, set: OwnerOnlySet): boolean {
  return openForgeAreaOf(target, set) === 'skills';
}

/** The area test, run once on the supplied spelling and again on the real path. */
function openForgeAreaOf(target: string, set: OwnerOnlySet): OpenForgeArea | undefined {
  const api = pathApiFor(set.platform);
  const forge = normalizePathForMatch(api.join(set.home, '.forge'), set.platform);
  if (!forge || !isWithin(target, forge)) return undefined;
  const memories = `${forge}/memories`;
  const skills = `${forge}/skills`;
  const area = openTextAreaOf(target, memories, skills);
  if (area === undefined) return undefined;

  // Fixture paths model another OS and have no meaningful disk identity here.
  if (set.platform !== process.platform) return area;
  try {
    let real = realPathOfNearestAncestor(path.resolve(target));
    if (real.startsWith('\\\\?\\UNC\\')) real = `\\\\${real.slice(8)}`;
    else if (real.startsWith('\\\\?\\')) real = real.slice(4);
    const normalizedReal = normalizePathForMatch(real, set.platform);
    const realForge = realPathOfNearestAncestor(path.resolve(forge));
    const normalizedForge = normalizePathForMatch(realForge, set.platform);
    if (!normalizedReal || !normalizedForge || !isWithin(normalizedReal, normalizedForge))
      return undefined;
    return openTextAreaOf(
      normalizedReal,
      `${normalizedForge}/memories`,
      `${normalizedForge}/skills`,
    );
  } catch {
    return undefined;
  }
}

function openTextAreaOf(
  target: string,
  memories: string,
  skills: string,
): OpenForgeArea | undefined {
  if (isWithin(target, skills) && target !== skills) return 'skills';
  if (!isWithin(target, memories)) return undefined;
  const relative = target.slice(memories.length).replace(/^\//u, '');
  const segments = relative.split('/');
  const isMemoryFile =
    segments.length === 2 && Boolean(segments[0]) && segments[1]!.toLowerCase().endsWith('.md');
  return isMemoryFile ? 'memories' : undefined;
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}
