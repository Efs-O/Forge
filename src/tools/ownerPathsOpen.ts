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

/** Whether a ~/.forge target is one of the two owner-approved editable areas. */
export function isOpenForgeWriteTarget(target: string, set: OwnerOnlySet): boolean {
  const api = pathApiFor(set.platform);
  const forge = normalizePathForMatch(api.join(set.home, '.forge'), set.platform);
  if (!forge || !isWithin(target, forge)) return false;
  const memories = `${forge}/memories`;
  const skills = `${forge}/skills`;
  if (!isOpenTextPath(target, memories, skills)) return false;

  // Fixture paths model another OS and have no meaningful disk identity here.
  if (set.platform !== process.platform) return true;
  try {
    let real = realPathOfNearestAncestor(path.resolve(target));
    if (real.startsWith('\\\\?\\UNC\\')) real = `\\\\${real.slice(8)}`;
    else if (real.startsWith('\\\\?\\')) real = real.slice(4);
    const normalizedReal = normalizePathForMatch(real, set.platform);
    const realForge = realPathOfNearestAncestor(path.resolve(forge));
    const normalizedForge = normalizePathForMatch(realForge, set.platform);
    if (!normalizedReal || !normalizedForge || !isWithin(normalizedReal, normalizedForge))
      return false;
    return isOpenTextPath(
      normalizedReal,
      `${normalizedForge}/memories`,
      `${normalizedForge}/skills`,
    );
  } catch {
    return false;
  }
}

function isOpenTextPath(target: string, memories: string, skills: string): boolean {
  if (isWithin(target, skills) && target !== skills) return true;
  if (!isWithin(target, memories)) return false;
  const relative = target.slice(memories.length).replace(/^\//u, '');
  const segments = relative.split('/');
  return (
    segments.length === 2 && Boolean(segments[0]) && segments[1]!.toLowerCase().endsWith('.md')
  );
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}
