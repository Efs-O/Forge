import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';

/** Validate, back up, and atomically replace a Forge YAML config. */
export function writeConfigSafely(configPath: string, config: ForgeConfig): void {
  const validated = ForgeConfigSchema.parse(config) as ForgeConfig;
  const output = yaml.dump(validated, { lineWidth: 100, noRefs: true, sortKeys: false });
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.tmp`;
  const backupPath = `${configPath}.bak`;
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  try {
    fs.writeFileSync(temporaryPath, output, 'utf8');
    // Windows rename does not replace an existing file. The backup remains the
    // recovery point if the final replacement is interrupted.
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    fs.renameSync(temporaryPath, configPath);
  } catch (err) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw err;
  }
}
