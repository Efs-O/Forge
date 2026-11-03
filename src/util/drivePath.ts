/**
 * The one place a Windows drive spelled the way a POSIX shell spells it becomes
 * the path the Windows API reads. Git Bash, Cygwin and MSYS write `N:\x` as
 * `/n/x` or `/cygdrive/n/x`; `path.win32` takes either as a folder under the
 * CURRENT drive's root, so the same file is one path to the secret matcher and
 * another to the workspace sandbox — measured: six refusals in one weekend, two
 * of them `read_file` reporting a file that exists as "nothing exists there".
 * On any other OS `/n/x` really is a folder, so this is a no-op there.
 *
 * This file imports nothing but `path`, on purpose. The secret matcher
 * (`tools/secretPaths.ts`) is consumed by `config/permissionsSchema.ts`,
 * `config/types.ts`, `tools/exfilTaint.ts`, `tools/ownerPaths.ts` and the
 * document converters, and those must not acquire a dependency on VS Code just
 * to fold a drive letter. `util/WorkspacePaths.ts` imports `vscode`, so the
 * fold cannot live there.
 */
import * as path from 'path';

/** Forward-slash input, Windows output: `/n/x` → `N:/x`, `/cygdrive/n/x` →
 *  `N:/x`. Anything that is not a one-letter drive prefix is returned as given,
 *  so `/tmp/build.out` and `/node_modules/x` stay folders. */
export function foldDrivePath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return value;
  const cygdrive = /^\/cygdrive\/([a-z])(?:\/|$)/iu.exec(value);
  if (cygdrive?.[1]) return `${cygdrive[1].toUpperCase()}:/${value.slice(12)}`;
  const drive = /^\/([a-z])(?:\/|$)/iu.exec(value);
  if (drive?.[1]) return `${drive[1].toUpperCase()}:/${value.slice(3)}`;
  return value;
}

/** Is this already a Windows-shaped absolute path (`X:/…` or `X:\…`)? Kept
 *  beside the fold because the two questions are asked together and answered by
 *  the same OS check. */
export function isWindowsAbsolute(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[a-z]:[\\/]/iu.test(value);
}

/** The path API of the OS being judged, so a Windows-shaped path on a Linux
 *  runner is judged the way Windows judged it. */
export function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}
