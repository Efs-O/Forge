import * as fs from 'fs';
import * as path from 'path';

export function resolveRipgrepBinary(
  appRoot: string | undefined,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = platform === 'win32' ? 'rg.exe' : 'rg';
  if (appRoot) {
    const candidates = [
      path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', executable),
      path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', executable),
      path.join(appRoot, 'node_modules', 'vscode-ripgrep', 'bin', executable),
    ];
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
  }
  return 'rg';
}
