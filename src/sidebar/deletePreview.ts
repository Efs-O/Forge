import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { describeGitLineForDelete } from '../tools/gitTrackedStatus';

const DELETE_PREVIEW_LIMIT = 8;
const DELETE_SCAN_LIMIT = 2_000;

interface DeleteInventory {
  files: number;
  directories: number;
  bytes: number;
  preview: string[];
  truncated: boolean;
}

/**
 * Build an approval message from the filesystem state before a destructive
 * action. The scan is deliberately bounded: confirmation must stay responsive
 * even when a model targets a very large generated directory.
 */
export async function describeDelete(args: Record<string, unknown>): Promise<string> {
  const requestedPath = typeof args['path'] === 'string' ? args['path'] : '(invalid path)';
  const recursive = args['recursive'] === true;
  const toTrash = args['to_trash'] !== false;
  const lines = [
    toTrash ? 'About to move to the recycle bin:' : 'About to permanently delete:',
    `Target: ${requestedPath}`,
  ];

  try {
    const target = resolveWorkspacePath(requestedPath);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const kind = stat.isSymbolicLink() ? 'symbolic link' : 'file';
      lines.push(`Type: ${kind} (${stat.size.toLocaleString()} bytes)`);
      lines.push('Scope: this item only.');
    } else {
      const inventory = inspectDeleteDirectory(target);
      lines.push('Type: directory');
      lines.push(
        recursive
          ? 'Scope: recursive — this directory and every nested item will be deleted.'
          : 'Scope: this directory only — deletion will fail if it is not empty.',
      );
      lines.push(
        `Current contents: ${inventory.files.toLocaleString()} files, ` +
          `${inventory.directories.toLocaleString()} folders, ` +
          `${inventory.bytes.toLocaleString()} bytes${inventory.truncated ? ' (scan capped)' : ''}.`,
      );
      if (inventory.preview.length > 0) {
        lines.push(
          `First items: ${inventory.preview.join(', ')}${inventory.truncated ? ', …' : ''}`,
        );
      }
    }
  } catch (err) {
    lines.push('Status: Forge could not inspect this target before deletion.');
    lines.push(`Inspection error: ${(err as Error).message}`);
    lines.push(
      recursive
        ? 'Scope requested: recursive — all contents would be deleted if the target is accessible.'
        : 'Scope requested: this item only.',
    );
  }

  // The one fact the dialog used to withhold. A user approving the deletion of
  // a committed file is making a different decision from one approving a
  // generated artifact, and until now both looked identical here.
  lines.push(`Git: ${await describeGitLineForDelete(requestedPath)}`);

  lines.push(
    toTrash
      ? "Recoverable from the recycle bin. Forge will also create this turn's Undo " +
          'checkpoint immediately before deletion.'
      : "Not recoverable from the recycle bin. Forge will create this turn's Undo " +
          'checkpoint immediately before deletion.',
  );
  return lines.join('\n');
}

function inspectDeleteDirectory(root: string): DeleteInventory {
  const inventory: DeleteInventory = {
    files: 0,
    directories: 0,
    bytes: 0,
    preview: [],
    truncated: false,
  };
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  let inspected = 0;

  while (pending.length > 0 && !inventory.truncated) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      inspected++;
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      if (inventory.preview.length < DELETE_PREVIEW_LIMIT) {
        inventory.preview.push(entry.isDirectory() ? `${relative}${path.sep}` : relative);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        inventory.directories++;
        pending.push({ absolute: path.join(current.absolute, entry.name), relative });
      } else {
        inventory.files++;
        try {
          inventory.bytes += fs.lstatSync(path.join(current.absolute, entry.name)).size;
        } catch {
          // The delete itself will report an inaccessible entry. Keep the
          // confirmation useful for everything that was inspectable.
        }
      }
      if (inspected >= DELETE_SCAN_LIMIT) {
        inventory.truncated = true;
        break;
      }
    }
  }
  return inventory;
}
