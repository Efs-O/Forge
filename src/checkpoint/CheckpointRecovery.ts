import * as fs from 'fs';
import { getLogger } from '../util/logger';

const log = getLogger();

export function reportExistingCheckpointRecoveryData(storageRoot: string): void {
  void fs.promises
    .readdir(storageRoot, { withFileTypes: true })
    .then((entries) => {
      const recoverable = entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('turn-'),
      );
      if (recoverable.length > 0) {
        log.warn(
          `[Checkpoint] found ${recoverable.length} existing recovery checkpoint director${recoverable.length === 1 ? 'y' : 'ies'} under ${storageRoot}`,
        );
      }
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        log.warn(`[Checkpoint] could not inspect recovery storage: ${err.message}`);
      }
    });
}
