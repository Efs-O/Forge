import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { workspaceIdFor } from '../../src/remote/RemoteWorkspaceHandoff';

describe('workspaceIdFor', () => {
  it.runIf(process.platform === 'win32')(
    'treats Windows path casing as one workspace identity',
    () => {
      const actual = realpathSync.native(process.cwd());
      const alternateCase = actual
        .split('')
        .map((char) => (char >= 'a' && char <= 'z' ? char.toUpperCase() : char.toLowerCase()))
        .join('');
      expect(workspaceIdFor(actual)).toBe(workspaceIdFor(alternateCase));
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves the existing VS Code lowercase-drive workspace identity',
    () => {
      const actual = realpathSync.native(process.cwd()).replace(
        /^([A-Z]):/,
        (_, drive: string) => `${drive.toLowerCase()}:`,
      );
      const legacyId = createHash('sha256').update(actual).digest('hex');
      expect(workspaceIdFor(actual)).toBe(legacyId);
    },
  );

  it.runIf(process.platform !== 'win32')('preserves POSIX path casing in the identity', () => {
    expect(workspaceIdFor('/workspace/Forge')).not.toBe(workspaceIdFor('/workspace/forge'));
  });
});
