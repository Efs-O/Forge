import * as fs from 'fs';
import * as path from 'path';

export interface RipgrepResolution {
  command: string;
  argsPrefix?: readonly string[];
  candidates: readonly string[];
}

function vscodePlatformDirectory(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    return `win32-${arch}`;
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    return `linux-${arch}`;
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return `darwin-${arch}`;
  }
  return undefined;
}

export function resolveRipgrep(
  appRoot: string | undefined,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RipgrepResolution {
  const executable = platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates: string[] = [];
  if (appRoot) {
    const platformDirectory = vscodePlatformDirectory(platform, arch);
    for (const modulesDirectory of ['node_modules.asar.unpacked', 'node_modules']) {
      if (platformDirectory) {
        candidates.push(
          path.join(
            appRoot,
            modulesDirectory,
            '@vscode',
            'ripgrep-universal',
            'bin',
            platformDirectory,
            executable,
          ),
        );
      }
      candidates.push(
        path.join(appRoot, modulesDirectory, '@vscode', 'ripgrep', 'bin', executable),
      );
    }
    candidates.push(path.join(appRoot, 'node_modules', 'vscode-ripgrep', 'bin', executable));
  }

  return {
    command: candidates.find((candidate) => exists(candidate)) ?? 'rg',
    candidates,
  };
}

export function resolveRipgrepBinary(
  appRoot: string | undefined,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return resolveRipgrep(appRoot, exists, platform, arch).command;
}
