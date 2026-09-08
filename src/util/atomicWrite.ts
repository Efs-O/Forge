import * as fs from 'fs';
import * as path from 'path';

let sequence = 0;

/** Replace one regular file without exposing a truncate-then-write window. */
export function writeFileAtomicSync(target: string, content: string | Buffer): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.forge-${process.pid}-${sequence++}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write error; cleanup failure is non-destructive.
    }
    throw error;
  }
}
