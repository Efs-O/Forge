import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';

const CONFIG_FILENAME = 'config.yaml';

export function loadConfig(storagePath: string): ForgeConfig {
  const filePath = path.join(storagePath, CONFIG_FILENAME);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Forge: config.yaml not found at ${filePath}.\n` +
      `Copy config/config.example.yaml to that location and edit it.`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Forge: config.yaml validation failed:\n${issues}`);
  }

  return result.data as ForgeConfig;
}
